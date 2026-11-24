/**
 * End-to-end eval of the CURRENT rag-chat tool loop (read-only; the system under test).
 * Mirrors src/app/api/chat/route.ts: buildSystemPrompt + buildUserMessage + createRagTools +
 * prepareChatToolStep + streamText over the AI Gateway (so it costs real money: ~$0.3 per 100 turns).
 * No DB, no Clerk, no memory tools; Upstash is disabled so nothing is cached or written anywhere.
 *
 *   SCOPE=standard|super [CHAT_MODEL=...] [OUT=dir] tsx --tsconfig tsconfig.json scripts/eval/review/run.ts [idFilter,idFilter2,...]
 * Writes <OUT>/runs-<scope>.json (default OUT: scripts/eval/review/out). Normally driven by eval.sh.
 * Questions marked requires_super (gold only in Super-only namespaces) are skipped for the standard scope.
 */
import { gateway, isStepCount, streamText, type StepResult, type ToolSet } from "ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildUserMessage } from "@/lib/rag/system-prompt";
import { createRagTools } from "@/lib/rag/tools";
import { toToolChunk } from "@/lib/rag/tools/shared/chunk-formatting";
import { prepareChatToolStep } from "@/lib/rag/tool-loop-policy";
import { getIndexLanguage } from "@/lib/rag/language-routing";
import { retrievalFlagsSignature } from "@/lib/rag/flags";
import { ALL_SOURCES, SUPER_SOURCES, type SourceChunk } from "@/lib/types";

for (const k of Object.keys(process.env)) if (k.startsWith("UPSTASH") || k.startsWith("KV_")) delete process.env[k];

const here = dirname(fileURLToPath(import.meta.url));
const SCOPE = process.env.SCOPE === "super" ? "super" : "standard";
const OUT = process.env.OUT ?? join(here, "out");
const CHAT_MODEL = process.env.CHAT_MODEL ?? process.env.CHAT_MODEL_OVERRIDE ?? "deepseek/deepseek-v4.1-flash";
const TOOL_USE_COMPLETE =
  "Tool use is complete. Produce the final user-facing answer now using the retrieved or preloaded sources. Do not emit tool-call syntax, XML, DSML, or another tool request.";

type Q = { id: string; lang: "ita" | "eng"; q: string; requires_super?: boolean };
const filter = process.argv[2] ?? "";
const questions = (JSON.parse(readFileSync(join(here, "eval_set.json"), "utf8")) as Q[]).filter(
  (q) => filter.split(",").some((f) => q.id.includes(f)) && (SCOPE === "super" || !q.requires_super)
);

const meta = (s: { providerMetadata?: unknown }) =>
  ((s.providerMetadata as { gateway?: Record<string, unknown> } | undefined)?.gateway ?? {}) as {
    cost?: string; routing?: { finalProvider?: string }; canonicalSlug?: string;
  };

async function runTurn(q: Q) {
  const sources: SourceChunk[] = [];
  const tools: ToolSet = createRagTools({
    language: getIndexLanguage(),
    sources: SCOPE === "super" ? SUPER_SOURCES : ALL_SOURCES,
    topK: 20, // Pro cap (SUBSCRIPTION_PRO_MAX_TOP_K)
    initialChunks: [],
    maxChunks: 50, // Pro cap (CHAT_MAX_RESPONSE_SOURCES)
    maxRetrievalCalls: 2,
    onSources: (c) => sources.push(...c),
  });
  const system = buildSystemPrompt();
  const t0 = performance.now();
  let firstAnswerMs: number | null = null;
  let step = -1;
  let error: string | undefined;
  const result = streamText({
    model: gateway(CHAT_MODEL),
    instructions: system,
    messages: [{ role: "user", content: buildUserMessage(q.q, [], { uiLanguage: q.lang }) }],
    maxOutputTokens: 6000,
    stopWhen: isStepCount(4),
    abortSignal: AbortSignal.timeout(180_000),
    tools,
    prepareStep: ({ steps }) => {
      const p = prepareChatToolStep(steps, false);
      return p ? { ...p, instructions: `${system}\n\n${TOOL_USE_COMPLETE}` } : undefined;
    },
  });
  try {
    for await (const part of result.stream) {
      if (part.type === "start-step") step += 1;
      else if (part.type === "text-delta" && step > 0 && part.text.trim()) firstAnswerMs ??= performance.now() - t0;
      else if (part.type === "error") error = String(part.error);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const steps: StepResult<ToolSet>[] = await Promise.resolve(result.steps).catch(() => []);
  const usage = await Promise.resolve(result.usage).catch(() => undefined);
  return {
    id: q.id,
    scope: SCOPE,
    error,
    totalMs: Math.round(performance.now() - t0),
    firstAnswerMs: firstAnswerMs && Math.round(firstAnswerMs),
    toolInputs: steps.flatMap((s) => s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input }))),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: steps.reduce((sum, s) => sum + Number(meta(s).cost ?? 0), 0),
    resolvedModel: steps.map((s) => meta(s).canonicalSlug ?? meta(s).routing?.finalProvider ?? "?").join(">"),
    answer: steps.at(-1)?.text ?? "",
    preamble: steps.length > 1 ? steps[0].text : "",
    // text = full chunk (for scoring); seen = exactly what the model got (toToolChunk), for the judge.
    sources: sources.map((s, i) => {
      const seen = toToolChunk(s);
      return {
        n: i + 1, id: s.id, source: s.source, language: s.language, score: s.score,
        book: s.book, chapter: s.chapter, verse: s.verse, title: s.title, speaker: s.speaker,
        date: s.date, url: s.url, references: s.references, text: s.text,
        seen: { text: seen.text, references: seen.references, summary: seen.summary, authority: seen.authority, notes: seen.notes, talks: seen.talks },
      };
    }),
  };
}

async function main() {
  console.log(`model=${CHAT_MODEL} scope=${SCOPE} flags=${retrievalFlagsSignature()} n=${questions.length}`);
  const out: Awaited<ReturnType<typeof runTurn>>[] = [];
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `runs-${SCOPE}.json`);
  for (const q of questions) {
    const r = await runTurn(q);
    out.push(r);
    console.log(`${q.id.padEnd(32)} ${(r.totalMs / 1000).toFixed(1)}s ans@${((r.firstAnswerMs ?? NaN) / 1000).toFixed(1)}s tools=${r.toolInputs.map((t) => t.tool).join(",")} src=${r.sources.length} in=${r.inputTokens} $${r.costUsd.toFixed(4)}${r.error ? " ERR " + r.error.slice(0, 120) : ""}`);
    writeFileSync(path, JSON.stringify({ model: CHAT_MODEL, scope: SCOPE, flags: retrievalFlagsSignature(), runs: out }, null, 1));
  }
  console.log(`total $${out.reduce((s, r) => s + r.costUsd, 0).toFixed(4)} -> ${path}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
