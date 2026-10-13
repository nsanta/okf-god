/**
 * okf-god benchmark runner (wave B): drives `pi` headlessly over a synthetic
 * OKF fixture and compares the `standard` arm (default pi tools) against the
 * `okf-god` arm (extension loaded) using byte-identical prompts.
 *
 * Usage:
 *   node --experimental-strip-types bench/run.ts                 # print the plan, exit 0
 *   node --experimental-strip-types bench/run.ts --dry-run \
 *        --out /tmp/okf-bench-dry                                # + fixture/tasks into --out
 *   node --experimental-strip-types bench/run.ts --yes           # live run (real API tokens)
 *
 * Verified pi contract (pi 1.2.0; see bench/README.md):
 * - Base flags BOTH arms: -ne -ns -nc --no-session --offline --mode json
 *   --model <id> --thinking <lvl> -p <prompt>; the okf-god arm adds
 *   -e <repoRoot>/src/index.ts.
 * - Spawn cwd is the fixture workspace; stdin is ignored (a held-open stdin
 *   blocks pi). pi has no timeout flag, so the harness SIGTERMs after
 *   --timeout-ms (SIGKILL escalation) and records the run as timedOut.
 * - Exit 0 = success; 1 = error/aborted/length, where stdout may still carry
 *   partial events. Every run is parsed (parseEventStream) and scored
 *   (scoreRun) from whatever stdout was produced; exitCode and stopReason are
 *   recorded either way.
 *
 * Outputs under --out: raw.jsonl (one record per run, flushed per run so
 * partial results survive a crash), raw.csv (same data, quoted), summary.md
 * (per arm x suite stats, two-arm delta table, honesty notes), plan.json
 * (resolved matrix), tasks.json (prompts + golds), workspace/ (fixture kept
 * for inspection).
 *
 * Zero new dependencies: node:child_process, node:fs, node:fs/promises,
 * node:path, node:url, and hand-parsed process.argv. Must stay
 * `--experimental-strip-types` safe: no enums, no parameter properties,
 * `import type` for type-only imports.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chainCountFor, generateFixture, SIZE_CONCEPTS } from "./lib/fixtures.ts";
import { buildTasks } from "./lib/tasks.ts";
import { scoreRun } from "./lib/score.ts";
import { parseEventStream } from "./lib/usage.ts";
import type { FixtureSize } from "./lib/fixtures.ts";
import type { Suite, TaskSpec } from "./lib/tasks.ts";

/** Repo root: parent of bench/ (this file lives at <repo>/bench/run.ts). */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Installed pi cli.js used when `pi` is not on PATH (invoked via node). */
export const FALLBACK_PI_CLI =
  "/home/nicolas/.local/share/mise/installs/node/22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

export type Arm = "standard" | "okf-god";
export type ArmsMode = "both" | "standard" | "okf-god";

const ALL_SUITES: Suite[] = ["fact-qa", "multi-hop"];

export const DEFAULTS = {
  size: "S" as FixtureSize,
  reps: 3,
  model: "zai/glm-5.3-flash",
  thinking: "off",
  k: 8,
  armsMode: "both" as ArmsMode,
  seed: 42,
  timeoutMs: 180_000,
  piFlag: "pi",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for bench/test/run.unit.test.ts; no pi spawns here).
// ---------------------------------------------------------------------------

export interface PiCommand {
  /** Executable to spawn (absolute path, or a bare name left to PATH). */
  file: string;
  /** Arguments inserted before pi's own argv (cli.js path when run via node). */
  prefixArgs: string[];
  /** True when this is the hardcoded installed-cli.js fallback. */
  isFallback: boolean;
}

/**
 * Resolve how to invoke pi.
 * - Explicit path containing "/": used directly, or via node when it ends in .js.
 * - Bare name (default "pi"): searched on `pathEnv`; if not found, the
 *   hardcoded installed cli.js is used via node.
 * `fileExists` is injected for testability; `nodeBinary` defaults to process.execPath.
 */
export function resolvePiBinary(opts: {
  piFlag: string;
  pathEnv: string | undefined;
  fileExists: (path: string) => boolean;
  nodeBinary?: string;
}): PiCommand {
  const node = opts.nodeBinary ?? process.execPath;
  if (opts.piFlag.includes("/")) {
    if (opts.piFlag.endsWith(".js")) {
      return { file: node, prefixArgs: [opts.piFlag], isFallback: false };
    }
    return { file: opts.piFlag, prefixArgs: [], isFallback: false };
  }
  const dirs = (opts.pathEnv ?? "").split(":").filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, opts.piFlag);
    if (opts.fileExists(candidate)) {
      return { file: candidate, prefixArgs: [], isFallback: false };
    }
  }
  return { file: node, prefixArgs: [FALLBACK_PI_CLI], isFallback: true };
}

export interface PiArgOptions {
  model: string;
  thinking: string;
  extensionPath: string;
}

/**
 * Exact pi argv for one arm. Base hygiene flags are shared by BOTH arms; the
 * okf-god arm inserts the extension pair (`-e <path>`). The prompt is passed
 * through unchanged, so callers guarantee byte-identical prompts across arms.
 */
export function buildPiArgs(arm: Arm, prompt: string, opts: PiArgOptions): string[] {
  const args: string[] = ["-ne", "-ns", "-nc", "--no-session", "--offline"];
  if (arm === "okf-god") {
    args.push("-e", opts.extensionPath);
  }
  args.push(
    "--mode",
    "json",
    "--model",
    opts.model,
    "--thinking",
    opts.thinking,
    "-p",
    prompt,
  );
  return args;
}

/**
 * Arm execution order for one rep: even reps run standard first, odd reps run
 * okf-god first, cancelling order effects. Single-arm modes keep their order.
 */
export function armOrderForRep(rep: number, arms: readonly Arm[]): Arm[] {
  if (arms.length <= 1) return [...arms];
  const first = arms[0]!;
  const second = arms[1]!;
  return rep % 2 === 0 ? [first, second] : [second, first];
}

/** Directory-name-safe timestamp: colons and dots become dashes. */
export function mungeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Plan counts computable without generating the fixture (fact-qa is an upper bound). */
export interface PlanCounts {
  concepts: number;
  chains: number;
  factQaUpTo: number;
  multiHop: number;
}

export function planCounts(size: FixtureSize, k: number): PlanCounts {
  const concepts = SIZE_CONCEPTS[size];
  const chains = chainCountFor(concepts);
  return {
    concepts,
    chains,
    factQaUpTo: Math.min(k, concepts * 2),
    multiHop: Math.min(k, chains),
  };
}

export function csvEscape(value: string | number | boolean | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: readonly (string | number | boolean | null)[]): string {
  return fields.map(csvEscape).join(",");
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n-1 denominator); 0 when fewer than 2 values. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** One benchmark invocation, as persisted to raw.jsonl / raw.csv. */
export interface RunRecord {
  runId: string;
  ts: string;
  arm: Arm;
  suite: Suite;
  taskId: string;
  rep: number;
  /** Position within the back-to-back pair (0 = spawned first). */
  order: number;
  model: string;
  thinking: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stopReason: string | null;
  correct: boolean;
  extracted: string | null;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  modelCalls: number;
  rounds: number;
  wallMs: number;
  finalTextChars: number;
  /** Prompt as sent; byte-identical across arms by construction, kept for audit. */
  prompt: string;
  /** Full spawn argv (including the node prefix when the cli.js fallback is used). */
  argv: string[];
}

export const CSV_FIELDS = [
  "runId",
  "ts",
  "arm",
  "suite",
  "taskId",
  "rep",
  "order",
  "exitCode",
  "signal",
  "timedOut",
  "stopReason",
  "correct",
  "extracted",
  "usedFallback",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "modelCalls",
  "rounds",
  "wallMs",
  "finalTextChars",
  "model",
] as const;

export function runRecordToCsvRow(rec: RunRecord): string {
  return csvRow([
    rec.runId,
    rec.ts,
    rec.arm,
    rec.suite,
    rec.taskId,
    rec.rep,
    rec.order,
    rec.exitCode,
    rec.signal,
    rec.timedOut,
    rec.stopReason,
    rec.correct,
    rec.extracted,
    rec.usedFallback,
    rec.inputTokens,
    rec.outputTokens,
    rec.cacheReadTokens,
    rec.cacheWriteTokens,
    rec.totalTokens,
    rec.modelCalls,
    rec.rounds,
    rec.wallMs,
    rec.finalTextChars,
    rec.model,
  ]);
}

/** Aggregated stats for one (arm x suite) cell. */
export interface CellSummary {
  arm: Arm;
  suite: Suite;
  runs: number;
  completed: number;
  timedOut: number;
  accuracyMean: number;
  accuracyStddev: number;
  inputTokensMean: number;
  inputTokensStddev: number;
  outputTokensMean: number;
  outputTokensStddev: number;
  cacheReadTokensMean: number;
  cacheReadTokensStddev: number;
  totalTokensMean: number;
  totalTokensStddev: number;
  wallMsMean: number;
}

/** Group run records by (arm, suite) and aggregate means/stddevs. */
export function summarize(records: readonly RunRecord[]): CellSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const rec of records) {
    const key = `${rec.arm}|${rec.suite}`;
    const list = groups.get(key) ?? [];
    list.push(rec);
    groups.set(key, list);
  }
  const rows: CellSummary[] = [];
  for (const [key, list] of groups) {
    const [arm, suite] = key.split("|") as [Arm, Suite];
    const completed = list.filter((r) => !r.timedOut && r.exitCode === 0).length;
    const timedOut = list.filter((r) => r.timedOut).length;
    const correctness = list.map((r) => (r.correct ? 1 : 0));
    rows.push({
      arm,
      suite,
      runs: list.length,
      completed,
      timedOut,
      accuracyMean: mean(correctness),
      accuracyStddev: stddev(correctness),
      inputTokensMean: mean(list.map((r) => r.inputTokens)),
      inputTokensStddev: stddev(list.map((r) => r.inputTokens)),
      outputTokensMean: mean(list.map((r) => r.outputTokens)),
      outputTokensStddev: stddev(list.map((r) => r.outputTokens)),
      cacheReadTokensMean: mean(list.map((r) => r.cacheReadTokens)),
      cacheReadTokensStddev: stddev(list.map((r) => r.cacheReadTokens)),
      totalTokensMean: mean(list.map((r) => r.totalTokens)),
      totalTokensStddev: stddev(list.map((r) => r.totalTokens)),
      wallMsMean: mean(list.map((r) => r.wallMs)),
    });
  }
  rows.sort((a, b) => a.arm.localeCompare(b.arm) || a.suite.localeCompare(b.suite));
  return rows;
}

export interface SummaryInfo {
  generatedAt: string;
  model: string;
  thinking: string;
  size: FixtureSize;
  seed: number;
  reps: number;
  arms: Arm[];
  suites: Suite[];
  totalRuns: number;
  outDir: string;
}

function fmtPair(m: number, sd: number, digits: number): string {
  return `${m.toFixed(digits)} ± ${sd.toFixed(digits)}`;
}

function fmtTokens(m: number, sd: number): string {
  return `${Math.round(m)} ± ${Math.round(sd)}`;
}

function fmtDelta(v: number, digits: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

/** Render summary.md: per arm x suite table, two-arm deltas, honesty notes. */
export function renderSummary(info: SummaryInfo, rows: readonly CellSummary[]): string {
  const lines: string[] = [];
  lines.push("# okf-god benchmark summary", "");
  lines.push(`- Generated: ${info.generatedAt}`);
  lines.push(`- Model: \`${info.model}\` (thinking: ${info.thinking})`);
  lines.push(`- Fixture: ${info.size}, seed ${info.seed} (kept under \`workspace/\`)`);
  lines.push(`- Reps per (arm, task): ${info.reps}; arm order alternates per rep`);
  lines.push(`- Runs recorded: ${info.totalRuns} (raw data: \`raw.jsonl\` / \`raw.csv\` here)`);
  lines.push("");
  lines.push("## Per arm × suite", "");
  lines.push(
    "| Arm | Suite | Runs | Completed | Timed out | Accuracy | Input tok | Output tok | CacheRead tok | Total tok | Wall ms (mean) |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    lines.push(
      `| ${r.arm} | ${r.suite} | ${r.runs} | ${r.completed} | ${r.timedOut} | ` +
        `${fmtPair(r.accuracyMean, r.accuracyStddev, 3)} | ` +
        `${fmtTokens(r.inputTokensMean, r.inputTokensStddev)} | ` +
        `${fmtTokens(r.outputTokensMean, r.outputTokensStddev)} | ` +
        `${fmtTokens(r.cacheReadTokensMean, r.cacheReadTokensStddev)} | ` +
        `${fmtTokens(r.totalTokensMean, r.totalTokensStddev)} | ` +
        `${Math.round(r.wallMsMean)} |`,
    );
  }
  lines.push("");

  const byKey = new Map(rows.map((r) => [`${r.arm}|${r.suite}` as const, r]));
  const sharedSuites = info.suites.filter(
    (s) => byKey.has(`standard|${s}`) && byKey.has(`okf-god|${s}`),
  );
  if (sharedSuites.length > 0) {
    lines.push("## Two-arm delta (okf-god − standard, per suite)", "");
    lines.push(
      "| Suite | Accuracy | Input tok | Output tok | CacheRead tok | Total tok | Wall ms |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const suite of sharedSuites) {
      const std = byKey.get(`standard|${suite}`)!;
      const okf = byKey.get(`okf-god|${suite}`)!;
      lines.push(
        `| ${suite} | ${fmtDelta(okf.accuracyMean - std.accuracyMean, 3)} | ` +
          `${fmtDelta(okf.inputTokensMean - std.inputTokensMean, 0)} | ` +
          `${fmtDelta(okf.outputTokensMean - std.outputTokensMean, 0)} | ` +
          `${fmtDelta(okf.cacheReadTokensMean - std.cacheReadTokensMean, 0)} | ` +
          `${fmtDelta(okf.totalTokensMean - std.totalTokensMean, 0)} | ` +
          `${fmtDelta(okf.wallMsMean - std.wallMsMean, 0)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Honesty notes", "");
  lines.push(
    "- okf-god's tool declarations are part of the treatment and cost input tokens even when unused.",
  );
  lines.push("- `--no-session` keeps both arms cache-cold.");
  lines.push("- Small N — treat numbers as indicative, not statistically conclusive.");
  lines.push("");
  return lines.join("\n");
}

export interface PlanInfo {
  size: FixtureSize;
  seed: number;
  k: number;
  reps: number;
  suites: Suite[];
  armsMode: ArmsMode;
  arms: Arm[];
  model: string;
  thinking: string;
  timeoutMs: number;
  outDir: string;
  pi: PiCommand;
  extensionPath: string;
  concepts: number;
  chains: number;
  factQa: number;
  multiHop: number;
  /** True after fixture generation (exact task counts); false for pre-run estimates. */
  countsExact: boolean;
}

/** Render the human-readable execution plan (printed on stdout). */
export function renderPlan(info: PlanInfo): string {
  const tasks = info.factQa + info.multiHop;
  const cells = tasks * info.reps * info.arms.length;
  const maybe = info.countsExact ? "" : "up to ";
  const piLabel = info.pi.isFallback
    ? `node ${info.pi.prefixArgs.join(" ")} (fallback: "pi" not found on PATH)`
    : info.pi.file;
  const lines = [
    "okf-god benchmark — execution plan",
    `  fixture:   ${info.size} — ${info.concepts} concepts, ${info.chains} chains (seed ${info.seed})`,
    `  suites:    ${info.suites.join(", ")}`,
    `  tasks:     ${maybe}${info.factQa} fact-qa + ${info.multiHop} multi-hop = ${maybe}${tasks} (k=${info.k})`,
    `  reps:      ${info.reps} per (arm, task); arm order alternates per rep to cancel order effects`,
    `  cells:     ${maybe}${info.arms.length} arms × ${tasks} tasks × ${info.reps} reps = ${maybe}${cells} pi invocations`,
    `  arms:      ${info.armsMode} (${info.arms.join(", ")})`,
    `  model:     ${info.model} (thinking: ${info.thinking})`,
    `  pi:        ${piLabel}`,
    `  out:       ${info.outDir}`,
    `  timeout:   ${info.timeoutMs} ms per invocation`,
    "",
    "WARNING: a live run (--yes) spends real API tokens on every invocation.",
  ];
  if (!info.countsExact) {
    lines.push("Use --dry-run to materialize fixture + tasks for exact counts, or --yes to execute.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

const USAGE = `usage: node --experimental-strip-types bench/run.ts [flags]

flags:
  --size S|M|L          fixture size (default S)
  --reps N              repetitions per (arm, task) (default 3)
  --model provider/id   model for BOTH arms (default zai/glm-5.3-flash)
  --thinking level      thinking level for BOTH arms (default off)
  --k N                 tasks per suite (default 8)
  --tasks a,b           suites: fact-qa,multi-hop (default both)
  --arms MODE           both|standard|okf-god (default both)
  --seed N              fixture/task seed (default 42)
  --out DIR             output directory (default bench/results/<timestamp>)
  --timeout-ms N        per-invocation kill timeout (default 180000)
  --pi PATH             pi binary or cli.js (default: pi on PATH, else installed cli.js via node)
  --yes                 execute the plan (spends real API tokens)
  --dry-run             validate + generate fixture/tasks into --out, then exit (never spawns pi)`;

function fail(message: string): never {
  throw new UsageError(`usage error: ${message}\n\n${USAGE}`);
}

const VALUE_FLAGS = new Set([
  "size",
  "reps",
  "model",
  "thinking",
  "k",
  "tasks",
  "arms",
  "seed",
  "out",
  "timeout-ms",
  "pi",
]);
const BOOLEAN_FLAGS = new Set(["yes", "dry-run"]);

export interface Options {
  size: FixtureSize;
  reps: number;
  model: string;
  thinking: string;
  k: number;
  suites: Suite[];
  armsMode: ArmsMode;
  arms: Arm[];
  seed: number;
  outDir: string | null;
  timeoutMs: number;
  piFlag: string;
  yes: boolean;
  dryRun: boolean;
}

function parseIntOpt(raw: string, flag: string, min: number): number {
  if (raw.trim().length === 0) fail(`${flag} requires an integer value`);
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`${flag} requires an integer, got "${raw}"`);
  if (n < min) fail(`${flag} must be >= ${min}, got ${n}`);
  return n;
}

function parseSize(raw: string): FixtureSize {
  const upper = raw.trim().toUpperCase();
  if (upper !== "S" && upper !== "M" && upper !== "L") {
    fail(`--size accepts S, M, or L (got "${raw}")`);
  }
  return upper;
}

function parseSuites(raw: string | undefined): Suite[] {
  if (raw === undefined) return [...ALL_SUITES];
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) fail(`--tasks needs at least one suite (${ALL_SUITES.join(", ")})`);
  for (const part of parts) {
    if (!ALL_SUITES.includes(part as Suite)) {
      fail(`--tasks accepts: ${ALL_SUITES.join(", ")} (got "${part}")`);
    }
  }
  // Canonical order regardless of how the user listed them.
  return ALL_SUITES.filter((s) => parts.includes(s));
}

function parseArmsMode(raw: string | undefined): ArmsMode {
  const v = (raw ?? DEFAULTS.armsMode).trim().toLowerCase();
  if (v === "both" || v === "standard" || v === "okf-god") return v;
  return fail(`--arms accepts both, standard, or okf-god (got "${raw}")`);
}

/** Hand-parse argv into Options; supports `--flag value` and `--flag=value`. */
export function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg === "--") fail(`unexpected argument "${arg}"`);
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const name = body.slice(0, eq);
      if (BOOLEAN_FLAGS.has(name)) fail(`--${name} takes no value`);
      if (!VALUE_FLAGS.has(name)) fail(`unknown flag --${name}`);
      values.set(name, body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      booleans.add(body);
      continue;
    }
    if (!VALUE_FLAGS.has(body)) fail(`unknown flag --${body}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${body} requires a value`);
    values.set(body, next);
    i += 1;
  }

  const armsMode = parseArmsMode(values.get("arms"));
  const arms: Arm[] = armsMode === "both" ? ["standard", "okf-god"] : [armsMode];

  return {
    size: parseSize(values.get("size") ?? DEFAULTS.size),
    reps: parseIntOpt(values.get("reps") ?? String(DEFAULTS.reps), "--reps", 1),
    model: values.get("model") ?? DEFAULTS.model,
    thinking: values.get("thinking") ?? DEFAULTS.thinking,
    k: parseIntOpt(values.get("k") ?? String(DEFAULTS.k), "--k", 1),
    suites: parseSuites(values.get("tasks")),
    armsMode,
    arms,
    seed: parseIntOpt(values.get("seed") ?? String(DEFAULTS.seed), "--seed", -Infinity),
    outDir: values.get("out") ?? null,
    timeoutMs: parseIntOpt(
      values.get("timeout-ms") ?? String(DEFAULTS.timeoutMs),
      "--timeout-ms",
      1,
    ),
    piFlag: values.get("pi") ?? DEFAULTS.piFlag,
    yes: booleans.has("yes"),
    dryRun: booleans.has("dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Live execution
// ---------------------------------------------------------------------------

function canExecute(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function progressLine(cell: number, total: number, rec: RunRecord): string {
  const status = rec.timedOut ? "TIMEOUT" : rec.exitCode === 0 ? "ok" : `exit=${rec.exitCode}`;
  return (
    `[${cell}/${total}] ${rec.arm} ${rec.suite} rep ${rec.rep} (order ${rec.order}) ` +
    `${rec.taskId} → ${status} correct=${rec.correct} ` +
    `tokens in=${rec.inputTokens} out=${rec.outputTokens} cacheRead=${rec.cacheReadTokens} ` +
    `total=${rec.totalTokens} wall=${rec.wallMs}ms stop=${rec.stopReason ?? "-"}`
  );
}

interface RunOneOptions {
  pi: PiCommand;
  arm: Arm;
  task: TaskSpec;
  rep: number;
  order: number;
  model: string;
  thinking: string;
  extensionPath: string;
  workspaceDir: string;
  timeoutMs: number;
  setChild: (child: ChildProcess | null) => void;
}

/**
 * Spawn pi once for one (arm, task, rep), parse + score whatever stdout was
 * produced, and return the run record. stdin is ignored; on timeout the child
 * gets SIGTERM (SIGKILL escalation after 5 s) and the partial stdout is still
 * parsed and scored.
 */
async function runOne(o: RunOneOptions): Promise<RunRecord> {
  const args = buildPiArgs(o.arm, o.task.prompt, {
    model: o.model,
    thinking: o.thinking,
    extensionPath: o.extensionPath,
  });
  const argv = [...o.pi.prefixArgs, ...args];
  const startedAt = Date.now();

  const child = spawn(o.pi.file, argv, {
    cwd: o.workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  o.setChild(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  let escalationTimer: NodeJS.Timeout | null = null;
  killTimer = setTimeout(() => {
    timedOut = true;
    console.error(`  timeout after ${o.timeoutMs} ms: sending SIGTERM to pid ${child.pid ?? "?"}`);
    child.kill("SIGTERM");
    escalationTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, o.timeoutMs);

  let exitCode: number | null = null;
  let signal: string | null = null;
  let spawnError: unknown = null;
  try {
    await new Promise<void>((resolvePromise) => {
      child.on("error", (err) => {
        spawnError = err;
      });
      child.on("close", (code, sig) => {
        exitCode = code;
        signal = typeof sig === "string" ? sig : null;
        resolvePromise();
      });
    });
  } finally {
    if (killTimer !== null) clearTimeout(killTimer);
    if (escalationTimer !== null) clearTimeout(escalationTimer);
    o.setChild(null);
  }

  if (spawnError !== null) {
    const detail = spawnError instanceof Error ? spawnError.message : String(spawnError);
    throw new Error(`failed to spawn pi (${o.pi.file} ${argv.join(" ")}): ${detail}`);
  }

  const wallMs = Date.now() - startedAt;
  const stats = parseEventStream(stdout);
  const score = scoreRun(stats, o.task);
  if (stderr.trim().length > 0 && (exitCode !== 0 || timedOut)) {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    console.error(`  stderr (trimmed): ${tail}`);
  }

  return {
    runId: `${o.task.id}#rep${o.rep}#${o.arm}`,
    ts: new Date(startedAt).toISOString(),
    arm: o.arm,
    suite: o.task.suite,
    taskId: o.task.id,
    rep: o.rep,
    order: o.order,
    model: o.model,
    thinking: o.thinking,
    exitCode,
    signal,
    timedOut,
    stopReason: stats.stopReason,
    correct: score.correct,
    extracted: score.extracted,
    usedFallback: score.usedFallback,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    totalTokens: stats.totalTokens,
    modelCalls: stats.modelCalls,
    rounds: stats.rounds,
    wallMs,
    finalTextChars: stats.finalText.length,
    prompt: o.task.prompt,
    argv,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const piCmd = resolvePiBinary({
    piFlag: opts.piFlag,
    pathEnv: process.env["PATH"],
    fileExists: canExecute,
  });
  const extensionPath = join(repoRoot, "src", "index.ts");
  const outDir = resolve(
    opts.outDir ?? join(repoRoot, "bench", "results", mungeTimestamp(new Date().toISOString())),
  );

  // Plan-only mode: estimates, no filesystem writes, no pi spawn.
  if (!opts.yes && !opts.dryRun) {
    const counts = planCounts(opts.size, opts.k);
    console.log(
      renderPlan({
        size: opts.size,
        seed: opts.seed,
        k: opts.k,
        reps: opts.reps,
        suites: opts.suites,
        armsMode: opts.armsMode,
        arms: opts.arms,
        model: opts.model,
        thinking: opts.thinking,
        timeoutMs: opts.timeoutMs,
        outDir,
        pi: piCmd,
        extensionPath,
        concepts: counts.concepts,
        chains: counts.chains,
        factQa: counts.factQaUpTo,
        multiHop: counts.multiHop,
        countsExact: false,
      }),
    );
    return 0;
  }

  // Dry run / live: materialize fixture + tasks into <out>/workspace.
  const workspaceDir = join(outDir, "workspace");
  await mkdir(outDir, { recursive: true });
  const spec = generateFixture({ size: opts.size, seed: opts.seed, dir: workspaceDir });
  const allTasks = buildTasks(spec, { kPerSuite: opts.k });
  const selectedFactQa = opts.suites.includes("fact-qa") ? allTasks.factQa : [];
  const selectedMultiHop = opts.suites.includes("multi-hop") ? allTasks.multiHop : [];
  const tasks: TaskSpec[] = [...selectedFactQa, ...selectedMultiHop];
  if (tasks.length === 0) {
    console.error("fatal: no tasks selected (check --k and --tasks)");
    return 2;
  }

  const totalCells = tasks.length * opts.reps * opts.arms.length;
  const plan = {
    generatedAt: new Date().toISOString(),
    runner: "bench/run.ts",
    size: opts.size,
    seed: opts.seed,
    k: opts.k,
    reps: opts.reps,
    armsMode: opts.armsMode,
    arms: opts.arms,
    suites: opts.suites,
    model: opts.model,
    thinking: opts.thinking,
    timeoutMs: opts.timeoutMs,
    pi: piCmd,
    repoRoot,
    extensionPath,
    fixture: { dir: workspaceDir, counts: spec.counts },
    alternation: "rep % 2 === 0 → standard→okf-god, rep % 2 === 1 → okf-god→standard",
    counts: { tasks: tasks.length, cells: totalCells, piInvocations: totalCells },
    tasks: tasks.map((t) => ({ id: t.id, suite: t.suite, gold: t.gold, prompt: t.prompt })),
  };
  await writeFile(join(outDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");
  await writeFile(
    join(outDir, "tasks.json"),
    JSON.stringify({ tasks: plan.tasks }, null, 2) + "\n",
    "utf8",
  );

  const planInfo: PlanInfo = {
    size: opts.size,
    seed: opts.seed,
    k: opts.k,
    reps: opts.reps,
    suites: opts.suites,
    armsMode: opts.armsMode,
    arms: opts.arms,
    model: opts.model,
    thinking: opts.thinking,
    timeoutMs: opts.timeoutMs,
    outDir,
    pi: piCmd,
    extensionPath,
    concepts: spec.counts.concepts,
    chains: spec.counts.chains,
    factQa: selectedFactQa.length,
    multiHop: selectedMultiHop.length,
    countsExact: true,
  };

  // Dry run never spawns pi (--dry-run wins even if --yes was also passed).
  if (opts.dryRun) {
    console.log(renderPlan(planInfo));
    console.error(
      `dry run complete: fixture (${spec.counts.concepts} concepts, ` +
        `${spec.counts.chains} chains) + ${tasks.length} tasks written under ${outDir}; no pi invocation`,
    );
    return 0;
  }

  // Live preflight checks before spending any tokens.
  if (piCmd.isFallback && !existsSync(FALLBACK_PI_CLI)) {
    console.error(
      `fatal: pi not found on PATH and fallback cli missing: ${FALLBACK_PI_CLI} (pass --pi <binary|cli.js>)`,
    );
    return 2;
  }
  if (opts.arms.includes("okf-god") && !existsSync(extensionPath)) {
    console.error(
      `fatal: the okf-god arm needs the extension entry file, not found: ${extensionPath}`,
    );
    return 2;
  }

  const csvPath = join(outDir, "raw.csv");
  if (!existsSync(csvPath)) {
    await writeFile(csvPath, csvRow(CSV_FIELDS) + "\n", "utf8");
  }
  const jsonlPath = join(outDir, "raw.jsonl");

  console.error(
    `executing: ${tasks.length} tasks × ${opts.reps} reps × ${opts.arms.length} arm(s) = ` +
      `${totalCells} pi invocations (model ${opts.model}, thinking ${opts.thinking})`,
  );
  console.error("WARNING: this spends real API tokens (--yes was given).");

  const records: RunRecord[] = [];
  let interrupted = false;
  let currentChild: ChildProcess | null = null;
  let fatal: unknown = null;
  const onSigint = (): void => {
    interrupted = true;
    console.error("SIGINT received: aborting after the in-flight run…");
    currentChild?.kill("SIGTERM");
  };
  process.on("SIGINT", onSigint);

  try {
    let cell = 0;
    outer: for (const task of tasks) {
      for (let rep = 0; rep < opts.reps; rep++) {
        const order = armOrderForRep(rep, opts.arms);
        for (let pos = 0; pos < order.length; pos++) {
          cell += 1;
          const arm = order[pos]!;
          const rec = await runOne({
            pi: piCmd,
            arm,
            task,
            rep,
            order: pos,
            model: opts.model,
            thinking: opts.thinking,
            extensionPath,
            workspaceDir,
            timeoutMs: opts.timeoutMs,
            setChild: (child) => {
              currentChild = child;
            },
          });
          records.push(rec);
          // Flush per run so partial results survive a crash.
          await appendFile(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
          await appendFile(csvPath, runRecordToCsvRow(rec) + "\n", "utf8");
          console.error(progressLine(cell, totalCells, rec));
          if (interrupted) break outer;
        }
      }
    }
  } catch (err) {
    fatal = err;
  } finally {
    process.off("SIGINT", onSigint);
  }

  const summaryPath = join(outDir, "summary.md");
  await writeFile(
    summaryPath,
    renderSummary(
      {
        generatedAt: new Date().toISOString(),
        model: opts.model,
        thinking: opts.thinking,
        size: opts.size,
        seed: opts.seed,
        reps: opts.reps,
        arms: opts.arms,
        suites: opts.suites,
        totalRuns: records.length,
        outDir,
      },
      summarize(records),
    ),
    "utf8",
  );
  console.error(`wrote ${summaryPath} (${records.length} run record${records.length === 1 ? "" : "s"})`);

  if (fatal !== null) {
    console.error(`fatal: ${fatal instanceof Error ? fatal.message : String(fatal)}`);
    return 1;
  }
  if (interrupted) {
    console.error("interrupted: summary reflects partial data; exiting non-zero");
    return 130;
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
