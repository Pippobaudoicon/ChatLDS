"""Deterministic scoring of <outdir>/runs-<scope>.json (no API calls) -> <outdir>/scores.json.

Retrieval: is the gold source among the sources the model saw (and at what rank)?
Answer:    citation markers, scripture references (valid? grounded in a retrieved chunk? does the [N]
           next to it point at a chunk that contains that verse?), quotations (verbatim in a retrieved chunk?
           only meaningful when the answer language equals the source language).
Usage: python3 scripts/eval/review/score.py scripts/eval/review/out/<label>
"""
import json, re, sys, unicodedata
from collections import defaultdict
from pathlib import Path
from common import CHUNKS_BY_CH, EVAL, MAXV, NAME2SLUG, SLUG_ENG, covers, gold_hit, norm, parse_ref

names = sorted(NAME2SLUG, key=len, reverse=True)
BOOK_RE = re.compile(r"(?<![A-Za-z])(" + "|".join(re.escape(n).replace(r"\ ", r"[\s.]+") for n in names) +
                     r")\.?\s+(\d{1,3}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?", re.I)
QUOTE_RE = re.compile(r"[“«]([^”»\[\]\n]{25,400})[”»]|\"([^\"\[\]\n]{25,400})\"")


def ascii_answer(text):
    text = re.sub(r"[–—]", "-", text)  # keep verse ranges (33–44) intact
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def find_refs(text):
    out = []
    for m in BOOK_RE.finditer(ascii_answer(text)):
        slug = NAME2SLUG.get(norm(m.group(1)))
        if slug:
            out.append((slug, int(m.group(2)), int(m.group(3)), m.end()))
    return out


def lists_ref(s, slug, ch, v):
    """Is slug ch:v one of the cross-references the cited chunk itself lists (its `references` metadata or per-verse `notes`)?
    Answers like "the study of Ether 12:1-7 also lists Alma 32:21 [1]" are grounded, not a mismatch."""
    seen = s.get("seen") or {}
    notes = [r for rs in (seen.get("notes") or {}).values() for r in rs]  # per-verse notes (step 2)
    for ref in (seen.get("references") or []) + notes:
        try:
            sl, c, vv = parse_ref(ref)
        except Exception:
            continue
        if (sl, c) == (slug, ch) and vv in (None, v):
            return True
    return False


def score_run(r):
    q = EVAL[r["id"]]
    g = q["gold"]
    srcs = r["sources"]
    res = {"id": r["id"], "cat": q["cat"], "lang": q["lang"], "expect": q["expect"], "nsrc": len(srcs),
           "tools": [t["tool"] for t in r["toolInputs"]], "costUsd": r["costUsd"], "totalMs": r["totalMs"],
           "firstAnswerMs": r["firstAnswerMs"], "inputTokens": r["inputTokens"], "error": r.get("error")}
    # retrieval (not_found traps and questions without gold have no hit)
    if q["expect"] == "not_found" or not g:
        res["gold_rank"], res["hit"] = None, None
    elif "chapter" in g:
        slug, ch, _ = parse_ref(g["chapter"])
        want = CHUNKS_BY_CH[(q["lang"], slug, ch)]
        got = {s["id"] for s in srcs}
        res["gold_rank"] = next((s["n"] for s in srcs if s["id"] in want), None)
        res["chapter_completeness"] = round(len(want & got) / len(want), 3) if want else None
        res["hit"] = res["chapter_completeness"] == 1.0
    else:
        ranks = [s["n"] for s in srcs if gold_hit(s, g)]
        res["gold_rank"] = ranks[0] if ranks else None
        res["hit"] = bool(ranks)
        if "talkcites" in g:
            res["talks_citing_found"] = len({s["id"].rsplit(":", 2)[0] for s in srcs if gold_hit(s, g)})
    # answer: citations
    ans = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", r["answer"] or "")  # drop markdown link targets
    cites = [int(x) for x in re.findall(r"\[(\d+)\]", ans)]
    res["citations"] = len(set(cites))
    res["oor_citations"] = sorted({c for c in cites if c < 1 or c > len(srcs)})
    res["cited_sources"] = sorted(set(cites))
    # answer: scripture references
    bad, ungrounded, cite_mismatch, cite_checked = [], [], [], 0
    refs = find_refs(ans)
    for slug, ch, v, end in refs:
        label = f"{SLUG_ENG[slug]} {ch}:{v}"
        if MAXV.get((slug, ch), 0) < v:
            bad.append(label)
        if not any(covers(s, slug, ch, v) for s in srcs):
            ungrounded.append(label)
        m = re.match(r"[^\[\n]{0,80}?\[(\d+)\]", ascii_answer(ans)[end:])
        if m and 1 <= int(m.group(1)) <= len(srcs):
            cite_checked += 1
            s = srcs[int(m.group(1)) - 1]
            if s["source"] == "scriptures" and not covers(s, slug, ch, v) and not lists_ref(s, slug, ch, v):
                cite_mismatch.append(f"{label} -> [{m.group(1)}] {s['id']}")
    res.update(refs_in_answer=len(refs), invalid_refs=bad, ungrounded_refs=ungrounded,
               ref_cite_checked=cite_checked, ref_cite_mismatch=cite_mismatch)
    # answer: quotations (verbatim only comparable when answer and source language match)
    alltext = " ".join(norm(s.get("text")) for s in srcs)
    quotes = [m.group(1) or m.group(2) for m in QUOTE_RE.finditer(ans)]
    res["quotes"] = len(quotes)
    res["quotes_verbatim"] = sum(1 for qt in quotes if norm(qt) and norm(qt) in alltext)
    return res


if __name__ == "__main__":
    outdir = Path(sys.argv[1])
    allout = {}
    for f in sorted(outdir.glob("runs-*.json")):
        d = json.load(open(f))
        allout[d["scope"]] = {"model": d["model"], "flags": d["flags"], "rows": [score_run(r) for r in d["runs"]]}
        print(f"scored {f.name}: {len(d['runs'])} runs")
    json.dump(allout, open(outdir / "scores.json", "w"), indent=1, ensure_ascii=False)
