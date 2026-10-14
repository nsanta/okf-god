import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanCatalog, type CatalogKind, type CatalogRoots } from "../src/catalog.ts";
import { buildLinkGraph, extractLinks } from "../src/graph.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-graph-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(FIXTURES, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Each graph test scans its own bundle subdirectory so fixtures stay isolated. */
async function buildBundle(name: string) {
  const root = join(FIXTURES, name);
  const roots: Record<CatalogKind, string[]> = { skill: [], doc: [root], agent: [] };
  const entries = await scanCatalog(roots);
  const graph = await buildLinkGraph(entries, { roots });
  return { root, graph };
}

describe("extractLinks", () => {
  it("keeps only .md targets, skipping URLs, mailto, and pure anchors", () => {
    const body = [
      "See [customers](/tables/customers.md) and [other](./other.md).",
      "External: [site](https://example.com/x.md) stays out.",
      "Mail: [me](mailto:a@b.com) and [anchor](#section) too.",
      "Non-md: [pic](img.png) and [doc](notes.txt).",
    ].join("\n");
    expect(extractLinks(body)).toEqual(["/tables/customers.md", "./other.md"]);
  });

  it("dedupes while preserving first-seen order", () => {
    const body = "[b](./b.md) then [a](/a.md) then [b again](./b.md)";
    expect(extractLinks(body)).toEqual(["./b.md", "/a.md"]);
  });

  it("returns nothing for link-free or empty bodies", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("plain prose, no links at all")).toEqual([]);
  });
});

describe("link graph resolution", () => {
  it("resolves bundle-relative /x.md against the entry's root, and relative targets against the source directory", async () => {
    write("resolve/tables/orders.md", "---\ntype: BigQuery Table\n---\nSee [customers](/tables/customers.md) and [notes](./notes.md).\n");
    write("resolve/tables/customers.md", "---\ntype: BigQuery Table\n---\nBack to [orders](/tables/orders.md).\n");
    write("resolve/tables/notes.md", "---\ntype: Reference\n---\nNeighbor.\n");
    // deep/relative.md uses ../ to climb back to the root.
    write("resolve/deep/relative.md", "---\ntype: Reference\n---\nClimb to [customers](../tables/customers.md).\n");

    const { root, graph } = await buildBundle("resolve");
    const orders = join(root, "tables/orders.md");
    const customers = join(root, "tables/customers.md");
    const notes = join(root, "tables/notes.md");

    const out = graph.outgoing(orders);
    expect(out).toHaveLength(2);
    expect(out.map((edge) => edge.entry?.path).sort()).toEqual([customers, notes].sort());
    expect(out.every((edge) => !edge.broken)).toBe(true);

    // Backlinks: orders points at customers, so customers sees orders.
    const back = graph.backlinks(customers);
    expect(back.map((edge) => edge.sourcePath)).toContain(orders);

    // Relative ../ resolution.
    const relOut = graph.outgoing(join(root, "deep/relative.md"));
    expect(relOut).toHaveLength(1);
    expect(relOut[0]?.entry?.path).toBe(customers);
    expect(relOut[0]?.broken).toBe(false);

    // Neighbors: both directions, deduped.
    const neighbors = graph.neighbors(orders);
    const paths = neighbors.map((entry) => entry.path).sort();
    expect(paths).toEqual([customers, notes].sort());
  });

  it("tolerates broken links (§6.1) and counts them in stats", async () => {
    write("broken/broken.md", "---\ntype: Reference\n---\nDangling [ghost](/nowhere/ghost.md) and [sibling](./missing.md).\n");
    write("broken/tables/customers.md", "---\ntype: BigQuery Table\n---\n");

    const { root, graph } = await buildBundle("broken");
    const out = graph.outgoing(join(root, "broken.md"));
    expect(out).toHaveLength(2);
    expect(out.every((edge) => edge.broken)).toBe(true);
    expect(out[0]?.entry).toBeUndefined();

    const stats = graph.graphStats();
    expect(stats.broken).toBe(2);
    expect(stats.nodes).toBeGreaterThan(0);
    expect(stats.edges).toBe(2);
  });
});

describe("toMermaid", () => {
  it("caps nodes and ranks by degree (highest first), with stable output", async () => {
    // hub.md links to many leaves; every leaf backlinks hub.
    const leafCount = 8;
    const links = Array.from({ length: leafCount }, (_, i) => `[leaf${i}](./leaves/leaf${i}.md)`).join(" ");
    write("mermaid/hub.md", `---\ntype: Reference\n---\n${links}\n`);
    for (let i = 0; i < leafCount; i++) {
      write(`mermaid/leaves/leaf${i}.md`, `---\ntype: Reference\n---\nBack to [hub](../hub.md).\n`);
    }
    // Isolated node: no links at all.
    write("mermaid/isolated.md", "---\ntype: Reference\n---\nNothing here.\n");

    const { graph } = await buildBundle("mermaid");
    const mermaid = graph.toMermaid(4);
    const lines = mermaid.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    const nodeLines = lines.filter((line) => /n\d+\["/.test(line));
    expect(nodeLines).toHaveLength(4);
    // hub has the highest degree (8 out + 8 in), so it must be the first node.
    expect(nodeLines[0]).toContain("hub");
    // Edges only between selected nodes (n0..n3); edges to unselected leaves are dropped.
    const edgeLines = lines.filter((line) => line.includes("-->"));
    expect(edgeLines.length).toBe(6); // hub→leaf0/1/2 and leaf0/1/2→hub
    for (const line of edgeLines) {
      expect(line).toMatch(/n[0-3] --> n[0-3]/);
    }
    // Deterministic across calls.
    expect(graph.toMermaid(4)).toBe(mermaid);
  });

  it("renders an empty graph without throwing", async () => {
    write("empty/empty.md", "---\ntype: Reference\n---\nNo links.\n");
    const { graph } = await buildBundle("empty");
    expect(graph.toMermaid()).toMatch(/flowchart LR/);
  });

  it("nodes() lists every catalog entry with stable content", async () => {
    write("nodes-view/a.md", "---\ntype: Reference\n---\nSee [hub](./hub.md).\n");
    write("nodes-view/hub.md", "---\ntype: Reference\n---\n");
    const { root, graph } = await buildBundle("nodes-view");
    const paths = graph.nodes().map((entry) => entry.path).sort();
    expect(paths).toEqual([join(root, "a.md"), join(root, "hub.md")].sort());
    expect(graph.nodes()).toEqual(graph.nodes());
  });
});
