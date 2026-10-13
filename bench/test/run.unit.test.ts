/**
 * Unit tests for the pure helpers extracted from bench/run.ts.
 * No pi spawns, no fixture generation, no filesystem access.
 */
import { describe, expect, it } from "vitest";

import {
  armOrderForRep,
  buildPiArgs,
  CSV_FIELDS,
  csvEscape,
  csvRow,
  FALLBACK_PI_CLI,
  mean,
  mungeTimestamp,
  parseArgs,
  planCounts,
  renderSummary,
  resolvePiBinary,
  runRecordToCsvRow,
  stddev,
  summarize,
  UsageError,
} from "../run.ts";
import type { RunRecord, SummaryInfo } from "../run.ts";

/** Build a fully-populated RunRecord with benign defaults + overrides. */
function rec(overrides: Partial<RunRecord> & Pick<RunRecord, "arm" | "suite">): RunRecord {
  return {
    runId: "r1",
    ts: "2026-10-13T00:00:00.000Z",
    taskId: "fact-qa-x",
    rep: 0,
    order: 0,
    model: "m",
    thinking: "off",
    exitCode: 0,
    signal: null,
    timedOut: false,
    stopReason: "stop",
    correct: true,
    extracted: "42 ms",
    usedFallback: false,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
    modelCalls: 1,
    rounds: 1,
    wallMs: 1000,
    finalTextChars: 50,
    prompt: "p",
    argv: ["-p", "p"],
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("applies defaults to an empty argv", () => {
    const o = parseArgs([]);
    expect(o.size).toBe("S");
    expect(o.reps).toBe(3);
    expect(o.model).toBe("zai/glm-5.3-flash");
    expect(o.thinking).toBe("off");
    expect(o.k).toBe(8);
    expect(o.suites).toEqual(["fact-qa", "multi-hop"]);
    expect(o.armsMode).toBe("both");
    expect(o.arms).toEqual(["standard", "okf-god"]);
    expect(o.seed).toBe(42);
    expect(o.outDir).toBeNull();
    expect(o.timeoutMs).toBe(180_000);
    expect(o.piFlag).toBe("pi");
    expect(o.yes).toBe(false);
    expect(o.dryRun).toBe(false);
  });

  it("parses --flag value and --flag=value, canonicalizes suites, resolves arms", () => {
    const o = parseArgs([
      "--size",
      "m",
      "--reps=2",
      "--tasks",
      "multi-hop, fact-qa",
      "--arms",
      "standard",
      "--out",
      "/tmp/x",
      "--timeout-ms",
      "5000",
      "--pi",
      "/usr/local/bin/pi",
      "--model",
      "openai/gpt-5",
      "--thinking",
      "minimal",
      "--k",
      "3",
      "--seed",
      "7",
      "--yes",
    ]);
    expect(o.size).toBe("M");
    expect(o.reps).toBe(2);
    expect(o.suites).toEqual(["fact-qa", "multi-hop"]);
    expect(o.armsMode).toBe("standard");
    expect(o.arms).toEqual(["standard"]);
    expect(o.outDir).toBe("/tmp/x");
    expect(o.timeoutMs).toBe(5000);
    expect(o.piFlag).toBe("/usr/local/bin/pi");
    expect(o.model).toBe("openai/gpt-5");
    expect(o.thinking).toBe("minimal");
    expect(o.k).toBe(3);
    expect(o.seed).toBe(7);
    expect(o.yes).toBe(true);
    expect(o.dryRun).toBe(false);
  });

  it("rejects unknown flags, missing values, and invalid enum values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["--size", "XL"])).toThrow(UsageError);
    expect(() => parseArgs(["--reps", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--k", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--tasks", "fact-qa,bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["--arms", "neither"])).toThrow(UsageError);
    expect(() => parseArgs(["--k"])).toThrow(UsageError);
    expect(() => parseArgs(["--yes=1"])).toThrow(UsageError);
    expect(() => parseArgs(["positional"])).toThrow(UsageError);
  });
});

describe("resolvePiBinary", () => {
  it("finds a bare pi name on PATH", () => {
    const cmd = resolvePiBinary({
      piFlag: "pi",
      pathEnv: "/usr/bin:/usr/local/bin",
      fileExists: (p) => p === "/usr/local/bin/pi",
    });
    expect(cmd).toEqual({ file: "/usr/local/bin/pi", prefixArgs: [], isFallback: false });
  });

  it("falls back to node + installed cli.js when not on PATH", () => {
    const cmd = resolvePiBinary({
      piFlag: "pi",
      pathEnv: "/nonexistent",
      fileExists: () => false,
      nodeBinary: "/node",
    });
    expect(cmd.file).toBe("/node");
    expect(cmd.prefixArgs).toEqual([FALLBACK_PI_CLI]);
    expect(cmd.isFallback).toBe(true);
  });

  it("runs an explicit .js path via node", () => {
    const cmd = resolvePiBinary({
      piFlag: "/opt/pi/cli.js",
      pathEnv: "",
      fileExists: () => false,
      nodeBinary: "/node",
    });
    expect(cmd).toEqual({ file: "/node", prefixArgs: ["/opt/pi/cli.js"], isFallback: false });
  });

  it("uses an explicit non-js path directly and treats empty PATH as not-found", () => {
    expect(
      resolvePiBinary({ piFlag: "/opt/pi", pathEnv: undefined, fileExists: () => false }),
    ).toEqual({ file: "/opt/pi", prefixArgs: [], isFallback: false });
    const cmd = resolvePiBinary({
      piFlag: "pi",
      pathEnv: undefined,
      fileExists: () => false,
      nodeBinary: "/node",
    });
    expect(cmd.isFallback).toBe(true);
    expect(cmd.prefixArgs).toEqual([FALLBACK_PI_CLI]);
  });
});

describe("buildPiArgs", () => {
  const argOpts = {
    model: "zai/glm-5.3-flash",
    thinking: "off",
    extensionPath: "/repo/src/index.ts",
  };

  it("builds the exact standard-arm argv", () => {
    expect(buildPiArgs("standard", "PROMPT", argOpts)).toEqual([
      "-ne",
      "-ns",
      "-nc",
      "--no-session",
      "--offline",
      "--mode",
      "json",
      "--model",
      "zai/glm-5.3-flash",
      "--thinking",
      "off",
      "-p",
      "PROMPT",
    ]);
  });

  it("builds the okf-god argv with exactly the -e pair inserted; prompts stay byte-identical", () => {
    const prompt = "Using the documentation in this workspace… ANSWER: <value>";
    const std = buildPiArgs("standard", prompt, argOpts);
    const okf = buildPiArgs("okf-god", prompt, argOpts);
    const eIdx = okf.indexOf("-e");
    expect(eIdx).toBeGreaterThan(-1);
    expect(okf[eIdx + 1]).toBe("/repo/src/index.ts");
    const withoutE = [...okf.slice(0, eIdx), ...okf.slice(eIdx + 2)];
    expect(withoutE).toEqual(std);
    expect(okf).toContain("-p");
    expect(okf[okf.indexOf("-p") + 1]).toBe(prompt);
    expect(std).not.toContain("-e");
  });
});

describe("armOrderForRep", () => {
  it("alternates arms per rep and keeps single-arm modes fixed", () => {
    const both: readonly ["standard", "okf-god"] = ["standard", "okf-god"];
    expect(armOrderForRep(0, both)).toEqual(["standard", "okf-god"]);
    expect(armOrderForRep(1, both)).toEqual(["okf-god", "standard"]);
    expect(armOrderForRep(2, both)).toEqual(["standard", "okf-god"]);
    expect(armOrderForRep(3, both)).toEqual(["okf-god", "standard"]);
    expect(armOrderForRep(0, ["okf-god"])).toEqual(["okf-god"]);
    expect(armOrderForRep(1, ["standard"])).toEqual(["standard"]);
  });
});

describe("csv rendering", () => {
  it("csvEscape quotes separators and doubles embedded quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });

  it("runRecordToCsvRow emits CSV_FIELDS-width rows with header and proper quoting", () => {
    const header = csvRow(CSV_FIELDS);
    expect(header.split(",").length).toBe(CSV_FIELDS.length);
    expect(header).toContain("runId,ts,arm,suite,taskId");

    const row = runRecordToCsvRow(
      rec({ arm: "standard", suite: "fact-qa", runId: "r1", extracted: "42, maybe" }),
    );
    const fields = splitCsvLine(row);
    expect(fields.length).toBe(CSV_FIELDS.length);
    expect(fields[0]).toBe("r1");
    expect(fields[2]).toBe("standard");
    expect(fields[3]).toBe("fact-qa");
    expect(fields[12]).toBe("42, maybe"); // quoted, not split
    expect(fields[fields.length - 1]).toBe("m");
  });

  /** Minimal CSV field splitter honoring double-quote escaping (test-only). */
  function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
});

describe("mean/stddev", () => {
  it("computes arithmetic mean and sample stddev", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
    expect(mean([5])).toBe(5);
    expect(stddev([2, 4])).toBeCloseTo(Math.SQRT2, 12);
    expect(stddev([5])).toBe(0);
    expect(stddev([1, 1, 1])).toBe(0);
    expect(stddev([])).toBe(0);
  });
});

describe("summarize", () => {
  it("groups by arm x suite with counts, accuracy, and token means", () => {
    const rows = summarize([
      rec({ arm: "standard", suite: "fact-qa", runId: "a", correct: true }),
      rec({
        arm: "standard",
        suite: "fact-qa",
        runId: "b",
        correct: false,
        timedOut: true,
        exitCode: null,
        signal: "SIGTERM",
        inputTokens: 200,
        totalTokens: 250,
        wallMs: 3000,
      }),
      rec({ arm: "okf-god", suite: "fact-qa", runId: "c", inputTokens: 300, totalTokens: 400, wallMs: 2000 }),
    ]);
    expect(rows).toHaveLength(2);
    const std = rows.find((r) => r.arm === "standard")!;
    expect(std.suite).toBe("fact-qa");
    expect(std.runs).toBe(2);
    expect(std.completed).toBe(1);
    expect(std.timedOut).toBe(1);
    expect(std.accuracyMean).toBeCloseTo(0.5, 12);
    expect(std.inputTokensMean).toBe(150);
    expect(std.totalTokensMean).toBe(180); // (110 + 250) / 2
    expect(std.wallMsMean).toBe(2000);
    const okf = rows.find((r) => r.arm === "okf-god")!;
    expect(okf.runs).toBe(1);
    expect(okf.accuracyMean).toBe(1);
    expect(okf.accuracyStddev).toBe(0);
  });

  it("separates suites within the same arm", () => {
    const rows = summarize([
      rec({ arm: "standard", suite: "fact-qa", correct: true }),
      rec({ arm: "standard", suite: "multi-hop", correct: false }),
    ]);
    expect(rows.map((r) => r.suite).sort()).toEqual(["fact-qa", "multi-hop"]);
  });
});

describe("renderSummary", () => {
  const info: SummaryInfo = {
    generatedAt: "2026-10-13T00:00:00.000Z",
    model: "zai/glm-5.3-flash",
    thinking: "off",
    size: "S",
    seed: 42,
    reps: 3,
    arms: ["standard", "okf-god"],
    suites: ["fact-qa", "multi-hop"],
    totalRuns: 4,
    outDir: "/out",
  };

  it("renders the table, delta rows, and all three honesty notes", () => {
    const rows = summarize([
      rec({ arm: "standard", suite: "fact-qa", correct: true }),
      rec({ arm: "standard", suite: "multi-hop", correct: false }),
      rec({ arm: "okf-god", suite: "fact-qa", correct: true }),
      rec({ arm: "okf-god", suite: "multi-hop", correct: true }),
    ]);
    const md = renderSummary(info, rows);
    expect(md).toContain("# okf-god benchmark summary");
    expect(md).toContain("| standard | fact-qa |");
    expect(md).toContain("| okf-god | multi-hop |");
    expect(md).toContain("Two-arm delta");
    expect(md).toContain("okf-god's tool declarations are part of the treatment");
    expect(md).toContain("cost input tokens even when unused");
    expect(md).toContain("cache-cold");
    expect(md).toContain("indicative, not statistically conclusive");
  });

  it("omits the delta section when only one arm ran", () => {
    const md = renderSummary(info, summarize([rec({ arm: "standard", suite: "fact-qa" })]));
    expect(md).not.toContain("Two-arm delta");
    expect(md).toContain("indicative, not statistically conclusive");
  });
});

describe("plan helpers", () => {
  it("mungeTimestamp strips colons and dots from ISO timestamps", () => {
    expect(mungeTimestamp("2026-10-13T09:15:42.123Z")).toBe("2026-10-13T09-15-42-123Z");
    expect(mungeTimestamp("2026-10-13T09:15:42Z")).toBe("2026-10-13T09-15-42Z");
  });

  it("planCounts caps task counts at k and pool size", () => {
    expect(planCounts("S", 8)).toEqual({ concepts: 30, chains: 4, factQaUpTo: 8, multiHop: 4 });
    expect(planCounts("S", 100)).toEqual({ concepts: 30, chains: 4, factQaUpTo: 60, multiHop: 4 });
    expect(planCounts("M", 8).concepts).toBe(120);
    expect(planCounts("L", 8).concepts).toBe(500);
  });
});
