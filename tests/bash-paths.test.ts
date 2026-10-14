import { describe, expect, it } from "vitest";
import { extractCatalogPaths } from "../src/bash-paths.ts";
import type { CatalogEntry } from "../src/catalog.ts";

function entry(kind: CatalogEntry["kind"], name: string, path: string): CatalogEntry {
  return { kind, name, description: "", tags: [], path };
}

const CATALOG: CatalogEntry[] = [
  entry("doc", "runbook", "/ws/docs/runbook.md"),
  entry("doc", "my doc", "/ws/docs/my doc.md"),
  entry("skill", "deploy", "/ws/skills/deploy/SKILL.md"),
  entry("agent", "reviewer", "/ws/agents/reviewer.md"),
];

// Simulates cwd-relative resolution like index.ts resolveMaybeRelative.
const resolveFromWs = (p: string): string => (p.startsWith("/") ? p : `/ws/${p}`);
const resolveIdentity = (p: string): string => p;

const paths = (command: string, resolve: (p: string) => string = resolveFromWs): string[] =>
  extractCatalogPaths(command, CATALOG, resolve).map((match) => match.path);

describe("extractCatalogPaths", () => {
  it("resolves double-quoted paths with inner spaces", () => {
    expect(paths('cat "docs/my doc.md"')).toEqual(["/ws/docs/my doc.md"]);
    expect(paths("cat 'docs/my doc.md'")).toEqual(["/ws/docs/my doc.md"]);
  });

  it("matches several catalog files from one command in catalog order", () => {
    expect(paths("cat skills/deploy/SKILL.md docs/runbook.md")).toEqual([
      "/ws/docs/runbook.md",
      "/ws/skills/deploy/SKILL.md",
    ]);
  });

  it("returns [] for denylisted non-read first verbs", () => {
    expect(paths("rm docs/runbook.md")).toEqual([]);
    expect(paths("cp docs/runbook.md /tmp/backup.md")).toEqual([]);
    expect(paths("mkdir -p docs/new")).toEqual([]);
    expect(paths("tee docs/runbook.md")).toEqual([]);
  });

  it("ignores non-catalog paths and variable tokens", () => {
    expect(paths("cat docs/unknown.md")).toEqual([]);
    expect(paths("cat $FILE")).toEqual([]);
    expect(paths("cat ${FILE}")).toEqual([]);
    expect(paths("cat")).toEqual([]);
  });

  it("uses the injected resolver for relative paths", () => {
    // A relative token only matches once the injected resolver maps it onto
    // the catalog's absolute entry paths.
    expect(paths("cat docs/runbook.md", resolveIdentity)).toEqual([]);
    expect(paths("cat docs/runbook.md")).toEqual(["/ws/docs/runbook.md"]);
    // Absolute paths pass through the resolver unchanged.
    expect(paths("cat /ws/docs/runbook.md", resolveIdentity)).toEqual(["/ws/docs/runbook.md"]);
  });

  it("deduplicates repeated paths preserving catalog order", () => {
    expect(paths("cat docs/runbook.md skills/deploy/SKILL.md docs/runbook.md")).toEqual([
      "/ws/docs/runbook.md",
      "/ws/skills/deploy/SKILL.md",
    ]);
  });

  it("strips leading env assignments before checking the first verb", () => {
    expect(paths("FOO=1 cat docs/runbook.md")).toEqual(["/ws/docs/runbook.md"]);
    expect(paths("FOO=1 BAR=2 rm docs/runbook.md")).toEqual([]);
    expect(paths("FOO=1 cat docs/runbook.md BAR=2 docs/agents/reviewer.md")).toEqual(["/ws/docs/runbook.md"]);
  });

  it("splits on shell operators and newlines", () => {
    expect(paths("echo hi && cat docs/runbook.md")).toEqual(["/ws/docs/runbook.md"]);
    expect(paths("grep pattern docs/runbook.md | wc -l")).toEqual(["/ws/docs/runbook.md"]);
    expect(paths("cat docs/runbook.md; cat skills/deploy/SKILL.md")).toEqual([
      "/ws/docs/runbook.md",
      "/ws/skills/deploy/SKILL.md",
    ]);
    expect(paths("cat docs/runbook.md\ncat /ws/agents/reviewer.md")).toEqual([
      "/ws/docs/runbook.md",
      "/ws/agents/reviewer.md",
    ]);
  });

  it("matches exact entry.path only (no substring or case-insensitive matching)", () => {
    expect(paths("cat docs/runbook.md.bak")).toEqual([]);
    expect(paths("cat /ws/docs/runbook.MD", resolveIdentity)).toEqual([]);
  });

  it("treats only path-like tokens (slash or .md suffix) as candidates", () => {
    const catalog = [entry("doc", "readme", "/ws/README")];
    // Bare word without slash or .md suffix is ignored even on an exact match.
    expect(extractCatalogPaths("cat README", catalog, resolveIdentity)).toEqual([]);
    expect(extractCatalogPaths("cat /ws/README", catalog, resolveIdentity).map((e) => e.path)).toEqual([
      "/ws/README",
    ]);
  });
});
