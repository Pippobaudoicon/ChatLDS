# RAG review eval (citation fidelity, IT questions over EN sources)

End-to-end eval of the real chat turn (same system prompt, tools, loop policy and model as `route.ts`) on
**104 questions, 65 Italian (62%) / 39 English**. Most Italian questions have their answer in **English** sources
(Conference, General Handbook, Gospel Topics): the model must answer in Italian with correct, faithful citations.
Translated quotations are not verbatim, so the judge scores them for fidelity to the English original.

```bash
pnpm eval:review:validate                 # check every gold/anchor against the local chunks (no API)
pnpm eval:review <label> [standard] [super]   # generate + score + judge + report -> scripts/eval/review/out/<label>/
python3 scripts/eval/review/report.py scripts/eval/review/out/<before> scripts/eval/review/out/<after>
pnpm eval:review:probe                    # deterministic scripture lookup probe (verse 1st / chapter complete), ~$0
```

Requirements: Node 24; `.env.local` with a fresh `VERCEL_OIDC_TOKEN` (`vercel env pull`); the sibling checkout
`../lds-scraper` (override with `LDS_SCRAPER`) for the local chunk files and the book table; `codex` (and `muse`) CLI logged in.

## Pieces
| file | what |
|---|---|
| `eval_set.json` | questions: `gold` (reference / talk / id prefix / content / talkcites / chapter), `expect` (answer / not_found / no_official_position), `facts` (ground truth for the judge), `anchors` (strings that must exist in the gold chunks, checked by `validate_set.py`), `requires_super` (gold only in Super-only namespaces: skipped for the Standard plan) |
| `run.ts` | generation. **Costs real money** (AI Gateway, ~$0.3 per plan). Upstash is disabled; reads Pinecone only |
| `score.py` | deterministic: gold in context / rank, `[N]` range, scripture refs valid/grounded/matching their `[N]`, quotes |
| `judge.py` | claim-level LLM judge through a **subscription CLI** (`codex exec --model gpt-6-luna`, fallback `muse exec --model muse-spark-1.3`; `JUDGE=muse` to flip). Validates the JSON and re-asks on malformed output. Sees what the model saw, including each source's `references` metadata |
| `report.py` | per plan x language table: gold in context / top 5, claims supported, wrong references, swapped `[N]`, expected behavior, cost and latency p50/p90 |
| `probe_scripture.ts` | retrieval-only probe of the structured scripture lookup |

The judge is an LLM: spot-check a sample by hand before trusting small differences (two passes in the original audit disagreed on a few borderline items).
The older `scripts/eval/{run,answers,dataset}.ts` retrieval A/B evals are unrelated and untouched.
