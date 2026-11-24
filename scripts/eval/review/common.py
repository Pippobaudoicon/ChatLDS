"""Shared helpers for the review eval: eval set, book table, gold matching.

Paths (override with env):
  LDS_SCRAPER  sibling checkout holding the local chunk files (default: ../lds-scraper from the repo root)
"""
import json, os, re, sys, unicodedata
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parents[2]
SCRAPER = Path(os.environ.get("LDS_SCRAPER", ROOT.parent / "lds-scraper"))
CHUNKS = SCRAPER / "data" / "chunks"
sys.path.insert(0, str(SCRAPER))
from scraper.sources.scripture_catalog import CATALOG  # noqa: E402  (read-only import of the book table)

EVAL = {q["id"]: q for q in json.load(open(HERE / "eval_set.json"))}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[‘’“”\"'«»]", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# ---- book names -> slug (eng + ita + a few abbreviations) -------------------
NAME2SLUG = {}
for b in CATALOG:
    NAME2SLUG[norm(b.eng)] = b.slug
    NAME2SLUG[norm(b.ita)] = b.slug
for k, v in {"d c": "dc", "dea": "dc", "d&c": "dc", "1 ne": "1-ne", "2 ne": "2-ne", "3 ne": "3-ne", "4 ne": "4-ne",
             "moro": "moro", "hel": "hel", "morm": "morm", "matt": "matt", "heb": "heb", "rom": "rom",
             "1 cor": "1-cor", "2 cor": "2-cor", "abr": "abr", "jst": None}.items():
    if v:
        NAME2SLUG[k] = v
NAME2SLUG[norm("Abraamo")] = "abr"  # spelling the model uses in Italian answers
SLUG_ENG = {b.slug: b.eng for b in CATALOG}


def parse_ref(ref):  # "Mosiah 3:19" / "Doctrine and Covenants 76:50" / "Jacob 5"
    m = re.match(r"(.+?)\s+(\d+)(?::(\d+))?$", ref)
    return NAME2SLUG[norm(m.group(1))], int(m.group(2)), int(m.group(3)) if m.group(3) else None


def covers(src, slug, ch, v):
    """Does this scripture chunk (dict with id/source) contain slug ch:v (v=None -> any verse)?"""
    if src["source"] != "scriptures":
        return False
    p = src["id"].split(":")
    if p[2] != slug or int(p[3]) != ch:
        return False
    if v is None:
        return True
    a, *b = p[4].split("-")
    return int(a) <= v <= (int(b[0]) if b else int(a))


def _cached(src, key, field):
    k = "_n_" + key
    if k not in src:
        src[k] = norm(src.get(field))
    return src[k]


def gold_hit(src, g):
    """All gold keys that are present must match (see eval_set.json)."""
    checks = []
    if "refs" in g:
        checks.append(any(covers(src, *parse_ref(r)) for r in g["refs"]))
    if "talk" in g:
        t = g["talk"]
        checks.append(src["source"] == "conference" and norm(t["speaker"]) in _cached(src, "sp", "speaker")
                      and norm(t["title"]) in _cached(src, "ti", "title"))
    if "idprefix" in g:
        checks.append(any(src["id"].startswith(p) for p in g["idprefix"]))
    if "content" in g:
        checks.append(any(norm(c) in _cached(src, "tx", "text") for c in g["content"]))
    if "source" in g:
        checks.append(src["source"] in g["source"])
    if "title" in g:
        checks.append(any(norm(c) in _cached(src, "ti", "title") for c in g["title"]))
    if "speaker" in g and "talk" not in g and "idprefix" not in g:
        checks.append(any(norm(c) in _cached(src, "sp", "speaker") for c in g["speaker"]))
    if "talkcites" in g:
        checks.append(src["source"] == "conference" and g["talkcites"] in (src.get("references") or []))
    return bool(checks) and all(checks)


# scripture verse index (for validating references in answers): max verse per chapter and chunk ids per chapter
MAXV = defaultdict(int)
CHUNKS_BY_CH = defaultdict(set)


def _index_scriptures():
    for lang in ("eng", "ita"):
        for r in load_chunks("scriptures", (lang,)):
            slug = r["id"].split(":")[2]
            a, *b = r["verse"].split("-")
            MAXV[(slug, r["chapter"])] = max(MAXV[(slug, r["chapter"])], int(b[0]) if b else int(a))
            CHUNKS_BY_CH[(lang, slug, r["chapter"])].add(r["id"])


def load_chunks(namespace, langs=("eng",)):
    """Local chunk files, same data as Pinecone."""
    for lang in langs:
        for line in open(CHUNKS / namespace / lang / f"{namespace}_{lang}.jsonl"):
            yield json.loads(line)


if os.environ.get("EVAL_NO_INDEX") != "1":
    _index_scriptures()
