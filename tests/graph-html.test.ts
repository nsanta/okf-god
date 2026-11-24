import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanCatalog, type CatalogKind } from "../src/catalog.ts";
import { buildLinkGraph, extractHtmlLinks } from "../src/graph.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-graph-html-"));
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

describe("extractHtmlLinks", () => {
  it("keeps anchor hrefs that are concept links, in first-seen order, deduped", () => {
    const body = [
      '<a href="pi.html">Pi</a> and <a href="./other.md">Other</a>.',
      '<a href="/pi.html">Bundle html</a> and <a href="/pi">Bundle agnostic</a>.',
      "<a HREF='quoted.html'>Upper</a><a data-x=\"1\" href=unquoted.html>Unquoted</a>",
      '<a href="pi.html">duplicate</a>',
      '<a href="pi.html#section">fragment kept like markdown</a>',
    ].join("\n");
    expect(extractHtmlLinks(body)).toEqual([
      "pi.html",
      "./other.md",
      "/pi.html",
      "/pi",
      "quoted.html",
      "unquoted.html",
      "pi.html#section",
    ]);
  });

  it("skips URLs, mailto, and pure anchors; ignores non-anchor and extension-less relative hrefs", () => {
    const body = [
      '<a href="https://example.com/pi.html">Web</a>',
      '<a href="mailto:a@b.com">Mail</a>',
      '<a href="#intro">Anchor</a>',
      '<a href="plain">ext-less relative: not a concept link</a>',
      '<a href="./also-plain">still skipped</a>',
      '<link rel="stylesheet" href="style.html">',
      '<link rel="alternate" href="/never-indexed.html">',
      '<meta name="okf:resource" content="not-a-link.html">',
      '<a name="no-href">bare anchor tag</a>',
    ].join("\n");
    expect(extractHtmlLinks(body)).toEqual([]);
  });
});

describe("html link graph resolution", () => {
  it("resolves .html/.md relative targets against the source directory", async () => {
    write(
      "reldir/deep/source.html",
      '<html><body><a href="sibling.html">Sib</a> <a href="../tables/customers.md">Cust</a></body></html>',
    );
    write("reldir/deep/sibling.html", "<p>Sibling.</p>");
    write("reldir/tables/customers.md", "---\ntype: BigQuery Table\n---\n");

    const { root, graph } = await buildBundle("reldir");
    const source = join(root, "deep/source.html");
    const out = graph.outgoing(source);
    expect(out.map((edge) => edge.entry?.path).sort()).toEqual(
      [join(root, "deep/sibling.html"), join(root, "tables/customers.md")].sort(),
    );
    expect(out.every((edge) => !edge.broken)).toBe(true);
  });

  it("resolves extension-less /name bundle-relative targets .html-first, then .md", async () => {
    // Both formats exist: .html wins.
    write("agnostic/pi.html", "<p>Html pi.</p>");
    write("agnostic/pi.md", "---\ntype: Reference\n---\nMd pi.\n");
    write("agnostic/linker.html", '<body><a href="/pi">Pi</a></body>');
    // Only .md exists: .md is found after .html misses.
    write("agnostic/md-only.md", "---\ntype: Reference\n---\n");
    write("agnostic/linker-md.html", '<body><a href="/md-only">MD only</a></body>');

    const { root, graph } = await buildBundle("agnostic");
    const htmlOut = graph.outgoing(join(root, "linker.html"));
    expect(htmlOut).toHaveLength(1);
    expect(htmlOut[0]?.entry?.path).toBe(join(root, "pi.html"));
    expect(htmlOut[0]?.broken).toBe(false);

    const mdOut = graph.outgoing(join(root, "linker-md.html"));
    expect(mdOut[0]?.entry?.path).toBe(join(root, "md-only.md"));
    expect(mdOut[0]?.broken).toBe(false);
  });

  it("resolves extension-less /name against same-kind roots when the entry root misses", async () => {
    write("cross-roots/docs-a/linker.html", '<body><a href="/target">Target</a></body>');
    write("cross-roots/docs-b/target.html", "<p>In another doc root.</p>");

    const rootA = join(FIXTURES, "cross-roots/docs-a");
    const rootB = join(FIXTURES, "cross-roots/docs-b");
    const roots: Record<CatalogKind, string[]> = { skill: [], doc: [rootA, rootB], agent: [] };
    const entries = await scanCatalog(roots);
    const graph = await buildLinkGraph(entries, { roots });

    const out = graph.outgoing(join(rootA, "linker.html"));
    expect(out[0]?.entry?.path).toBe(join(rootB, "target.html"));
    expect(out[0]?.broken).toBe(false);
  });

  it("tolerates broken html links and keeps them (§6.1)", async () => {
    write(
      "broken-html/linker.html",
      '<body><a href="/ghost">Ghost</a> <a href="missing.html">Miss</a></body>',
    );
    write("broken-html/kept.html", "<p>Kept.</p>");

    const { root, graph } = await buildBundle("broken-html");
    const out = graph.outgoing(join(root, "linker.html"));
    expect(out).toHaveLength(2);
    expect(out.every((edge) => edge.broken)).toBe(true);
    // First .html probe is kept as the (broken) target path.
    expect(out[0]?.targetPath).toBe(join(root, "ghost.html"));

    const stats = graph.graphStats();
    expect(stats.broken).toBeGreaterThanOrEqual(2);
  });
});
