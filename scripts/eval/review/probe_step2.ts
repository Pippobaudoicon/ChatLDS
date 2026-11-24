/**
 * Step 2 (metadata + links) retrieval probe: calls the real tools with the inputs the model sends for the
 * targeted questions and measures the payload the model would see. No LLM, ~$0 (query embeddings + rerank).
 * Gold comes from the local lds-scraper files (same data as Pinecone): chunks per chapter, graph footnotes per verse.
 *   npx dotenv -o -e .env -e .env.local -- tsx --tsconfig tsconfig.json scripts/eval/review/probe_step2.ts <outfile>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRagTools } from "@/lib/rag/tools";
import { ALL_SOURCES, type SourceChunk } from "@/lib/types";

for (const k of Object.keys(process.env)) if (k.startsWith("UPSTASH") || k.startsWith("KV_")) delete process.env[k];
const here = dirname(fileURLToPath(import.meta.url));
const SCRAPER = process.env.LDS_SCRAPER ?? resolve(here, "../../../../lds-scraper");

type Payload = { chunks: Array<Record<string, unknown> & { id: string }> };
async function call(tool: "semantic_search" | "lookup_scripture_passage" | "search_conference_talks", input: Record<string, unknown>) {
  const sources: SourceChunk[] = [];
  const tools = createRagTools({ language: "eng", sources: ALL_SOURCES, topK: 20, maxChunks: 50, maxRetrievalCalls: 2, onSources: (c) => sources.push(...c) });
  const execute = tools[tool].execute as unknown as (i: unknown, o: unknown) => Promise<Payload>;
  // zod defaults are not applied when execute is called directly
  const defaults = { search_conference_talks: { topK: 12 }, lookup_scripture_passage: { topK: 16 }, semantic_search: {} }[tool];
  const payload = await execute({ ...defaults, ...input }, { toolCallId: "probe", messages: [] });
  return { payload, sources };
}

// gold: footnote / TG / BD notes of one verse, from the graph
const graph = readFileSync(join(SCRAPER, "graph/cross_references.jsonl"), "utf8").split("\n");
function verseNotes(ref: string): Set<string> {
  const out = new Set<string>();
  for (const l of graph) {
    if (!l.includes(`"from_ref": "${ref}"`)) continue;
    const e = JSON.parse(l);
    if (["footnote", "tg", "bd"].includes(e.kind)) out.add(e.to_ref);
  }
  return out;
}
function chapterIds(lang: string, slug: string, chapter: number): Set<string> {
  const rows = readFileSync(join(SCRAPER, `data/chunks/scriptures/${lang}/scriptures_${lang}.jsonl`), "utf8").trim().split("\n");
  return new Set(rows.map((l) => JSON.parse(l)).filter((r) => r.id.split(":")[2] === slug && r.chapter === chapter).map((r) => r.id));
}
const isMonson = (c: SourceChunk) => /monson/i.test(c.speaker ?? "") || c.id.includes("thomas-s-monson");

const rows: Record<string, unknown>[] = [];
const log = (r: Record<string, unknown>) => { rows.push(r); console.log(JSON.stringify(r)); };

async function main() {
  // Monson (cause C: speaker was a post-filter over the top 36)
  for (const [id, tool, input] of [
    ["pres-monson-rescue/semantic", "semantic_search", { query: "What did President Thomas S. Monson teach about rescuing others?", scriptureLanguage: "ita" }],
    ["pres-monson-rescue/conference", "search_conference_talks", { query: "going to the rescue of others", speaker: "Thomas S. Monson" }],
    ["conf-monson-temple", "search_conference_talks", { query: "blessings of the temple", speaker: "Thomas S. Monson" }],
    ["conf-monson-kindness-ita", "search_conference_talks", { query: "kindness, charity and love", speaker: "Thomas S. Monson" }],
  ] as const) {
    const { sources } = await call(tool, input);
    const monson = sources.filter(isMonson);
    log({ id, monsonFound: monson.length > 0, monsonChunks: monson.length, n: sources.length, titles: [...new Set(monson.map((c) => c.title))] });
  }
  // speaker + year filter precision
  for (const [id, input] of [
    ["speaker-year/uchtdorf-2016", { query: "faith and hope in Jesus Christ", speaker: "Dieter F. Uchtdorf", year: 2016 }],
    ["speaker-year/nelson-2024", { query: "the temple and covenants", speaker: "Russell M. Nelson", year: 2024 }],
    ["speaker-year/year-2018", { query: "ministering to others", year: 2018 }],
  ] as const) {
    const { sources } = await call("search_conference_talks", input);
    const ok = sources.filter((c) => (!("speaker" in input) || (c.speaker ?? "").includes(input.speaker.split(" ").at(-1)!)) && (c.date ?? "").startsWith(String(input.year)));
    log({ id, n: sources.length, matching: ok.length, precision: sources.length ? +(ok.length / sources.length).toFixed(2) : null });
  }
  // Jacob 5 complete (structured chapter lookup)
  for (const [id, reference, language] of [["ch-jacob-5/ita", "Giacobbe 5", "ita"], ["ch-jacob-5/eng", "Jacob 5", "eng"]] as const) {
    const want = chapterIds(language, "jacob", 5);
    const { sources } = await call("lookup_scripture_passage", { reference, language });
    const got = sources.filter((c) => want.has(c.id)).length;
    log({ id, chapterChunks: want.size, returned: got, complete: got === want.size });
  }
  // verse-level notes: does the payload give exactly the notes of the requested verse?
  for (const [id, reference, language, anchor, verse] of [
    ["xref-moroni-10-4", "Moroni 10:4", "eng", "Moroni 10:4", "4"],
    ["xref-ether-12-6", "Ether 12:6", "ita", "Ether 12:6", "6"],
    ["xref-notes-2-ne-2-25", "2 Nephi 2:25", "eng", "2 Nephi 2:25", "25"],
  ] as const) {
    const gold = verseNotes(anchor);
    const { payload } = await call("lookup_scripture_passage", { reference, language });
    const first = payload.chunks[0] as { notes?: Record<string, string[]>; references?: string[] };
    // after: notes[verse]; before: the only thing available is the chunk-level list
    const seen = first.notes?.[verse] ?? first.references ?? [];
    const hit = seen.filter((r) => gold.has(r)).length;
    log({ id, verseLevel: !!first.notes, goldNotes: gold.size, shown: seen.length, recall: +(hit / gold.size).toFixed(2), precision: seen.length ? +(hit / seen.length).toFixed(2) : null });
  }
  // talks citing Alma 7:11: in the lookup payload (talks list) or among conference sources
  for (const [id, tool, input] of [
    ["talks-alma-7-11/lookup-eng", "lookup_scripture_passage", { reference: "Alma 7:11", language: "eng" }],
    ["talks-alma-7-11/lookup-ita", "lookup_scripture_passage", { reference: "Alma 7:11", language: "ita" }],
    ["talks-alma-7-11/conference", "search_conference_talks", { query: "talks citing Alma 7:11, Christ takes upon Him our pains and infirmities" }],
  ] as const) {
    const { payload, sources } = await call(tool, input);
    const listed = payload.chunks.flatMap((c) => ((c.talks as Record<string, string[]> | undefined)?.["11"] ?? []));
    const citing = new Set(sources.filter((c) => c.source === "conference" && (c.references ?? []).includes("Alma 7:11")).map((c) => c.id.split(":").slice(0, 5).join(":")));
    log({ id, talksListed: listed.length, conferenceSourcesCiting: citing.size, talksCitingFound: listed.length + citing.size, sample: listed.slice(0, 3) });
  }
  // Topical Guide entries
  for (const [id, query, prefix] of [
    ["xref-tg-grace", "Topical Guide entry Grace: list of scriptures", "study_helps:eng:scriptures:tg:grace"],
    ["xref-tg-charity", "Topical Guide entry Charity: list of scriptures", "study_helps:eng:scriptures:tg:charity"],
  ] as const) {
    const { sources } = await call("semantic_search", { query, scriptureLanguage: "eng" });
    const rank = sources.findIndex((c) => c.id.startsWith(prefix));
    log({ id, tgFound: rank >= 0, rank: rank >= 0 ? rank + 1 : null, gsOrBdInstead: sources.filter((c) => /:(gs|bd):/.test(c.id)).length });
  }
  // authority_level in the payload
  const { payload } = await call("semantic_search", { query: "the family is central to the Creator's plan", scriptureLanguage: "eng" });
  log({ id: "authority-in-payload", withAuthority: payload.chunks.filter((c) => c.authority).length, n: payload.chunks.length });
  writeFileSync(process.argv[2] ?? join(here, "out/probe_step2.json"), JSON.stringify(rows, null, 1));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
