/**
 * Pure tests for the answer format the system prompt asks for: inline [N]
 * markers and linked source names, with no closing list of sources.
 *
 * Run: `pnpm run test:system-prompt`
 */
import { linkifyInlineCitations } from "@/lib/rag/citation-links";
import { buildSystemPrompt, RESPONSE_STYLE_IDS } from "@/lib/rag/system-prompt";
import type { SourceChunk } from "@/lib/types";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

for (const style of RESPONSE_STYLE_IDS) {
  const prompt = buildSystemPrompt(style);
  check(`${style}: forbids a closing list of sources`, prompt.includes("Do not add a closing list"));
  check(`${style}: asks for linked source names`, prompt.includes("write that name as a markdown link"));
  check(`${style}: no longer asks to cite by title`, !prompt.includes("Cite sources by title"));
}

// The format the prompt asks for must survive the client's citation rewrite: the
// title link stays as written and only the [N] marker becomes a link.
const sources = [{ url: "https://example.org/alma-32" }] as SourceChunk[];
check(
  "title link is kept and the [N] marker is linked",
  linkifyInlineCitations("[Alma 32:21](https://example.org/alma-32) teaches faith [1].", sources) ===
    "[Alma 32:21](https://example.org/alma-32) teaches faith [\\[1\\]](https://example.org/alma-32)."
);
check(
  "a linked name that is only a number is not treated as a marker",
  linkifyInlineCitations("[1](https://example.org/other)", sources) === "[1](https://example.org/other)"
);

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
