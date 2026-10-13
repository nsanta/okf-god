import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/catalog.ts";
import { searchEntries } from "../src/search.ts";

function entry(partial: Partial<CatalogEntry> & Pick<CatalogEntry, "kind" | "name">): CatalogEntry {
  return {
    description: "",
    tags: [],
    path: `/tmp/${partial.kind}/${partial.name}.md`,
    ...partial,
  };
}

describe("searchEntries", () => {
  const entries: CatalogEntry[] = [
    entry({ kind: "skill", name: "build-runner", title: "Build Runner", description: "Runs builds.", tags: ["ci", "alpha"] }),
    entry({ kind: "doc", name: "alpha-guide", title: "Guide", description: "Documents alpha usage.", tags: [] }),
    entry({ kind: "agent", name: "reviewer", title: "Reviewer", description: "Reviews code.", tags: ["quality"] }),
    entry({ kind: "skill", name: "test-helper", title: "Test Helper", description: "Helps with tests.", tags: ["vitest"] }),
  ];

  it("ranks tag matches (x3) above name matches (x2.5)", () => {
    const matches = searchEntries(entries, "alpha");
    expect(matches.length).toBe(2);
    expect(matches[0]?.entry.name).toBe("build-runner");
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("sums per-token and per-field scores", () => {
    const matches = searchEntries(entries, "test");
    const helper = matches.find((match) => match.entry.name === "test-helper");
    const vitest = matches.find((match) => match.entry.name === "test-helper");
    expect(helper).toBeDefined();
    // "test" hits name (2.5) and description (1); "vitest" token would hit tag only.
    expect(helper!.score).toBeCloseTo(3.5, 5);
    void vitest;
  });

  it("filters by kind", () => {
    const matches = searchEntries(entries, "alpha", { kind: "doc" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.kind).toBe("doc");
  });

  it("caps results at 8 by default", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      entry({ kind: "doc", name: `wide-${index}`, description: "shared needle here", tags: [] }),
    );
    expect(searchEntries(many, "shared needle")).toHaveLength(8);
  });

  it("returns nothing for a zero-token query", () => {
    expect(searchEntries(entries, "")).toEqual([]);
    expect(searchEntries(entries, "   ")).toEqual([]);
    expect(searchEntries(entries, "!!!...---")).toEqual([]);
  });
});
