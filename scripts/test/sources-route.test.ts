/**
 * GET /api/sources: public lists the native apps read (standard = ALL_SOURCES,
 * super = SUPER_SOURCES). The proxy never protects it (auth is checked per route).
 *
 * Run: `pnpm run test:sources`
 */
import { GET } from "@/app/api/sources/route";
import { ALL_SOURCES, SUPER_SOURCES } from "@/lib/types";

async function main() {
  const res = GET();
  const body = await res.json();
  const checks: [string, boolean][] = [
    ["200 json", res.status === 200 && res.headers.get("content-type")?.includes("application/json") === true],
    ["standard = ALL_SOURCES, in order", JSON.stringify(body.standard) === JSON.stringify(ALL_SOURCES)],
    ["super = SUPER_SOURCES", JSON.stringify(body.super) === JSON.stringify(SUPER_SOURCES)],
    ["standard includes gospel_teachings", body.standard.includes("gospel_teachings")],
    ["super has no duplicates and contains standard", new Set(body.super).size === body.super.length && ALL_SOURCES.every((s) => body.super.includes(s))],
    ["cached a few minutes", res.headers.get("cache-control")?.includes("max-age=300") === true],
  ];
  let failures = 0;
  for (const [label, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  process.exit(failures ? 1 : 0);
}

main();
