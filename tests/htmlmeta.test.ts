import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHtmlHeadings, parseHtmlMeta } from "../src/htmlmeta.ts";

/** The format contract document doubles as a fixture; never modified. */
const CONTRACT = readFileSync(join(import.meta.dirname, "..", "docs", "okf-html.html"), "utf8");

describe("parseHtmlMeta", () => {
  it("parses okf: scalar metas into unprefixed keys", () => {
    const raw =
      '<html><head><meta name="okf:type" content="doc">\n' +
      '<meta name="okf:status" content="stable"></head><body>Hi.</body></html>';
    const result = parseHtmlMeta(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("doc");
      expect(result.data.status).toBe("stable");
      expect(result.body).toBe("Hi.");
    }
  });

  it("keeps dotted keys dotted", () => {
    const raw = '<meta name="okf:generated.at" content="2026-11-24T10:00:00Z">';
    const result = parseHtmlMeta(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["generated.at"]).toBe("2026-11-24T10:00:00Z");
  });

  it("accumulates repeated names into arrays in document order", () => {
    const raw =
      '<meta name="okf:tags" content="okf">\n' +
      '<meta name="okf:tags" content="format">\n' +
      '<meta name="okf:tags" content="okf-god">';
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.data.tags).toEqual(["okf", "format", "okf-god"]);
  });

  it("maps <title> text to the title field", () => {
    const raw = "<head><title>Architecture</title></head>";
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.data.title).toBe("Architecture");
  });

  it("lets an explicit okf:title meta win over <title>", () => {
    const raw = '<title>Element</title><meta name="okf:title" content="Meta">';
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.data.title).toBe("Meta");
  });

  it("accepts plain name=description as a fallback alias; okf:description wins", () => {
    const alias = '<meta name="description" content="Fallback text.">';
    const result = parseHtmlMeta(alias);
    if (result.ok) expect(result.data.description).toBe("Fallback text.");

    const both =
      '<meta name="description" content="Fallback.">\n' +
      '<meta name="okf:description" content="Explicit wins.">';
    const explicit = parseHtmlMeta(both);
    if (explicit.ok) expect(explicit.data.description).toBe("Explicit wins.");
  });

  it("matches meta names case-insensitively (keys keep their written spelling)", () => {
    const raw =
      '<meta NAME="OKF:Status" CONTENT="beta"><meta NAME="DESCRIPTION" content="Upper alias.">';
    const result = parseHtmlMeta(raw);
    if (result.ok) {
      // Prefix matching is case-insensitive; the key stays as written after it.
      expect(result.data.Status).toBe("beta");
      expect(result.data.description).toBe("Upper alias.");
    }
  });

  it("handles attributes in any order and single/double/unquoted values", () => {
    const raw =
      "<meta content='single' name='okf:type'>\n" +
      '<meta content="double" name="okf:status">\n' +
      "<meta content=unquoted name=okf:stage>";
    const result = parseHtmlMeta(raw);
    if (result.ok) {
      expect(result.data.type).toBe("single");
      expect(result.data.status).toBe("double");
      expect(result.data.stage).toBe("unquoted");
    }
  });

  it("tolerates unknown okf: fields (§11 permissive)", () => {
    const raw = '<meta name="okf:future-field" content="whatever">';
    const result = parseHtmlMeta(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["future-field"]).toBe("whatever");
  });

  it("ignores metas without the okf: prefix or description name", () => {
    const raw = '<meta charset="utf-8"><meta name="viewport" content="width=device-width">';
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.data).toEqual({});
  });

  it("returns a valid permissive document when there are no metas at all", () => {
    const result = parseHtmlMeta("<html><head></head><body><p>Prose only.</p></body></html>");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
      expect(result.body).toContain("Prose only.");
    }
  });

  it("extracts the body between <body> and </body>", () => {
    const raw = "<html><head><title>T</title></head>\r\n<body>\n<p>One.</p>\n</body>\n</html>";
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.body).toBe("\n<p>One.</p>\n");
  });

  it("falls back to content after </head> when <body> is absent", () => {
    const raw = '<html><head><meta name="okf:type" content="doc"></head><main>After head.</main>';
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.body).toContain("<main>After head.</main>");
  });

  it("uses the whole input when there is no </head> or <body>", () => {
    const raw = "<p>No head, no body, just markup.</p>";
    const result = parseHtmlMeta(raw);
    if (result.ok) expect(result.body).toBe(raw);
  });

  it("tolerates unclosed tags", () => {
    const unclosedHead = '<html><head><meta name="okf:type" content="doc"><p>Leaked.</p>';
    const result = parseHtmlMeta(unclosedHead);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("doc");
      expect(result.body).toBe(unclosedHead); // no </head>, no <body>
    }

    const unclosedBody = "<body><ul><li>open markup<li>never closed";
    const loose = parseHtmlMeta(unclosedBody);
    if (loose.ok) expect(loose.body).toContain("never closed");
  });

  it("handles CRLF line endings", () => {
    const raw =
      '<html>\r\n<head>\r\n<meta name="okf:status" content="stable">\r\n' +
      "<title>CRLF Doc</title>\r\n</head>\r\n<body>\r\n<p>Windows.</p>\r\n</body>\r\n</html>";
    const result = parseHtmlMeta(raw);
    if (result.ok) {
      expect(result.data.status).toBe("stable");
      expect(result.data.title).toBe("CRLF Doc");
      expect(result.body).toBe("\r\n<p>Windows.</p>\r\n");
    }
  });

  it("strips a leading BOM", () => {
    const raw = '\uFEFF<meta name="okf:type" content="doc"><p>Bom.</p>';
    const result = parseHtmlMeta(raw);
    if (result.ok) {
      expect(result.data.type).toBe("doc");
      expect(result.body).toBe('<meta name="okf:type" content="doc"><p>Bom.</p>');
    }
  });

  it("never throws and never rejects any string input", () => {
    for (const raw of ["", "   ", "not html at all", "<", "<<<>>>", "<meta", "</body>", "\u0000"]) {
      const result = parseHtmlMeta(raw);
      expect(result.ok).toBe(true);
    }
  });

  it("parses the format contract fixture (docs/okf-html.html)", () => {
    const result = parseHtmlMeta(CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("OKF-HTML v0.1 Profile");
    expect(result.data.description).toBe(
      "OKF-HTML v0.1: storing Open Knowledge Format documents as self-contained HTML " +
        "with okf: meta tags replacing the YAML frontmatter.",
    );
    expect(result.data.type).toBe("doc");
    expect(result.data.resource).toBe("okf-html-profile");
    expect(result.data.status).toBe("stable");
    expect(result.data.stale_after).toBe("2027-05-24");
    expect(result.data["generated.at"]).toBe("2026-11-24T14:35:00Z");
    expect(result.data.tags).toEqual(["okf", "format", "okf-god"]);
    expect(result.body).toContain("<h1>OKF-HTML v0.1 Profile</h1>");
    expect(result.body).toContain("<h2>Rules</h2>");
    expect(result.body).not.toContain("<head");
    expect(result.body).not.toContain("<meta");
  });
});

describe("extractHtmlHeadings", () => {
  it("collects h1–h6 text in document order, keeping duplicates", () => {
    const html =
      "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6><h2>Two</h2>";
    expect(extractHtmlHeadings(html)).toEqual([
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six",
      "Two",
    ]);
  });

  it("strips inline tags inside headings and collapses whitespace", () => {
    expect(extractHtmlHeadings("<h2>  A <strong>bold</strong> name  </h2>")).toEqual([
      "A bold name",
    ]);
  });

  it("returns an empty array for empty or heading-free input", () => {
    expect(extractHtmlHeadings("")).toEqual([]);
    expect(extractHtmlHeadings("<p>No headings here.</p>")).toEqual([]);
  });
});
