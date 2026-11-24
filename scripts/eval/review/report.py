"""Aggregate scores.json + judge-*.json of one or two runs into the review tables (markdown).
Usage: python3 scripts/eval/review/report.py scripts/eval/review/out/<label> [scripts/eval/review/out/<label2>]
One dir: metrics per scope x language. Two dirs: before (first) / after (second) side by side.
"""
import json, sys
from pathlib import Path


def pct(num, den):
    return f"{100 * num / den:.0f}% ({num}/{den})" if den else "n/a"


def q(xs, p):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def secs(ms):
    return f"{ms / 1000:.1f}s" if ms is not None else "n/a"


def metrics(rows, judges):
    J = {j["id"]: j for j in judges if "error" not in j}
    jr = [J[r["id"]] for r in rows if r["id"] in J]
    ret = [r for r in rows if r["hit"] is not None]
    ct = sum(j["claims_total"] for j in jr)
    cs = sum(j["claims_supported"] for j in jr)
    return {
        "n": len(rows),
        "gold in context": pct(sum(r["hit"] for r in ret), len(ret)),
        "gold in top 5": pct(sum(1 for r in ret if r["gold_rank"] and r["gold_rank"] <= 5), len(ret)),
        "claims supported": pct(cs, ct),
        "wrong references (judge)": pct(sum(j["wrong_reference"] for j in jr), len(jr)),
        "[N] swapped (judge)": pct(sum(j["swapped_citation"] for j in jr), len(jr)),
        "[N] out of range": str(sum(len(r["oor_citations"]) for r in rows)),
        "ref->[N] mismatch (det.)": f'{sum(len(r["ref_cite_mismatch"]) for r in rows)}/{sum(r["ref_cite_checked"] for r in rows)}',
        "expected behavior met": pct(sum(j["expected_behavior_met"] for j in jr), len(jr)),
        "verdict correct": pct(sum(j["verdict"] == "correct" for j in jr), len(jr)),
        "translation faithful / answer lang ok": f'{sum(j["translation_faithful"] for j in jr)}/{len(jr)} / {sum(j["answer_language_ok"] for j in jr)}/{len(jr)}',
        "judge failures": str(len(rows) - len(jr)),
        "cost/turn mean (p50 / p90)": f'${sum(r["costUsd"] for r in rows) / len(rows):.4f} (${q([r["costUsd"] for r in rows], .5):.4f} / ${q([r["costUsd"] for r in rows], .9):.4f})',
        "cost total": f'${sum(r["costUsd"] for r in rows):.3f}',
        "input tokens p50 / mean": f'{q([r["inputTokens"] for r in rows], .5)} / {sum(r["inputTokens"] for r in rows) // len(rows)}',
        "first answer p50 / p90": f'{secs(q([r["firstAnswerMs"] for r in rows], .5))} / {secs(q([r["firstAnswerMs"] for r in rows], .9))}',
        "turn p50 / p90": f'{secs(q([r["totalMs"] for r in rows], .5))} / {secs(q([r["totalMs"] for r in rows], .9))}',
        "errors": str(sum(1 for r in rows if r["error"])),
    }


def load(d):
    d = Path(d)
    scores = json.load(open(d / "scores.json"))
    out = {}
    for scope, s in scores.items():
        jf = d / f"judge-{scope}.json"
        judges = json.load(open(jf)) if jf.exists() else []
        for lang in ("ita", "eng", "all"):
            rows = [r for r in s["rows"] if lang == "all" or r["lang"] == lang]
            if rows:
                out[(scope, lang)] = metrics(rows, judges)
    return out


def table(A, B=None, la="before", lb="after"):
    keys = list(next(iter(A.values())).keys())
    lines = []
    for scope in ("standard", "super"):
        cols = [(scope, lang) for lang in ("ita", "eng", "all") if (scope, lang) in A]
        if not cols:
            continue
        lines.append(f"\n### {scope.capitalize()}\n")
        if B is None:
            lines += ["| metric | " + " | ".join(c[1] for c in cols) + " |", "|---|" + "---|" * len(cols)]
            for k in keys:
                lines.append(f"| {k} | " + " | ".join(A[c][k] for c in cols) + " |")
        else:
            head = " | ".join(f"{c[1]} {la} | {c[1]} {lb}" for c in cols)
            lines += [f"| metric | {head} |", "|---|" + "---|---|" * len(cols)]
            for k in keys:
                lines.append(f"| {k} | " + " | ".join(f"{A[c][k]} | {B[c][k] if c in B else 'n/a'}" for c in cols) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    A = load(sys.argv[1])
    B = load(sys.argv[2]) if len(sys.argv) > 2 else None
    md = table(A, B, Path(sys.argv[1]).name, Path(sys.argv[2]).name if B else "")
    print(md)
    open(Path(sys.argv[-1]) / "report.md", "w").write(md + "\n")
