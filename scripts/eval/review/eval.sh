#!/usr/bin/env bash
# End-to-end review eval: generate (Gateway, ~$0.3 per scope) -> score -> judge (codex/muse CLI, no paid key) -> report.
#   pnpm eval:review <label> [standard] [super]        # default: both plans
# Output: scripts/eval/review/out/<label>/{runs,scores,judge}-*.json + report.md. Needs Node 24 and a fresh VERCEL_OIDC_TOKEN
# in .env.local (`vercel env pull`). Compare two runs: python3 scripts/eval/review/report.py out/<before> out/<after>
set -euo pipefail
cd "$(dirname "$0")/../../.."
label="${1:?usage: eval.sh <label> [standard] [super]}"; shift || true
scopes=("$@"); [ ${#scopes[@]} -eq 0 ] && scopes=(standard super)
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "Node 24 required (see docs/PROJECT_INFO.md)"; exit 1; }
out="scripts/eval/review/out/$label"; mkdir -p "$out"
for s in "${scopes[@]}"; do
  SCOPE=$s OUT=$out npx dotenv -o -e .env -e .env.local -- tsx --tsconfig tsconfig.json scripts/eval/review/run.ts > "$out/gen-$s.log" 2>&1 &
done
wait
python3 scripts/eval/review/score.py "$out"
python3 scripts/eval/review/judge.py "$out" "${scopes[@]}" | tee "$out/judge.log" | tail -3
python3 scripts/eval/review/report.py "$out"
