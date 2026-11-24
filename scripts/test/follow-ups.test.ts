/**
 * Pure tests for cleaning suggested follow-up questions.
 *
 * Run: `pnpm run test:follow-ups`
 */
import { MAX_FOLLOW_UP_LENGTH, normalizeFollowUps, parseFollowUpText } from "@/lib/chat/follow-ups";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check("non-array output gives no suggestions", same(normalizeFollowUps("a question?"), []));
check(
  "list markers, quotes and extra spaces are removed",
  same(normalizeFollowUps(["1. What is faith?", "- \"Where is it  taught?\"", "• «Come applicarlo?»"]), [
    "What is faith?",
    "Where is it taught?",
    "Come applicarlo?",
  ])
);
check(
  "empty, non-string, over-long and repeated entries are dropped",
  same(
    normalizeFollowUps(["", 3, "x".repeat(MAX_FOLLOW_UP_LENGTH + 1), "Why?", "why?", "How?"]),
    ["Why?", "How?"]
  )
);
check(
  "a suggestion equal to the user's question is dropped",
  same(normalizeFollowUps(["What is grace?", "Where is grace taught?"], " what is grace? "), [
    "Where is grace taught?",
  ])
);
check(
  "at most three suggestions",
  normalizeFollowUps(["A?", "B?", "C?", "D?"]).length === 3
);
check(
  "plain-text reply: one question per line is parsed and cleaned",
  same(parseFollowUpText("1. What is faith?\r\n- Where is it taught?\n\nCome applicarlo?", "What is faith?"), [
    "Where is it taught?",
    "Come applicarlo?",
  ])
);
check("empty reply gives no suggestions", same(parseFollowUpText("  \n\n"), []));
check(
  "non-question lines (prompt echoes, framing) are dropped",
  same(parseFollowUpText("user\nHere are some questions\nWhat is faith?\nTell me more"), ["What is faith?"])
);

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
