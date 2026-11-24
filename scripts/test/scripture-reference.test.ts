/**
 * Scripture reference parsing + book matching (audit §2.1 / §5 step 1).
 * Run: `pnpm run test:scripture-reference` — pure and deterministic, no network.
 */
import { parseScriptureSelection } from "@/lib/rag/scripture-reference";
import { isRequestedScriptureChunk } from "@/lib/rag/retriever";
import type { SourceChunk } from "@/lib/types";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? `  (${detail})` : ""}`);
}

// [query, language, expected book slug, chapters, verseStart]
const cases: [string, "ita" | "eng", string, number[], number?][] = [
  // Audit §2.1: books whose slug used to be confused through the 2-letter fallback
  ["Marco 2:14", "ita", "mark", [2], 14],
  ["Geremia 49:31", "ita", "jer", [49], 31],
  ["Mosia 8:21", "ita", "mosiah", [8], 21],
  ["Marco 13", "ita", "mark", [13]],
  ["Moroni 7:30", "ita", "moro", [7], 30],
  ["Giacobbe 4:9", "ita", "jacob", [4], 9],
  ["Geremia 25", "ita", "jer", [25]],
  ["Giudici 21", "ita", "judg", [21]],
  // Numbered books are not their unnumbered namesakes
  ["1 John 3", "eng", "1-jn", [3]],
  ["1 Giovanni 3", "ita", "1-jn", [3]],
  ["1Nefi 3", "ita", "1-ne", [3]],
  ["John 3", "eng", "john", [3]],
  ["Giovanni 3:16", "ita", "john", [3], 16],
  // Tolerant aliases
  ["Abraamo 3", "ita", "abr", [3]],
  ["Abrahamo 3:22", "ita", "abr", [3], 22],
  ["Abraham 3", "eng", "abr", [3]],
  ["DeA 76", "ita", "dc", [76]],
  ["D&A 76:22", "ita", "dc", [76], 22],
  ["D&C 1:30", "eng", "dc", [1], 30],
];
for (const [q, lang, slug, chapters, verse] of cases) {
  const s = parseScriptureSelection(q, lang);
  check(
    `parse "${q}" -> ${slug} ${chapters.join(",")}${verse ? ":" + verse : ""}`,
    !!s && s.bookSlug === slug && s.chapters.join(",") === chapters.join(",") && s.verseStart === verse,
    JSON.stringify(s && { b: s.bookSlug, c: s.chapters, v: s.verseStart })
  );
}

// "Book of Mormon" is a title, never a whole-book request (it used to turn into Mormon 1-9).
for (const q of ["Joseph Smith Book of Mormon keystone of our religion", "Cosa dice il Libro di Mormon sulla fede?", "What is the Book of Mormon?"]) {
  check(`no scripture reference in "${q}"`, parseScriptureSelection(q, "eng") === null);
}
check("Mormon 3 is still the book of Mormon", parseScriptureSelection("Mormon 3", "eng")?.bookSlug === "morm");
check("explicit whole book still works", parseScriptureSelection("Dammi tutto il libro di Giona", "ita")?.wholeBook === true);
check("'tutto' alone is not a whole-book request", parseScriptureSelection("dimmi tutto su Alma", "ita") === null);

// A bare reference has no residual topic; an own-topic query does (used by retrieve() to run hybrid search).
check("bare reference has no own topic", (parseScriptureSelection("Alma 32", "ita")?.residualWords ?? 9) < 3);
check("'Cosa insegna Alma 32?' has no own topic", (parseScriptureSelection("Cosa insegna Alma 32?", "ita")?.residualWords ?? 9) < 3);
check(
  "reference + topic has own topic",
  (parseScriptureSelection("Alma 32 fede speranza difficoltà quotidiane", "ita")?.residualWords ?? 0) >= 3
);

// Exact book match: no 2-letter prefix fallback ("Marco" must not match "Malachia").
const chunk = (id: string, book: string): SourceChunk => ({ id, book } as SourceChunk);
check("slug match", isRequestedScriptureChunk(chunk("scriptures:eng:mark:2:1-12:v1", "Mark"), "nt", "mark", 2));
check("Malachi is not Mark", !isRequestedScriptureChunk(chunk("scriptures:eng:mal:2:11-17:v1", "Malachi"), "nt", "mark", 2));
check("Moses is not Mosiah", !isRequestedScriptureChunk(chunk("scriptures:eng:moses:8:14-21:v1", "Moses"), "bofm", "mosiah", 8));
check("James is not Jacob", !isRequestedScriptureChunk(chunk("scriptures:ita:james:4:1-13:v1", "Giacomo"), "bofm", "jacob", 4));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scripture-reference checks passed");
