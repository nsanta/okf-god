import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses a valid block and returns data plus body", () => {
    const raw = "---\nname: my-skill\ntitle: My Skill\ntags: [a, b]\n---\n\nBody text here.\n";
    const result = parseFrontmatter(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("my-skill");
      expect(result.data.title).toBe("My Skill");
      expect(result.data.tags).toEqual(["a", "b"]);
      expect(result.body).toBe("\nBody text here.\n");
    }
  });

  it("handles BOM and CRLF line endings", () => {
    const raw = "\uFEFF---\r\nname: crlf-skill\r\nstatus: draft\r\n---\r\nBody.\r\n";
    const result = parseFrontmatter(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("crlf-skill");
      expect(result.data.status).toBe("draft");
      expect(result.body).toBe("Body.\r\n");
    }
  });

  it("returns ok:false for content without a frontmatter block", () => {
    const result = parseFrontmatter("Just plain markdown, no block.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no frontmatter/i);
  });

  it("returns ok:false for an unclosed block", () => {
    const result = parseFrontmatter("---\nname: unclosed\nbody without end\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unclosed/i);
  });

  it("returns ok:false for a non-map YAML root", () => {
    const result = parseFrontmatter("---\n- a\n- b\n---\nBody.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/map/i);
  });

  it("returns ok:false for invalid YAML instead of throwing", () => {
    const result = parseFrontmatter("---\nname: [unclosed\n---\nBody.\n");
    expect(result.ok).toBe(false);
  });

  it("never throws on empty or degenerate input", () => {
    expect(parseFrontmatter("").ok).toBe(false);
    expect(parseFrontmatter("---").ok).toBe(false);
    expect(parseFrontmatter("---\n---\n").ok).toBe(true);
  });
});
