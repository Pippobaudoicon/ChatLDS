/**
 * Deterministic probe of scripture-by-reference retrieval (no LLM, ~$0: only query embeddings).
 * Calls retrieve() exactly as lookup_scripture_passage does and checks, against the local lds-scraper chunk
 * files (same data as Pinecone): chapter refs -> fraction of the chapter's chunks returned; verse refs -> is the
 * chunk containing the verse returned first? Also the reference-parsing traps (1 John vs John, Book of Mormon...).
 *   dotenv -o -e .env -e .env.local -- tsx --tsconfig tsconfig.json scripts/eval/review/probe_scripture.ts [outfile]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieve } from "@/lib/rag/retriever";
import { createRagTools } from "@/lib/rag/tools";
import { parseScriptureSelection } from "@/lib/rag/scripture-reference";
import { ALL_SOURCES } from "@/lib/types";

for (const k of Object.keys(process.env)) if (k.startsWith("UPSTASH") || k.startsWith("KV_")) delete process.env[k];
const here = dirname(fileURLToPath(import.meta.url));
const SCRAPER = process.env.LDS_SCRAPER ?? resolve(here, "../../../../lds-scraper");
const DATA = join(SCRAPER, "data/chunks/scriptures");

type Row = { id: string; book: string; chapter: number; verse: string };
const load = (lang: string) =>
  readFileSync(`${DATA}/${lang}/scriptures_${lang}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);

// Deterministic pseudo-random sample (no Math.random so runs are repeatable).
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function main() {
  const out: Record<string, unknown>[] = [];
  for (const lang of ["eng", "ita"] as const) {
    const rows = load(lang);
    const byChapter = new Map<string, Row[]>();
    for (const r of rows) {
      const slug = r.id.split(":")[2];
      const k = `${slug}:${r.chapter}`;
      (byChapter.get(k) ?? byChapter.set(k, []).get(k)!).push(r);
    }
    const keys = [...byChapter.keys()];
    const sample = Array.from({ length: 40 }, () => keys[Math.floor(rnd() * keys.length)]);
    for (const key of sample) {
      const chunks = byChapter.get(key)!;
      const { book, chapter } = chunks[0];
      const ref = `${book} ${chapter}`;
      const got = await retrieve(ref, ["scriptures"], lang, 16, { scriptureLanguage: lang });
      const want = new Set(chunks.map((c) => c.id));
      const hit = got.filter((c) => want.has(c.id)).length;
      const target = chunks[Math.floor(rnd() * chunks.length)];
      const [a, b] = target.verse.split("-").map(Number);
      const v = a + Math.floor(rnd() * ((b ?? a) - a + 1));
      const vref = `${book} ${chapter}:${v}`;
      const vgot = await retrieve(vref, ["scriptures"], lang, 16, { scriptureLanguage: lang });
      const rec = {
        lang, ref, chapterChunks: want.size, returnedFromChapter: hit, returned: got.length,
        complete: hit === want.size, firstIsChapter: !!got[0] && want.has(got[0].id),
        vref, verseFirstOk: vgot[0]?.id === target.id, verseAnyOk: vgot.some((c) => c.id === target.id), verseFirst: vgot[0]?.id,
      };
      out.push(rec);
      console.log(JSON.stringify(rec));
    }
  }
  // Reference + topic, through the real lookup_scripture_passage tool (topK 16 as the model's default):
  // the whole chapter must come back (complete) and a verse reference must still return its chunk first.
  // A fresh tool set per case: the turn context locks the scripture language and dedups claimed chunks.
  const newLookup = () =>
    createRagTools({ language: "eng", sources: ALL_SOURCES, topK: 20, initialChunks: [], maxChunks: 50, maxRetrievalCalls: 2, onSources: () => {} })
      .lookup_scripture_passage as unknown as {
      execute: (i: { reference: string; language: string; topK: number }, o: unknown) => Promise<{ chunks: { id: string }[]; truncated?: string }>;
    };
  const topical: [string, "eng" | "ita", string, string?][] = [
    ["Alma 32 e la fede nelle difficoltà quotidiane", "ita", "alma:32"],
    ["Mosia 4 aiutare i poveri e la carità verso tutti", "ita", "mosiah:4"],
    ["Giacobbe 5 allegoria dell'olivo e il raduno d'Israele", "ita", "jacob:5"],
    ["Ether 12 fede e debolezza nella vita di ogni giorno", "ita", "ether:12"],
    ["Alma 32 faith and hope when life is hard", "eng", "alma:32"],
    ["1 Nephi 3 obedience when the commandments feel impossible", "eng", "1-ne:3"],
    ["Moroni 10 how to know the Book of Mormon is true", "eng", "moro:10"],
    // Largest chapters (20 / 28 eng / 29 ita chunks), bare and with a topic: must come back whole
    ["Doctrine and Covenants 124", "eng", "dc:124"],
    ["Dottrina e Alleanze 124", "ita", "dc:124"],
    ["Doctrine and Covenants 124 temples and priesthood keys for the latter days", "eng", "dc:124"],
    ["Dottrina e Alleanze 124 templi e chiavi del sacerdozio negli ultimi giorni", "ita", "dc:124"],
    ["Joseph Smith—History 1", "eng", "js-h:1"],
    ["Joseph Smith—Storia 1", "ita", "js-h:1"],
    ["Joseph Smith—History 1 the first vision and how prayer was answered", "eng", "js-h:1"],
    ["Joseph Smith—Storia 1 la prima visione e come fu risposta la preghiera", "ita", "js-h:1"],
    ["Alma 7:11 e la sofferenza di Cristo per le nostre infermità", "ita", "alma:7", "alma:7:11"],
    ["Mosiah 3:19 putting off the natural man and becoming like a child", "eng", "mosiah:3", "mosiah:3:19"],
  ];
  const topicalOut: Record<string, unknown>[] = [];
  for (const [reference, lang, key, verse] of topical) {
    const [slug, ch] = key.split(":");
    const want = load(lang).filter((r) => r.id.split(":")[2] === slug && r.chapter === Number(ch));
    const res = await newLookup().execute({ reference, language: lang, topK: 16 }, { toolCallId: "probe", messages: [] });
    const got = new Set(res.chunks.map((c) => c.id));
    const rec = {
      reference, lang, hybrid: (parseScriptureSelection(reference, lang)?.residualWords ?? 0) >= 3,
      chapterChunks: want.length, returnedFromChapter: want.filter((c) => got.has(c.id)).length,
      complete: verse ? undefined : want.every((c) => got.has(c.id)), // a verse reference returns the verse's chunk(s), not the chapter
      verseFirstOk: verse ? !!res.chunks[0]?.id.startsWith(`scriptures:${lang}:${verse.split(":")[0]}:${verse.split(":")[1]}:`) && want.some((c) => c.id === res.chunks[0].id && c.verse.split("-").map(Number)[0] <= Number(verse.split(":")[2]) && Number(verse.split(":")[2]) <= Number(c.verse.split("-").pop())) : undefined,
    };
    topicalOut.push(rec);
    console.log(JSON.stringify(rec));
  }
  // Ranges with more than 30 chunks, with a topic: the first 30 come back in order and the result says it was cut.
  const wide: [string, "eng" | "ita", string][] = [
    ["Isaiah 1-20 and the invitation to repent and be cleansed", "eng", "isa"],
    ["Isaia 1-20 l'invito a pentirsi e a essere purificati", "ita", "isa"],
    ["Isaiah 1-20", "eng", "isa"],
  ];
  const wideOut: Record<string, unknown>[] = [];
  for (const [reference, lang, slug] of wide) {
    const res = await newLookup().execute({ reference, language: lang, topK: 16 }, { toolCallId: "probe", messages: [] });
    const passage = res.chunks.filter((c) => c.id.split(":")[2] === slug && Number(c.id.split(":")[3]) <= 20);
    const rec = { reference, lang, passageChunks: passage.length, truncatedShown: !!res.truncated, ok: passage.length >= 30 && !!res.truncated };
    wideOut.push(rec);
    console.log(JSON.stringify(rec));
  }
  console.log({ wideRangeTruncatedShown: `${wideOut.filter((x) => x.ok).length}/${wideOut.length}` });

  console.log({ topicalChapterComplete: `${topicalOut.filter((x) => x.complete).length}/${topicalOut.filter((x) => x.complete !== undefined).length}`, topicalVerseFirst: `${topicalOut.filter((x) => x.verseFirstOk).length}/${topicalOut.filter((x) => x.verseFirstOk !== undefined).length}` });

  const agg = (lang?: string) => {
    const r = out.filter((x) => !lang || x.lang === lang);
    const pct = (f: (x: Record<string, unknown>) => boolean) => ((100 * r.filter(f).length) / r.length).toFixed(1);
    return { lang: lang ?? "all", n: r.length, chapterComplete: pct((x) => !!x.complete), chapterAnyHit: pct((x) => (x.returnedFromChapter as number) > 0), verseFirst: pct((x) => !!x.verseFirstOk), verseAny: pct((x) => !!x.verseAnyOk) };
  };
  const summary = [agg("eng"), agg("ita"), agg()];
  console.log(summary);
  const file = process.argv[2] ?? join(here, "out", "probe_scripture.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ summary, out, topicalOut, wideOut }, null, 1));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
