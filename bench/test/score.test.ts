import { describe, expect, it } from "vitest";
import { extractAnswer, normalize, scoreRun } from "../lib/score.ts";
import type { TaskSpec } from "../lib/tasks.ts";

function task(gold: string): TaskSpec {
  return { id: "t1", suite: "fact-qa", prompt: "p", gold };
}

describe("extractAnswer", () => {
  it("takes the LAST ANSWER line when present", () => {
    expect(extractAnswer("Reasoning...\nANSWER: 42 ms").answer).toBe("42 ms");
    expect(extractAnswer("ANSWER: v1\nmiddle text\nANSWER: v2").answer).toBe("v2");
    expect(extractAnswer("ANSWER:  42 ms  ").answer).toBe("42 ms");
  });

  it("matches the case-insensitive /im contract even for lowercase tags", () => {
    expect(extractAnswer("   answer: lowercase tag")).toEqual({
      answer: "lowercase tag",
      usedFallback: false,
    });
  });

  it("is case-insensitive on the ANSWER tag but keeps the value verbatim", () => {
    const result = extractAnswer("text\nAnswer: 42 ms");
    expect(result.answer).toBe("42 ms");
    expect(result.usedFallback).toBe(false);
  });

  it("falls back to the last non-empty line when no ANSWER line exists", () => {
    const result = extractAnswer("Intro\n\nThe throughput is 42 ms.\n\n");
    expect(result).toEqual({ answer: "The throughput is 42 ms.", usedFallback: true });
  });

  it("returns null for empty or whitespace-only text without claiming fallback", () => {
    expect(extractAnswer("")).toEqual({ answer: null, usedFallback: false });
    expect(extractAnswer("  \n  \t ")).toEqual({ answer: null, usedFallback: false });
  });
});

describe("normalize", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalize("  42   MS \n")).toBe("42 ms");
    expect(normalize("The\tValue")).toBe("the value");
  });

  it("strips trailing punctuation and surrounding quotes", () => {
    expect(normalize("42 ms.")).toBe("42 ms");
    expect(normalize("v9.2!")).toBe("v9.2");
    expect(normalize('"42 ms"')).toBe("42 ms");
    expect(normalize("'8080?'")).toBe("8080");
  });

  it("is idempotent on already-normal values", () => {
    for (const value of ["42 ms", "v3.7", "99.9%", "16 shards"]) {
      expect(normalize(normalize(value))).toBe(normalize(value));
    }
  });
});

describe("scoreRun", () => {
  it("grades an exact ANSWER line as correct", () => {
    const result = scoreRun("Found it.\nANSWER: 42 ms", task("42 ms"));
    expect(result).toEqual({ correct: true, extracted: "42 ms", usedFallback: false });
  });

  it("grades through normalization (case, spacing, punctuation, quotes)", () => {
    expect(scoreRun("ANSWER: \"42  MS.\"", task("42 ms")).correct).toBe(true);
  });

  it("grades wrong values and fallback answers as incorrect", () => {
    expect(scoreRun("ANSWER: 128 ms", task("42 ms")).correct).toBe(false);
    const fallback = scoreRun("The value is 128 ms somewhere.", task("42 ms"));
    expect(fallback).toEqual({ correct: false, extracted: "The value is 128 ms somewhere.", usedFallback: true });
  });

  it("grades empty output as incorrect with no extraction", () => {
    expect(scoreRun("", task("42 ms"))).toEqual({ correct: false, extracted: null, usedFallback: false });
  });

  it("accepts a run object with finalText as well as a bare string", () => {
    expect(scoreRun({ finalText: "ANSWER: v3.7" }, task("v3.7")).correct).toBe(true);
  });
});
