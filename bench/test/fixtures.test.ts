import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../src/frontmatter.ts";
import {
  chainCountFor,
  generateFixture,
  SIZE_CONCEPTS,
  type FixtureSize,
  type FixtureSpec,
} from "../lib/fixtures.ts";

const ROOT = mkdtempSync(join(tmpdir(), "okf-bench-fixtures-"));
let counter = 0;

function freshDir(): string {
  return join(ROOT, `gen-${counter++}`);
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function snapshot(dir: string): Map<string, string> {
  const docsDir = join(dir, "docs");
  const files = new Map<string, string>();
  for (const name of readdirSync(docsDir)) {
    files.set(name, readFileSync(join(docsDir, name), "utf8"));
  }
  return files;
}

describe("generateFixture", () => {
  it("uses the agreed concept counts per size", () => {
    expect(SIZE_CONCEPTS).toEqual({ S: 30, M: 120, L: 500 });
    expect(chainCountFor(30)).toBe(4);
    expect(chainCountFor(120)).toBe(15);
    expect(chainCountFor(500)).toBe(62);
  });

  it("scales: S generates 30 concept docs plus index.md", () => {
    const dir = freshDir();
    const spec = generateFixture({ size: "S", seed: 42, dir });
    const entries = readdirSync(join(dir, "docs"));
    expect(spec.concepts).toHaveLength(30);
    expect(entries).toHaveLength(31); // 30 concepts + reserved index.md
    expect(entries.filter((name) => name.endsWith(".md")).length).toBe(31);
    expect(entries).toContain("index.md");
    expect(entries.filter((name) => name !== "index.md").every((name) => name.endsWith(".md"))).toBe(true);
    // Slugs are unique and index.md is never a concept file.
    expect(new Set(spec.concepts.map((c) => c.slug)).size).toBe(30);
    expect(spec.concepts.map((c) => `${c.slug}.md`)).not.toContain("index.md");
  });

  it("M and L scale concept and chain counts", () => {
    const m = generateFixture({ size: "M", seed: 1, dir: freshDir() });
    expect(m.concepts).toHaveLength(120);
    expect(m.chains).toHaveLength(15);
    const l = generateFixture({ size: "L", seed: 1, dir: freshDir() });
    expect(l.concepts).toHaveLength(500);
    expect(l.chains).toHaveLength(62);
    expect(l.facts).toHaveLength(500 * 2 + 62);
  });

  it("is byte-identical for the same (size, seed) and differs across seeds", () => {
    const a = generateFixture({ size: "S", seed: 42, dir: freshDir() });
    const b = generateFixture({ size: "S", seed: 42, dir: freshDir() });
    expect(snapshot(a.dir)).toEqual(snapshot(b.dir));

    const c = generateFixture({ size: "M", seed: 7, dir: freshDir() });
    const d = generateFixture({ size: "M", seed: 7, dir: freshDir() });
    expect(snapshot(c.dir)).toEqual(snapshot(d.dir));

    const otherSeed = generateFixture({ size: "S", seed: 43, dir: freshDir() });
    const aEntries = [...snapshot(a.dir).entries()].sort(([x], [y]) => x.localeCompare(y));
    const otherEntries = [...snapshot(otherSeed.dir).entries()].sort(([x], [y]) => x.localeCompare(y));
    expect(otherEntries).toHaveLength(aEntries.length); // same tree shape
    expect(aEntries).not.toEqual(otherEntries); // but different seeded content
  });

  it("writes frontmatter that src/frontmatter.ts parses (cross-check)", () => {
    const spec: FixtureSpec = generateFixture({ size: "S", seed: 42, dir: freshDir() });
    for (const concept of spec.concepts) {
      const raw = readFileSync(join(spec.dir, concept.file), "utf8");
      const parsed = parseFrontmatter(raw);
      expect(parsed.ok, `${concept.file}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.data["type"]).toBe("Reference");
      expect(typeof parsed.data["title"]).toBe("string");
      expect(typeof parsed.data["description"]).toBe("string");
      const tags = parsed.data["tags"];
      expect(Array.isArray(tags)).toBe(true);
      expect((tags as string[]).length).toBeGreaterThanOrEqual(2);
      expect((tags as string[]).length).toBeLessThanOrEqual(3);
      expect(["stable", "draft", "deprecated"]).toContain(parsed.data["status"]);
      expect(parsed.body).toContain("# Facts");
    }
    const statuses = new Set(spec.concepts.map((c) => c.status));
    expect(statuses).toEqual(new Set(["stable", "draft", "deprecated"]));
    const stableCount = spec.concepts.filter((c) => c.status === "stable").length;
    expect(stableCount).toBeGreaterThan(30 * 0.7); // "mostly stable"
  });

  it("keeps every chain A→B→C resolvable with the gold only in C", () => {
    const spec = generateFixture({ size: "M", seed: 9, dir: freshDir() });
    expect(spec.chains.length).toBeGreaterThanOrEqual(4);
    const bodyOf = (slug: string) => readFileSync(join(spec.dir, "docs", `${slug}.md`), "utf8");
    for (const chain of spec.chains) {
      const a = bodyOf(chain.aSlug);
      const b = bodyOf(chain.bSlug);
      const c = bodyOf(chain.cSlug);

      // Links resolve to real cataloged files.
      expect(a).toContain(`](./${chain.bSlug}.md)`);
      expect(b).toContain(`](./${chain.cSlug}.md)`);
      expect(readdirSync(join(spec.dir, "docs"))).toContain(`${chain.bSlug}.md`);
      expect(readdirSync(join(spec.dir, "docs"))).toContain(`${chain.cSlug}.md`);

      // A says details live in B; B says the value is recorded in C.
      expect(a).toContain(`live in [${chain.bTitle}]`);
      expect(b).toContain(`is recorded in [${chain.cTitle}]`);

      // Gold fact: stated only in C. A must not name the question at all;
      // B names it only inside its pointer sentence (never with the value).
      expect(c).toContain(chain.goldFact);
      const fragment = `The ${chain.metric} of ${chain.entity}`;
      expect(a).not.toContain(chain.goldFact);
      expect(b).not.toContain(chain.goldFact);
      expect(a).not.toContain(fragment);
      for (const bLine of b.split("\n")) {
        if (bLine.includes(fragment)) {
          expect(bLine).toContain(`is recorded in [${chain.cTitle}]`);
        }
      }

      // All three roles are catalogable .md concepts under docs/.
      for (const slug of [chain.aSlug, chain.bSlug, chain.cSlug]) {
        expect(slug).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
      }
    }
  });

  it("contains deliberately broken links and reserved index links", () => {
    const spec = generateFixture({ size: "S", seed: 42, dir: freshDir() });
    const entries = new Set(readdirSync(join(spec.dir, "docs")));
    const linkPattern = /]\(\.\/([^)]+\.md)\)/g;
    let broken = 0;
    let indexLinks = 0;
    for (const concept of spec.concepts) {
      const body = readFileSync(join(spec.dir, concept.file), "utf8");
      for (const match of body.matchAll(linkPattern)) {
        const target = match[1]!;
        if (target === "index.md") {
          indexLinks++;
          continue;
        }
        if (!entries.has(target)) broken++;
      }
    }
    expect(broken).toBeGreaterThanOrEqual(1);
    expect(indexLinks).toBeGreaterThanOrEqual(2);
    expect(indexLinks).toBeLessThanOrEqual(3);
    // index.md exists on disk and lists concepts, but is not a concept itself.
    const index = readFileSync(join(spec.dir, "docs", "index.md"), "utf8");
    expect(index).toContain("# Documentation index");
    expect(index).toContain("(./alpha-");
  });

  it("keeps (metric, entity) question keys globally unique so golds are unambiguous", () => {
    for (const size of ["S", "M"] as FixtureSize[]) {
      const spec = generateFixture({ size, seed: 5, dir: freshDir() });
      const byKey = new Map<string, string>();
      for (const fact of spec.facts) {
        const key = `${fact.metric}|${fact.entity}`;
        const previous = byKey.get(key);
        expect(previous, `duplicate question key ${key}`).toBeUndefined();
        byKey.set(key, fact.value);
      }
      expect(byKey.size).toBe(spec.facts.length);
      // Every fact sentence uses the fixed controlled phrasing.
      for (const fact of spec.facts) {
        expect(fact.sentence).toBe(`The ${fact.metric} of ${fact.entity} is ${fact.value}.`);
      }
    }
  });

  it("gives distractor concepts the same metric names with different values", () => {
    const spec = generateFixture({ size: "S", seed: 42, dir: freshDir() });
    const metrics = new Set(spec.facts.map((f) => f.metric));
    expect(metrics.size).toBeGreaterThan(1);
    for (const metric of metrics) {
      const values = new Set(spec.facts.filter((f) => f.metric === metric).map((f) => f.value));
      expect(values.size).toBeGreaterThan(1); // near-miss values exist per metric
    }
  });
});
