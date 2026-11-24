import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/catalog.ts";
import { searchEntries } from "../src/search.ts";

function entry(partial: Partial<CatalogEntry> & Pick<CatalogEntry, "kind" | "name">): CatalogEntry {
  return {
    description: "",
    tags: [],
    path: `/tmp/${partial.kind}/${partial.name}.html`,
    ...partial,
  };
}

describe("searchEntries: OKF-HTML heading terms", () => {
  it("matches h1–h6 text with prefix semantics at the section weight (×1)", () => {
    const target = entry({
      kind: "doc",
      name: "target",
      headings: ["Install Guide", "Advanced usage"],
    });
    const other = entry({ kind: "doc", name: "other", description: "Unrelated prose." });

    // "install" is a prefix of the "install" token in "Install Guide".
    expect(searchEntries([target, other], "install")[0]?.entry.name).toBe("target");
    expect(searchEntries([target, other], "install")[0]?.score).toBeCloseTo(1, 5);
    // "advanced" hits a full heading token; "usage" hits via prefix.
    expect(searchEntries([target, other], "advanced")[0]?.score).toBeCloseTo(1, 5);
    expect(searchEntries([target, other], "usage")[0]?.score).toBeCloseTo(1, 5);
    expect(searchEntries([target, other], "nothing-matches")).toHaveLength(0);
  });

  it("suppresses exact-word heading hits when an identity field claims the token", () => {
    const claimed = entry({
      kind: "doc",
      name: "claimed",
      tags: ["test"],
      headings: ["test runner setup"],
    });
    // "test": tag hit (×3) claims the token; heading has no partial (inflected)
    // token, so its exact-word hit is suppressed -> total 3.
    expect(searchEntries([claimed], "test")[0]?.score).toBeCloseTo(3, 5);
    // "runner": no identity claim, heading contributes ×1.
    expect(searchEntries([claimed], "runner")[0]?.score).toBeCloseTo(1, 5);
    // "testing": heading token "test" is a prefix match for the query? No —
    // the query is the prefix: "testing".startsWith? tokens must start with
    // the query token, so "testing" matches nothing here.
    expect(searchEntries([claimed], "testing")).toHaveLength(0);
  });

  it("lets one token hit directory section and headings separately (sums)", () => {
    const both = entry({
      kind: "doc",
      name: "both",
      section: "guides",
      headings: ["Guides overview"],
    });
    expect(searchEntries([both], "guides")[0]?.score).toBeCloseTo(2, 5);
  });

  it("tolerates missing or empty headings", () => {
    const plain = entry({ kind: "doc", name: "plain", description: "Plain doc." });
    // Name hit only (×2.5): no headings, no extra contribution.
    expect(searchEntries([plain], "plain")[0]?.score).toBeCloseTo(2.5, 5);
    const empty = entry({
      kind: "doc",
      name: "empty",
      headings: [],
      description: "Empty headings.",
    });
    expect(searchEntries([empty], "empty")[0]?.score).toBeCloseTo(2.5, 5);
    expect(searchEntries([plain, empty], "")).toEqual([]);
  });
});
