// Suggested next messages (questions, requests, additions) shown under the composer after an answer. Generated
// by a small separate model call once the answer is saved, so they never delay
// the answer itself; see POST /api/conversations/[id]/follow-ups.

import { generateText, gateway } from "ai";

// A small, fast multilingual model: three short suggestions need no more.
// Pinned here rather than read from CHAT_MODEL, so a pricier chat model
// doesn't raise this cost. The deployed alias (nvidia/nemotron-3.5 via
// `vmc/chatlds-followup-model`) is a reasoning model, so reasoning is
// disabled below — at the default it spent the whole token budget thinking
// and returned no text.
const DEFAULT_FOLLOW_UP_MODEL = "nvidia/nemotron-3.5-lightning-free";
const FOLLOW_UP_MODEL = process.env.FOLLOW_UP_MODEL?.trim() || DEFAULT_FOLLOW_UP_MODEL;
// Suggestions arriving later than this are no longer useful; give up instead.
const FOLLOW_UP_TIMEOUT_MS = 10_000;

export const MAX_FOLLOW_UPS = 3;
export const MAX_FOLLOW_UP_LENGTH = 120;
// Only the answer's opening matters for picking next messages; keeps the call cheap.
const MAX_ANSWER_CHARS = 2500;

/**
 * Clean model output into at most {@link MAX_FOLLOW_UPS} short, distinct
 * suggestions: trims list markers and quotes, drops empty, over-long, or repeated
 * entries and any that just repeat the user's question.
 */
export function normalizeFollowUps(raw: unknown, question = ""): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set([question.trim().toLowerCase()]);
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^["'“«]+|["'”»]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const key = text.toLowerCase();
    if (!text || text.length > MAX_FOLLOW_UP_LENGTH || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length === MAX_FOLLOW_UPS) break;
  }
  return result;
}

/**
 * Parse the model's plain-text reply: one "- " suggestion per line. (The
 * gateway model doesn't enforce structured output, so no JSON schema is
 * requested.)
 */
export function parseFollowUpText(text: string, question = ""): string[] {
  // Only list items (or bare questions, if the model drops the marker) count —
  // this drops stray echoes of the prompt's role labels or framing.
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line) || line.trim().endsWith("?"));
  return normalizeFollowUps(lines, question);
}

/** Suggest next messages for a finished turn. Returns `[]` on any error. */
export async function generateFollowUps(
  question: string,
  answer: string
): Promise<string[]> {
  // The free deployed model is inconsistent (it occasionally echoes the
  // instructions or rambles instead of answering), so one empty parse is
  // retried once before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    const followUps = await generateOnce(question, answer);
    if (followUps.length > 0) return followUps;
  }
  return [];
}

async function generateOnce(
  question: string,
  answer: string
): Promise<string[]> {
  try {
    const result = await generateText({
      model: gateway(FOLLOW_UP_MODEL),
      // This task needs no reasoning; the deployed model reasons by default
      // and would spend the whole budget before writing anything.
      reasoning: "none",
      instructions: [
        "You suggest what a user might ask next in a chat about the teachings of The Church of Jesus Christ of Latter-day Saints.",
        `Write ${MAX_FOLLOW_UPS} short messages (under 80 characters each) the USER could send next, in the user's voice.`,
        "They need not be questions: mix questions with requests and additions, e.g. \"Give me a practical example\", \"Tell me more about the second point\", \"I'd like a talk on this\".",
        "End with a question mark only real questions; requests and statements end without one.",
        "Write them in the same language as the user's question.",
        "Make them distinct: e.g. go deeper on one point, ask for a scripture or talk, ask how to apply it.",
        "Do not repeat the user's question and do not answer anything.",
        "Write exactly one per line, each starting with \"- \", with no quotes or extra text.",
      ].join("\n"),
      prompt: `User question:\n${question.trim()}\n\nAssistant answer:\n${answer.trim().slice(0, MAX_ANSWER_CHARS)}`,
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS),
    });
    return parseFollowUpText(result.text, question);
  } catch (error) {
    console.error("Follow-up suggestion generation failed", error);
    return [];
  }
}
