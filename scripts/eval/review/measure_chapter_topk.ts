/**
 * Cost of the structured chapter lookup's Pinecone query: topK 80 vs 300 (chapter filter has no book, so it
 * matches ~280 chunks per chapter number) vs a book-name metadata filter with a small topK.
 * Read-only (queries only). Reports latency p50/p90, response bytes and Pinecone read units per query.
 *   dotenv -o -e .env -e .env.local -- tsx --tsconfig tsconfig.json scripts/eval/review/measure_chapter_topk.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pinecone } from "@pinecone-database/pinecone";
import { embedQuery } from "@/lib/rag/embedder";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(process.env.LDS_SCRAPER ?? resolve(here, "../../../../lds-scraper"), "data/chunks/scriptures");
type Row = { id: string; book: string; chapter: number };
const rows = (lang: string) =>
  readFileSync(`${DATA}/${lang}/scriptures_${lang}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);

const index = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! }).index(process.env.PINECONE_INDEX ?? "lds-rag-v1");
// [language, slug, chapter]: a mix of long/short books, ita and eng, like real lookups
const cases: [string, string, number][] = [
  ["ita", "alma", 32], ["ita", "john", 3], ["ita", "2-ne", 2], ["ita", "mosiah", 4], ["eng", "alma", 32],
  ["eng", "moro", 10], ["eng", "1-jn", 4], ["eng", "isa", 53], ["ita", "dc", 76], ["eng", "matt", 5],
];
const q = (s: number[], p: number) => [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.floor(p * s.length))];
type Sample = { ms: number; bytes: number; ru: number; n: number };
const arms: Record<string, Sample[]> = { "topK 80": [], "topK 300": [], "book filter, topK 24": [] };
const rng: Record<string, Sample[]> = { "topK 80": [], "topK 300": [], "book filter, topK 24": [] };

async function run(arm: string, vector: number[], lang: string, chapter: number, book: string, into: Record<string, Sample[]>) {
  const topK = arm === "topK 80" ? 80 : arm === "topK 300" ? 300 : 24;
  const filter: Record<string, unknown> = { language: { $eq: lang }, chapter: { $eq: chapter } };
  if (arm.startsWith("book")) filter.book = { $eq: book };
  const t = performance.now();
  const res = await index.namespace("scriptures").query({ vector, topK, includeMetadata: true, filter });
  into[arm].push({ ms: performance.now() - t, bytes: JSON.stringify(res).length, ru: (res as { usage?: { readUnits?: number } }).usage?.readUnits ?? NaN, n: res.matches.length });
}

async function main() {
  const data = { eng: rows("eng"), ita: rows("ita") } as Record<string, Row[]>;
  for (const [lang, slug, chapter] of cases) {
    const book = data[lang].find((r) => r.id.split(":")[2] === slug)!.book;
    const vector = await embedQuery(`${book} ${chapter}`);
    for (let rep = 0; rep < 3; rep++) for (const arm of Object.keys(arms)) await run(arm, vector, lang, chapter, book, arms);
  }
  // 20-chapter range (the retriever fans out one query per chapter): Isaiah 1-20 (eng)
  const vec = await embedQuery("Isaiah 1-20");
  for (let rep = 0; rep < 3; rep++)
    for (const arm of Object.keys(rng)) {
      const t = performance.now();
      const per: Sample[] = [];
      const tmp: Record<string, Sample[]> = { "topK 80": [], "topK 300": [], "book filter, topK 24": [] };
      await Promise.all(Array.from({ length: 20 }, (_, i) => run(arm, vec, "eng", i + 1, "Isaiah", tmp)));
      per.push(...tmp[arm]);
      rng[arm].push({ ms: performance.now() - t, bytes: per.reduce((a, s) => a + s.bytes, 0), ru: per.reduce((a, s) => a + s.ru, 0), n: per.reduce((a, s) => a + s.n, 0) });
    }
  const fmt = (m: Record<string, Sample[]>) =>
    Object.entries(m).map(([arm, s]) => ({
      arm, samples: s.length,
      "ms p50": Math.round(q(s.map((x) => x.ms), 0.5)), "ms p90": Math.round(q(s.map((x) => x.ms), 0.9)),
      "KB/query": Math.round(s.reduce((a, x) => a + x.bytes, 0) / s.length / 1024),
      "read units/query": +(s.reduce((a, x) => a + x.ru, 0) / s.length).toFixed(1),
      "matches/query": Math.round(s.reduce((a, x) => a + x.n, 0) / s.length),
    }));
  console.log("single-chapter lookups (10 cases x 3 reps)"); console.table(fmt(arms));
  console.log("Isaiah 1-20: 20 parallel queries (3 reps; ms = wall time of the whole fan-out)"); console.table(fmt(rng));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
