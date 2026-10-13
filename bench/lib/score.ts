/**
 * Deterministic scoring: ANSWER-line extraction, normalization, exact match.
 * No LLM judge — grading is pure string comparison against the task gold.
 */
import type { TaskSpec } from "./tasks.ts";

export interface AnswerExtraction {
  /** Extracted answer text, or null when nothing could be extracted. */
  answer: string | null;
  /** True when no ANSWER line was found and the last non-empty line was used. */
  usedFallback: boolean;
}

export interface ScoreResult {
  correct: boolean;
  extracted: string | null;
  usedFallback: boolean;
}

/** Anything with a final assistant text; accepts a bare string too. */
export type ScoreableRun = string | { finalText: string };

/**
 * Extract the benchmark answer from a model reply.
 * 1. The LAST line matching /^\s*ANSWER:\s*(.+)$/ (case-insensitive, multiline)
 *    wins; `usedFallback` is false.
 * 2. Otherwise the last non-empty line is used as a fallback (`usedFallback`).
 * 3. Empty/whitespace-only input yields { answer: null, usedFallback: false }.
 */
export function extractAnswer(text: string): AnswerExtraction {
  let last: string | null = null;
  const pattern = /^[ \t]*ANSWER:[ \t]*(.+?)[ \t]*$/gim;
  for (const match of text.matchAll(pattern)) {
    last = match[1]!;
  }
  if (last !== null) return { answer: last, usedFallback: false };

  const nonEmptyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmptyLines.length === 0) return { answer: null, usedFallback: false };
  return { answer: nonEmptyLines[nonEmptyLines.length - 1]!, usedFallback: true };
}

/**
 * Normalize a value for exact-match comparison: trim, lowercase, collapse
 * internal whitespace, then repeatedly strip trailing `.`/`!`/`?` and
 * surrounding quotes until the value is stable.
 */
export function normalize(value: string): string {
  let out = value.trim().toLowerCase();
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(/\s+/g, " ").trim();
    out = out.replace(/[.!?]+$/u, "");
    out = out.replace(/^["'`]+/u, "").replace(/["'`]+$/u, "");
    if (out === before) break;
  }
  return out.trim();
}

/** Score one run against its task gold via normalized exact match. */
export function scoreRun(run: ScoreableRun, task: TaskSpec): ScoreResult {
  const text = typeof run === "string" ? run : run.finalText;
  const { answer, usedFallback } = extractAnswer(text);
  if (answer === null) return { correct: false, extracted: null, usedFallback };
  return {
    correct: normalize(answer) === normalize(task.gold),
    extracted: answer,
    usedFallback,
  };
}
