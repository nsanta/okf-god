import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanCatalog, type CatalogKind } from "../src/catalog.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-catalog-html-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(FIXTURES, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function fixtureRoots(): Record<CatalogKind, string[]> {
  return {
    skill: [join(FIXTURES, "skills")],
    doc: [join(FIXTURES, "docs")],
    agent: [join(FIXTURES, "agents")],
  };
}

describe("scanCatalog: OKF-HTML documents", () => {
  it("indexes .html docs with metadata from okf: metas and <title>", async () => {
    write(
      "docs/guide.html",
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>User Guide</title>",
        '  <meta name="description" content="How to use it.">',
        '  <meta name="okf:type" content="doc">',
        '  <meta name="okf:resource" content="urn:guide">',
        '  <meta name="okf:status" content="review">',
        '  <meta name="okf:stale_after" content="2030-01-01">',
        '  <meta name="okf:generated.at" content="2026-01-02T03:04:05Z">',
        '  <meta name="okf:tags" content="guide">',
        '  <meta name="okf:tags" content="html">',
        "</head>",
        "<body>",
        "<h1>User Guide</h1>",
        "<p>Prose.</p>",
        "</body>",
        "</html>",
      ].join("\n"),
    );
    // A markdown sibling proves the .md path is untouched.
    write("docs/markdown-sibling.md", "---\ntitle: MD Sibling\ndescription: Markdown.\n---\n");

    const entries = await scanCatalog(fixtureRoots());
    const guide = entries.find((entry) => entry.kind === "doc" && entry.name === "guide");
    expect(guide).toBeDefined();
    expect(guide?.path).toBe(join(FIXTURES, "docs/guide.html"));
    expect(guide?.title).toBe("User Guide");
    expect(guide?.description).toBe("How to use it.");
    expect(guide?.tags).toEqual(["guide", "html"]);
    expect(guide?.status).toBe("review");
    expect(guide?.okfType).toBe("doc");
    expect(guide?.resource).toBe("urn:guide");
    expect(guide?.staleAfter).toBe("2030-01-01");
    expect(guide?.generatedAt).toBe("2026-01-02T03:04:05Z");
    expect(guide?.trustTier).toBe("unverified");

    const sibling = entries.find(
      (entry) => entry.kind === "doc" && entry.name === "markdown-sibling",
    );
    expect(sibling?.title).toBe("MD Sibling");
  });

  it("prefers okf:name over the filename slug and keeps .html agents/skills conventions", async () => {
    write(
      "agents/helper.html",
      '<meta name="okf:name" content="custom-agent"><meta name="okf:description" content="Named meta."><p>Body.</p>',
    );
    write("agents/plain.html", "<p>No metas at all.</p>");
    write("skills/alpha/SKILL.md", "---\nname: alpha-skill\n---\n");
    // Skills stay Markdown (rule 8): SKILL.html is not a skill file.
    write("skills/html-skill/SKILL.html", "<h1>Not a skill.</h1>");

    const entries = await scanCatalog(fixtureRoots());
    const custom = entries.find((entry) => entry.kind === "agent" && entry.name === "custom-agent");
    expect(custom?.description).toBe("Named meta.");

    const plain = entries.find((entry) => entry.kind === "agent" && entry.name === "plain");
    expect(plain?.path).toBe(join(FIXTURES, "agents/plain.html"));
    expect(plain?.description).toBe("");

    expect(entries.find((entry) => entry.name === "alpha-skill")).toBeDefined();
    expect(entries.find((entry) => entry.name === "html-skill")).toBeUndefined();
  });

  it("skips reserved index.html and log.html (rule 5)", async () => {
    write("docs/index.html", "<h1>Index</h1>");
    write("docs/log.html", "<h1>Log</h1>");
    write("docs/kept.html", "<h1>Kept</h1>");

    const entries = await scanCatalog(fixtureRoots());
    const names = entries.filter((entry) => entry.kind === "doc").map((entry) => entry.name);
    expect(names).not.toContain("index");
    expect(names).not.toContain("log");
    expect(names).toContain("kept");
  });

  it("indexes both entries for a slug collision across extensions (rule 9)", async () => {
    write("docs/pi.md", "---\ndescription: Markdown pi.\n---\n");
    write("docs/pi.html", '<meta name="description" content="Html pi."><p>Body.</p>');

    const entries = await scanCatalog(fixtureRoots());
    const pis = entries.filter((entry) => entry.kind === "doc" && entry.name === "pi");
    expect(pis).toHaveLength(2);
    expect(pis.map((entry) => entry.path.split(".").pop()).sort()).toEqual(["html", "md"]);
    expect(pis.find((entry) => entry.path.endsWith(".html"))?.description).toBe("Html pi.");
    expect(pis.find((entry) => entry.path.endsWith(".md"))?.description).toBe("Markdown pi.");
  });

  it("populates headings for .html entries from h1–h6 (duplicates kept, in order)", async () => {
    write(
      "docs/headings.html",
      [
        "<html><head><title>T</title></head><body>",
        "<h1>Top</h1>",
        "<h2>Section A</h2>",
        "<h2>Section A</h2>",
        "<h3>Deep <em>detail</em></h3>",
        "</body></html>",
      ].join("\n"),
    );
    write("docs/no-headings.html", "<html><head></head><body><p>Only prose.</p></body></html>");
    write("docs/empty-body.html", "<html><head><title>E</title></head><body></body></html>");

    const entries = await scanCatalog(fixtureRoots());
    const withHeadings = entries.find((entry) => entry.name === "headings");
    expect(withHeadings?.headings).toEqual(["Top", "Section A", "Section A", "Deep detail"]);

    const noHeadings = entries.find((entry) => entry.name === "no-headings");
    expect(noHeadings?.headings).toEqual([]);

    const emptyBody = entries.find((entry) => entry.name === "empty-body");
    expect(emptyBody?.headings).toEqual([]);

    // Markdown entries carry no headings.
    write("docs/md-no-headings.md", "---\ntitle: MD\n---\n");
    const after = await scanCatalog(fixtureRoots());
    expect(after.find((entry) => entry.name === "md-no-headings")?.headings).toBeUndefined();
  });
});
