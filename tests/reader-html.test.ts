import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/catalog.ts";
import { readResource } from "../src/reader.ts";

const DIR = mkdtempSync(join(tmpdir(), "okf-reader-html-"));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function entryAt(fileName: string): CatalogEntry {
  return {
    kind: "doc",
    name: fileName.replace(/\.(md|html)$/, ""),
    description: "",
    tags: [],
    path: join(DIR, fileName),
  };
}

const PAGE = [
  "<!doctype html>",
  "<html>",
  "<head>",
  "  <title>Readable</title>",
  '  <script>var poison = "<p>head script</p>";</script>',
  "  <style>p { color: red }</style>",
  "</head>",
  "<body>",
  "  <h1>Heading One</h1>",
  '  <p>Para <strong>one</strong> with <a href="x.html">link</a>.</p>',
  "  <ul>",
  "    <li>first item</li>",
  "    <li>second item</li>",
  "  </ul>",
  "  <p>Para two.</p>",
  '  <script>console.log("body script");</script>',
  "</body>",
  "</html>",
].join("\n");

describe("readResource: OKF-HTML entries", () => {
  it("returns readable text: head/script/style dropped, blocks as newlines, h1–h6 and li on own lines", async () => {
    writeFileSync(join(DIR, "page.html"), PAGE, "utf8");
    const result = await readResource(entryAt("page.html"));
    expect(result.truncated).toBe(false);
    // Every block boundary emits a newline; runs of blank lines collapse to
    // one blank line, so block siblings (li included) are blank-line separated.
    expect(result.text).toBe(
      "Heading One\n\nPara one with link.\n\nfirst item\n\nsecond item\n\nPara two.",
    );
    expect(result.text).not.toContain("script");
    expect(result.text).not.toContain("color: red");
    expect(result.text).not.toContain("<");
  });

  it("collapses runs of blank lines from deeply nested markup", async () => {
    writeFileSync(
      join(DIR, "nested.html"),
      "<body><div><div><p>A</p></div>\n\n<div>\t<p>B</p>\n</div></div>\n\n\n</body>",
      "utf8",
    );
    const result = await readResource(entryAt("nested.html"));
    expect(result.text).toBe("A\n\nB");
  });

  it("keeps pre-formatted text and escapes as written (v0.1 does not decode entities)", async () => {
    writeFileSync(
      join(DIR, "pre.html"),
      "<body><pre>const okf = true;\n  indent kept</pre><p>Literally &lt;tag&gt;.</p></body>",
      "utf8",
    );
    const result = await readResource(entryAt("pre.html"));
    expect(result.text).toContain("const okf = true;\n  indent kept");
    expect(result.text).toContain("Literally &lt;tag&gt;.");
  });

  it("tolerates documents without head or body tags", async () => {
    writeFileSync(join(DIR, "loose.html"), "<p>No regions at all.</p>", "utf8");
    const result = await readResource(entryAt("loose.html"));
    expect(result.text).toBe("No regions at all.");
  });

  it("truncates the extracted text at maxChars with the path-naming marker", async () => {
    const long = [
      "<body>",
      `<p>${"word ".repeat(200)}</p>`,
      `<p>${"tail ".repeat(100)}</p>`,
      "</body>",
    ].join("\n");
    writeFileSync(join(DIR, "long.html"), long, "utf8");
    const result = await readResource(entryAt("long.html"), 200);
    const whole = await readResource(entryAt("long.html"), 100000);
    expect(whole.truncated).toBe(false);
    expect(result.truncated).toBe(true);
    // totalChars counts the extracted readable text, not the raw HTML.
    expect(result.totalChars).toBe(whole.text.length);
    expect(result.text.startsWith(whole.text.slice(0, 200))).toBe(true);
    expect(result.text).toContain(join(DIR, "long.html"));
    expect(result.text).toMatch(/truncat/i);
  });

  it("falls back to the default maxChars for html entries", async () => {
    writeFileSync(join(DIR, "wide.html"), `<body><p>${"x".repeat(30000)}</p></body>`, "utf8");
    const result = await readResource(entryAt("wide.html"));
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(30000);
  });
});
