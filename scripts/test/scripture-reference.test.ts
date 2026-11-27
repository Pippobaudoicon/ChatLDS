/**
 * Scripture reference parsing + book matching (audit §2.1 / §5 step 1).
 * Run: `pnpm run test:scripture-reference` — pure and deterministic, no network.
 */
import { SCRIPTURE_BOOKS, bookMetadataName, parseScriptureSelection } from "@/lib/rag/scripture-reference";
import { byVerse, isRequestedScriptureChunk, tidySourceText } from "@/lib/rag/retriever";
import { cleanSpeakerName } from "@/lib/rag/tools/search-conference-talks/tool";
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
  ["Eter 12:6", "ita", "ether", [12], 6],
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

// residualWords counts around the matched alias, not the first occurrence of its text ("almanacco alma 32" -> 1).
check("residualWords positional", parseScriptureSelection("almanacco alma 32", "ita")?.residualWords === 1);
check("residualWords: topic words only", parseScriptureSelection("Alma 32 fede speranza difficoltà", "ita")?.residualWords === 3);

// `book` metadata name used for the Pinecone filter (matches the indexed chunks, checked against the corpus by the probe).
const bm = (q: string, l: "ita" | "eng") => bookMetadataName(parseScriptureSelection(q, l)!, l);
check("book name eng", bm("1 John 3", "eng") === "1 John" && bm("D&C 1", "eng") === "Doctrine and Covenants");
check("book name ita", bm("1 Giovanni 3", "ita") === "1 Giovanni" && bm("Mosia 8", "ita") === "Mosia");
check("book name em dash", bm("Joseph Smith Storia 1", "ita") === "Joseph Smith—Storia" && bm("Joseph Smith History 1", "eng") === "Joseph Smith—History");

// Every book needs its English `book` metadata name, or the Pinecone filter would be `$eq: undefined`.
check("every book has an English name", SCRIPTURE_BOOKS.every((b) => !!bookMetadataName(b, "eng")));
check("book name OD", bm("Official Declaration 2", "eng") === "Official Declaration" && bm("Dichiarazione ufficiale 1", "ita") === "Dichiarazione Ufficiale");

// Exact book match: no 2-letter prefix fallback ("Marco" must not match "Malachia").
const chunk = (id: string, book: string): SourceChunk => ({ id, book } as SourceChunk);
check("slug match", isRequestedScriptureChunk(chunk("scriptures:eng:mark:2:1-12:v1", "Mark"), "nt", "mark", 2));
check("Malachi is not Mark", !isRequestedScriptureChunk(chunk("scriptures:eng:mal:2:11-17:v1", "Malachi"), "nt", "mark", 2));
check("Moses is not Mosiah", !isRequestedScriptureChunk(chunk("scriptures:eng:moses:8:14-21:v1", "Moses"), "bofm", "mosiah", 8));
check("James is not Jacob", !isRequestedScriptureChunk(chunk("scriptures:ita:james:4:1-13:v1", "Giacomo"), "bofm", "jacob", 4));

// Step 2 metadata: per-verse notes/talks parsing and the speaker form used by the Pinecone filter.
const notes = byVerse(["4: Moro. 7:16; TG Prayer", "5: John 14:26"], ": ", "; ");
check("verse_notes split per verse", JSON.stringify(notes) === JSON.stringify({ "4": ["Moro. 7:16", "TG Prayer"], "5": ["John 14:26"] }));
const talks = byVerse(["11 | None Were with Him | Jeffrey R. Holland | 2009-04"], " | ");
check("cited_in_talks keeps title | speaker | date", talks?.["11"]?.[0] === "None Were with Him | Jeffrey R. Holland | 2009-04");
check("no metadata -> undefined", byVerse(undefined, ": ") === undefined);
for (const [raw, want] of [["Presidente Russell M. Nelson", "Russell M. Nelson"], ["Elder  Dieter F. Uchtdorf", "Dieter F. Uchtdorf"], ["Anziano Holland", "Holland"], ["Thomas S. Monson", "Thomas S. Monson"]]) {
  check(`cleanSpeakerName(${raw})`, cleanSpeakerName(raw) === want, cleanSpeakerName(raw));
}

// Scraped text: spaces left before punctuation where footnote markers were cut out.
for (const [raw, want] of [
  ["la parola a un seme . Ora, nel vostro cuore , ecco ,", "la parola a un seme. Ora, nel vostro cuore, ecco,"],
  ["la vostra incredulità ; sì: «parola» , fine .", "la vostra incredulità; sì: «parola», fine."],
  ["wait ... and see", "wait ... and see"],
  ["costs 3 .5, verses 3 , 4", "costs 3 .5, verses 3, 4"],
  ["Alma 32:28 says faith ! Really ?", "Alma 32:28 says faith! Really?"],
  ["line one\n. line two", "line one\n. line two"],
]) {
  check(`tidySourceText(${JSON.stringify(raw)})`, tidySourceText(raw) === want, tidySourceText(raw));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scripture-reference checks passed");
