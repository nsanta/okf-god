import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/catalog.ts";
import { readResource } from "../src/reader.ts";

const DIR = mkdtempSync(join(tmpdir(), "okf-reader-"));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function entryAt(fileName: string): CatalogEntry {
  return {
    kind: "doc",
    name: fileName.replace(/\.md$/, ""),
    description: "",
    tags: [],
    path: join(DIR, fileName),
  };
}

describe("readResource", () => {
  it("returns the full text without truncation under the limit", async () => {
    const path = join(DIR, "small.md");
    writeFileSync(path, "a".repeat(100), "utf8");
    const result = await readResource(entryAt("small.md"), 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("a".repeat(100));
    expect(result.totalChars).toBe(100);
  });

  it("truncates at maxChars and appends a marker naming the file path", async () => {
    const path = join(DIR, "large.md");
    writeFileSync(path, "b".repeat(500), "utf8");
    const result = await readResource(entryAt("large.md"), 200);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(500);
    expect(result.text.startsWith("b".repeat(200))).toBe(true);
    expect(result.text).toContain(path);
    expect(result.text).toMatch(/truncat/i);
  });

  it("falls back to the default maxChars of 20000", async () => {
    const path = join(DIR, "default.md");
    writeFileSync(path, "c".repeat(30000), "utf8");
    const result = await readResource(entryAt("default.md"));
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(30000);
  });
});
