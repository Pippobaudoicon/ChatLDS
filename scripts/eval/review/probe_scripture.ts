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
  const agg = (lang?: string) => {
    const r = out.filter((x) => !lang || x.lang === lang);
    const pct = (f: (x: Record<string, unknown>) => boolean) => ((100 * r.filter(f).length) / r.length).toFixed(1);
    return { lang: lang ?? "all", n: r.length, chapterComplete: pct((x) => !!x.complete), chapterAnyHit: pct((x) => (x.returnedFromChapter as number) > 0), verseFirst: pct((x) => !!x.verseFirstOk), verseAny: pct((x) => !!x.verseAnyOk) };
  };
  const summary = [agg("eng"), agg("ita"), agg()];
  console.log(summary);
  const file = process.argv[2] ?? join(here, "out", "probe_scripture.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ summary, out }, null, 1));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
