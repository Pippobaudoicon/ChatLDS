"""LLM judge (claim level) for <outdir>/runs-<scope>.json -> <outdir>/judge-<scope>.json.

The judge is a headless subscription CLI, never a paid API key:
  JUDGE=codex (default)  codex exec --model gpt-6-luna
  JUDGE=muse             muse exec --model muse-spark-1.3
If the chosen CLI keeps failing, the other one is used as a fallback. Malformed JSON is re-asked (up to 3 tries per CLI).
The judge sees exactly what the assistant saw (toToolChunk text, incl. the sources' `references` metadata).
Usage: python3 scripts/eval/review/judge.py scripts/eval/review/out/<label> [scope ...]
"""
import json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from common import EVAL

CLIS = {
    "codex": lambda prompt_file, out_file: ["codex", "exec", "--model", os.environ.get("JUDGE_CODEX_MODEL", "gpt-6-luna"),
                                            "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                                            "--ignore-user-config", "-o", out_file, "-"],
    "muse": lambda prompt_file, out_file: ["muse", "exec", "--model", os.environ.get("JUDGE_MUSE_MODEL", "muse-spark-1.3"),
                                           "--prompt-file", prompt_file],
}

SYSTEM = """You are a strict fact-checker for a Latter-day Saint study assistant that must ground every claim in cited sources.
You get: the question, the expected behavior, reference facts written by an expert (ground truth for doctrine, attribution and references),
the numbered sources the assistant retrieved (for the ones it cited: exactly the text the assistant saw, plus the `references` metadata of the source = the scripture references that source itself cites; use them for cross-reference questions), and the assistant's answer.
Important: the question and the answer may be in Italian while most sources are in English. The assistant must answer in the user's language, so translated quotations are NOT verbatim: judge them for fidelity to the meaning of the English source, and do not penalise translation itself. Scripture sources may be Italian.
Evaluate the ANSWER. Be precise and conservative. Reply with ONE JSON object only, no prose, no markdown fence, with exactly these keys:
{
 "claims_total": int,            // substantive factual/doctrinal claims in the answer (ignore the preamble/politeness)
 "claims_supported": int,        // claims whose attached [N] source(s) actually state/support them
 "claims_uncited_or_unsupported": int, // claims with no [N], or whose [N] does not support them
 "unsupported_examples": [str],  // up to 3 short examples
 "wrong_reference": bool,        // a scripture/talk reference (book, chapter, verse, title, date) stated wrongly or pointing to a passage that doesn't say that
 "wrong_reference_detail": str,
 "swapped_citation": bool,       // a claim carries a [N] that belongs to a different numbered source (e.g. speaker/talk of [3] cited as [1])
 "swapped_citation_detail": str,
 "misattribution": bool,         // a quote/teaching attributed to the wrong person or talk (e.g. quoted author confused with the quoting speaker)
 "misattribution_detail": str,
 "translation_faithful": bool,   // when the answer language differs from the source language: translated claims/quotes match the source meaning. true if no translation is involved
 "answer_language_ok": bool,     // the answer is written in the same language as the Question (see "Question language")
 "factual_or_doctrinal_error": bool, // contradicts the reference facts or Church teaching
 "error_detail": str,
 "non_official_presented_as_doctrine": bool, // speculation, disavowed/superseded teaching or folklore presented as official doctrine
 "expected_behavior_met": bool,  // see expected behavior (answer / not_found = must say the item was not found and not invent it / no_official_position = must say there is no official position, without inventing one)
 "answers_question": int,        // 0 = no, 1 = partially, 2 = fully
 "verdict": "correct" | "partially_correct" | "incorrect",
 "note": str                     // one sentence
}"""

INT = ["claims_total", "claims_supported", "claims_uncited_or_unsupported", "answers_question"]
BOOL = ["wrong_reference", "swapped_citation", "misattribution", "translation_faithful", "answer_language_ok",
        "factual_or_doctrinal_error", "non_official_presented_as_doctrine", "expected_behavior_met"]


def valid(d):
    if not isinstance(d, dict):
        return "not an object"
    for k in INT:
        if not isinstance(d.get(k), int) or isinstance(d.get(k), bool):
            return f"{k} must be int"
    for k in BOOL:
        if not isinstance(d.get(k), bool):
            return f"{k} must be bool"
    if d.get("verdict") not in ("correct", "partially_correct", "incorrect"):
        return "verdict invalid"
    if not isinstance(d.get("unsupported_examples", []), list):
        return "unsupported_examples must be list"
    if d["claims_supported"] > d["claims_total"]:
        return "claims_supported > claims_total"
    return None


def sources_block(run):
    cited = {int(x) for x in re.findall(r"\[(\d+)\]", run["answer"] or "")}
    out = []
    for s in run["sources"]:
        ref = f'{s.get("book") or ""} {s.get("chapter") or ""}:{s.get("verse") or ""}' if s.get("book") else ""
        head = f'[{s["n"]}] {s["source"]} | {s.get("title") or ""} | {s.get("speaker") or ""} | {s.get("date") or ""} | {ref} | {s["id"]}'
        if s["n"] not in cited:
            out.append(head + " (not cited)")
            continue
        seen = s.get("seen") or {"text": s.get("text") or "", "references": s.get("references")}
        refs = f'\nreferences: {"; ".join(seen["references"])}' if seen.get("references") else ""
        out.append(f'{head}{refs}\n{seen["text"]}')
    return "\n\n".join(out) or "(no sources)"


def run_cli(cli, prompt):
    with tempfile.TemporaryDirectory() as td:
        pf, of = os.path.join(td, "prompt.txt"), os.path.join(td, "out.txt")
        open(pf, "w").write(prompt)
        stdin = open(pf) if cli == "codex" else subprocess.DEVNULL
        p = subprocess.run(CLIS[cli](pf, of), stdin=stdin, capture_output=True, text=True, timeout=600, cwd=td)
        txt = open(of).read() if cli == "codex" and os.path.exists(of) else p.stdout
        if p.returncode != 0 and not txt.strip():
            raise RuntimeError(f"{cli} exit {p.returncode}: {p.stderr[-300:]}")
        return txt


def extract_json(txt):
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0)) if m else None


def call(prompt, first):
    last = ""
    for cli in [first] + [c for c in CLIS if c != first]:
        p = prompt
        for attempt in range(3):
            try:
                d = extract_json(run_cli(cli, p))
                err = valid(d) if d is not None else "no JSON object found"
            except Exception as e:  # noqa: BLE001
                d, err = None, f"{type(e).__name__}: {e}"
            if err is None:
                return d, cli, attempt
            last = f"{cli}: {err}"
            p = prompt + f"\n\nYour previous reply was rejected ({err}). Reply again with ONE valid JSON object with exactly the requested keys and types."
    return {"error": last}, first, 3


def judge(run, first):
    q = EVAL[run["id"]]
    prompt = (SYSTEM + f"\n\nQuestion language: {'Italian' if q['lang'] == 'ita' else 'English'}\nQuestion: {q['q']}\n\nExpected behavior: {q['expect']}\nReference facts: {q['facts']}\n\n"
              f"=== Sources ===\n{sources_block(run)}\n\n=== Answer ===\n{run['answer'] or '(empty)'}")
    res, cli, retries = call(prompt, first)
    res.update(id=run["id"], cat=q["cat"], lang=q["lang"], expect=q["expect"], judge=cli, retries=retries)
    print(run["id"], res.get("verdict", "ERROR"), f"[{cli} r{retries}]", (res.get("note") or res.get("error", ""))[:120], flush=True)
    return res


if __name__ == "__main__":
    outdir = Path(sys.argv[1])
    scopes = sys.argv[2:] or ["standard", "super"]
    first = os.environ.get("JUDGE", "codex")
    for scope in scopes:
        f = outdir / f"runs-{scope}.json"
        if not f.exists():
            continue
        runs = json.load(open(f))["runs"]
        with ThreadPoolExecutor(int(os.environ.get("JUDGE_PARALLEL", "4"))) as ex:
            out = list(ex.map(lambda r: judge(r, first), runs))
        json.dump(out, open(outdir / f"judge-{scope}.json", "w"), indent=1, ensure_ascii=False)
        print(f"{scope}: judged {len(out)}, failed {sum('error' in o for o in out)}")
