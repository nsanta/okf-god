import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildEntry, type CatalogEntry } from "../src/catalog.ts";
import { toAsciiGraph } from "../src/graph-ascii.ts";
import { buildLinkGraph, type LinkGraph } from "../src/graph.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-graph-ascii-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

const ROOT = join(FIXTURES, "docs");
let rooted = false;

/**
 * Hand-built doc entries over real (empty) files so LinkGraph's stat() check
 * succeeds, with a `read` override supplying the markdown bodies (established
 * pattern from tests/graph.test.ts + buildEntry, no body files on disk).
 */
async function graphFrom(defs: Array<{ name: string; body: string }>): Promise<LinkGraph> {
  if (!rooted) {
    mkdirSync(ROOT, { recursive: true });
    rooted = true;
  }
  const bodies = new Map<string, string>();
  const entries: CatalogEntry[] = defs.map(({ name, body }) => {
    const path = join(ROOT, `${name}.md`);
    writeFileSync(path, "", "utf8"); // body content comes from the read override
    bodies.set(path, body);
    return buildEntry("doc", path, ROOT, undefined, {});
  });
  return buildLinkGraph(entries, { read: (path) => Promise.resolve(bodies.get(path) ?? "") });
}

describe("toAsciiGraph", () => {
  it("is deterministic: same input twice produces the same lines", async () => {
    const graph = await graphFrom([
      { name: "hub", body: "[leaf0](./leaf0.md) [leaf1](./leaf1.md)" },
      { name: "leaf0", body: "Back to [hub](./hub.md)." },
      { name: "leaf1", body: "Back to [hub](./hub.md)." },
    ]);
    expect(toAsciiGraph(graph).lines).toEqual(toAsciiGraph(graph).lines);
  });

  it("ranks by degree desc (path asc on ties) and caps the selection", async () => {
    const graph = await graphFrom([
      { name: "hub", body: "[leaf0](./leaf0.md) [leaf1](./leaf1.md) [leaf2](./leaf2.md)" },
      { name: "leaf0", body: "Back to [hub](./hub.md)." },
      { name: "leaf1", body: "Back to [hub](./hub.md)." },
      { name: "leaf2", body: "Back to [hub](./hub.md)." },
    ]);

    // maxNodes 3: hub (degree 6) then leaf0/leaf1 (degree 2, path asc); the
    // leaf2 link is dropped because leaf2 is not selected (same as toMermaid).
    const capped = toAsciiGraph(graph, { maxNodes: 3 });
    expect(capped.lines).toEqual([
      "hub ──▶ leaf0",
      "  └─▶ leaf1",
      "leaf0 ──▶ hub",
      "leaf1 ──▶ hub",
    ]);
    expect(capped.shownNodes).toBe(3);
    expect(capped.totalNodes).toBe(4);
    expect(capped.stats).toEqual(graph.graphStats());

    // Uncapped: every node fits and all edges are drawn.
    const full = toAsciiGraph(graph);
    expect(full.shownNodes).toBe(4);
    expect(full.lines).toContain("  └─▶ leaf2");
  });

  it("marks broken targets and keeps the source document's first-seen link order", async () => {
    const graph = await graphFrom([
      // pal is linked before the dangling ghost, so pal renders first even
      // though "/nowhere/ghost.md" sorts before "pal" alphabetically.
      { name: "brk", body: "See [pal](./pal.md) and [ghost](/nowhere/ghost.md)." },
      { name: "pal", body: "" },
    ]);

    // Convention pin: pal has no outgoing edges, so it appears ONLY as a
    // target under its source — never as a separate `pal ◀─` line.
    expect(toAsciiGraph(graph).lines).toEqual([
      "brk ──▶ pal",
      "  └─▶ /nowhere/ghost.md ✗",
    ]);
  });

  it("lists isolated selected nodes under the isolated: marker in selection order", async () => {
    const graph = await graphFrom([
      { name: "alpha", body: "See [beta](./beta.md)." },
      { name: "beta", body: "" },
      { name: "gamma", body: "" },
      { name: "delta", body: "" },
    ]);

    // Isolated nodes keep selection order: degree desc, then path asc
    // (delta.md sorts before gamma.md).
    expect(toAsciiGraph(graph).lines).toEqual([
      "alpha ──▶ beta",
      "isolated:",
      "  delta",
      "  gamma",
    ]);
  });

  it("returns (empty graph) with zeroed stats for an empty catalog", async () => {
    const graph = await graphFrom([]);
    expect(toAsciiGraph(graph)).toEqual({
      lines: ["(empty graph)"],
      stats: { nodes: 0, edges: 0, broken: 0 },
      shownNodes: 0,
      totalNodes: 0,
    });
  });

  it("clamps maxNodes like toMermaid (floor, negatives to zero)", async () => {
    const graph = await graphFrom([
      { name: "hub", body: "[leaf0](./leaf0.md) [leaf1](./leaf1.md)" },
      { name: "leaf0", body: "Back to [hub](./hub.md)." },
      { name: "leaf1", body: "Back to [hub](./hub.md)." },
    ]);

    const zero = toAsciiGraph(graph, { maxNodes: -5 });
    expect(zero.shownNodes).toBe(0);
    expect(zero.lines).toEqual([]);

    // 2.9 floors to 2: hub (degree 4) and leaf0 (degree 2); hub's leaf1 edge
    // is dropped because leaf1 is not selected.
    const fractional = toAsciiGraph(graph, { maxNodes: 2.9 });
    expect(fractional.shownNodes).toBe(2);
    expect(fractional.lines).toEqual(["hub ──▶ leaf0", "leaf0 ──▶ hub"]);
  });

  it("defaults to a 12-node cap without options", async () => {
    // Zero-padded names so the lexicographic path tie-break is numeric order.
    const defs = [{ name: "center", body: Array.from({ length: 12 }, (_, i) => `[doc${String(i + 1).padStart(2, "0")}](./doc${String(i + 1).padStart(2, "0")}.md)`).join(" ") }];
    for (let i = 1; i <= 12; i++) defs.push({ name: `doc${String(i).padStart(2, "0")}`, body: "" });
    const graph = await graphFrom(defs);

    const result = toAsciiGraph(graph);
    expect(result.shownNodes).toBe(12);
    expect(result.totalNodes).toBe(13);
    // doc12 lost the degree tie-break against the cap and is not rendered.
    expect(result.lines.some((line) => line.includes("doc12"))).toBe(false);
  });
});
