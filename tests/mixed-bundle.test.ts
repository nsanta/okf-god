import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanCatalog, type CatalogKind } from "../src/catalog.ts";
import { buildLinkGraph } from "../src/graph.ts";
import { resolveCatalogEntry } from "../src/resolve.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-mixed-bundle-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(FIXTURES, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/**
 * Mixed bundle (OKF-HTML rule 7): .md and .html coexist in one catalog with
 * cross-format links, a slug collision, and a broken link.
 */
async function buildMixedBundle() {
  write(
    "docs/overview.html",
    [
      "<html>",
      "<head>",
      "<title>Overview</title>",
      '<meta name="okf:type" content="doc">',
      '<meta name="okf:description" content="Bundle overview." />',
      "</head>",
      "<body>",
      "<h1>Overview</h1>",
      '<p>Default format link: <a href="/pi">pi</a>.</p>',
      '<p>Exact cross-format path: <a href="notes/tables.md">tables</a>.</p>',
      '<p>Broken: <a href="/ghost">ghost</a> (tolerated, §6.1).</p>',
      "</body>",
      "</html>",
    ].join("\n"),
  );
  write("docs/pi.html", "<html><body><h1>Pi (html)</h1></body></html>");
  write("docs/pi.md", "---\ndescription: Markdown pi.\n---\nMarkdown pi prose.\n");
  write("docs/notes/tables.md", "---\ntype: BigQuery Table\n---\nSee [extra](./extra.md).\n");
  write("docs/notes/extra.md", "---\ntype: Reference\n---\nEnd of the line.\n");

  const root = join(FIXTURES, "docs");
  const roots: Record<CatalogKind, string[]> = { skill: [], doc: [root], agent: [] };
  const entries = await scanCatalog(roots);
  const graph = await buildLinkGraph(entries, { roots });
  return { root, entries, graph };
}

describe("mixed bundle integration (.md + .html)", () => {
  it("indexes both formats; slug collision keeps both entries (rules 7, 9)", async () => {
    const { root, entries } = await buildMixedBundle();
    const pis = entries.filter((entry) => entry.name === "pi");
    expect(pis.map((entry) => entry.path).sort()).toEqual(
      [join(root, "pi.html"), join(root, "pi.md")].sort(),
    );
    expect(entries.find((entry) => entry.name === "overview")?.description).toBe(
      "Bundle overview.",
    );
    expect(entries.find((entry) => entry.name === "tables")?.section).toBe("notes");
  });

  it("resolves extension-less /name .html-first, exact cross-format relative, and tolerates broken links", async () => {
    const { root, graph } = await buildMixedBundle();
    const overview = join(root, "overview.html");
    const out = graph.outgoing(overview);

    const piEdge = out.find((edge) => edge.rawTarget === "/pi");
    expect(piEdge?.entry?.path).toBe(join(root, "pi.html")); // .html first
    expect(piEdge?.broken).toBe(false);

    const tablesEdge = out.find((edge) => edge.rawTarget === "notes/tables.md");
    expect(tablesEdge?.entry?.path).toBe(join(root, "notes/tables.md"));
    expect(tablesEdge?.broken).toBe(false);

    const ghostEdge = out.find((edge) => edge.rawTarget === "/ghost");
    expect(ghostEdge?.broken).toBe(true);
    expect(ghostEdge?.targetPath).toBe(join(root, "ghost.html"));

    // Markdown extraction unchanged: tables.md still links ./extra.md only.
    const mdOut = graph.outgoing(join(root, "notes/tables.md"));
    expect(mdOut.map((edge) => edge.rawTarget)).toEqual(["./extra.md"]);
  });

  it("prefers the .html entry for name lookup; exact paths stay unambiguous (rule 9)", async () => {
    const { root, entries } = await buildMixedBundle();

    const byName = resolveCatalogEntry(entries, { name: "pi" });
    expect("error" in byName ? byName.error : byName.path).toBe(join(root, "pi.html"));

    const byExactMd = resolveCatalogEntry(entries, { path: join(root, "pi.md") });
    expect("error" in byExactMd ? byExactMd.error : byExactMd.path).toBe(join(root, "pi.md"));

    const byExactHtml = resolveCatalogEntry(entries, { path: join(root, "pi.html") });
    expect("error" in byExactHtml ? byExactHtml.error : byExactHtml.path).toBe(
      join(root, "pi.html"),
    );

    // Display form kind/name is name-based too: .html preferred.
    const byDisplay = resolveCatalogEntry(entries, { path: "doc/pi" });
    expect("error" in byDisplay ? byDisplay.error : byDisplay.path).toBe(join(root, "pi.html"));
  });
});
