"""Check eval_set.json against the LOCAL chunk files (no API calls): ids unique, every gold
matches at least one chunk, every "anchors" string is present in the gold chunks, not_found traps match nothing.
Usage: python3 scripts/eval/review/validate_set.py
"""
import os, re, sys
os.environ.setdefault("EVAL_NO_INDEX", "1")  # no need for the scripture verse index here
from collections import Counter
from common import EVAL, gold_hit, load_chunks, norm, parse_ref

NAMESPACES = ["conference", "handbook", "gospel_topics", "study_helps", "gospel_study", "gospel_teachings",
              "gospel_history", "gospel_other", "gospel_selfreliance", "gospel_youth"]
corpus = [c for ns in NAMESPACES for c in load_chunks(ns)] + [c for lang in ("eng", "ita") for c in load_chunks("scriptures", (lang,))]
STD = {"scriptures", "conference", "handbook", "study_helps", "gospel_topics"}  # ALL_SOURCES (types.ts)

bad = []
for q in EVAL.values():
    g, hits = q["gold"], []
    if "chapter" in g:  # chapter golds are scored by chunk-id completeness: just check the chapter exists
        slug, ch, _ = parse_ref(g["chapter"])
        if not any(c["source"] == "scriptures" and c["id"].split(":")[2] == slug and c["chapter"] == ch for c in corpus):
            bad.append(f"{q['id']}: chapter {g['chapter']} not found")
        continue
    if g:
        hits = [c for c in corpus if gold_hit(c, g)]
    if q["expect"] == "not_found":
        if hits:
            bad.append(f"{q['id']}: not_found trap matches {len(hits)} chunks")
        continue
    if g and not hits:
        bad.append(f"{q['id']}: gold matches no chunk")
        continue
    text = norm(" ".join(c["text"] for c in hits))
    for a in q.get("anchors", []):
        if norm(a) not in text:
            bad.append(f"{q['id']}: anchor not in gold chunks: {a!r}")
    in_std = any(c["source"] in STD for c in hits) if hits else True
    if q.get("requires_super") and in_std:
        bad.append(f"{q['id']}: marked requires_super but gold exists in a Standard namespace")
    if not q.get("requires_super") and hits and not in_std:
        bad.append(f"{q['id']}: gold only in Super namespaces but not marked requires_super")
n = Counter(q["lang"] for q in EVAL.values())
print(f"{len(EVAL)} questions, ita={n['ita']} ({100*n['ita']/len(EVAL):.0f}%), eng={n['eng']}; requires_super={sum(1 for q in EVAL.values() if q.get('requires_super'))}")
print("\n".join(bad) or "OK: all gold/anchors verified against local chunks")
sys.exit(1 if bad else 0)
