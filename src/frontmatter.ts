import { parse as parseYaml } from "yaml";

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown>; body: string }
  | { ok: false; error: string };

/**
 * Parse a leading `---\n<yaml>\n---` frontmatter block.
 *
 * Per OKF §11 conformance this parser never throws: any failure — missing or
 * unclosed delimiters, malformed YAML, non-map roots — is reported as
 * `{ ok: false, error }`. Handles a leading BOM and CRLF line endings.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  try {
    if (typeof raw !== "string") {
      return { ok: false, error: "no frontmatter: input is not a string" };
    }

    // Strip a UTF-8 byte-order mark, then normalize line inspection only
    // (the body keeps its original line endings).
    let text = raw;
    if (text.startsWith("\uFEFF")) text = text.slice(1);

    // Delimiter detection must work across CRLF and LF, so compare each
    // candidate line with any trailing \r removed.
    const firstLineEnd = findLineEnd(text, 0);
    const firstLine = text.slice(0, firstLineEnd.lineEnd).replace(/\r$/, "");
    if (firstLine.trim() !== "---") {
      return { ok: false, error: "no frontmatter block at start of file" };
    }

    const searchStart = firstLineEnd.nextStart;
    let cursor = searchStart;
    for (;;) {
      if (cursor >= text.length) {
        return { ok: false, error: "unclosed frontmatter block" };
      }
      const lineEnd = findLineEnd(text, cursor);
      const line = text.slice(cursor, lineEnd.lineEnd).replace(/\r$/, "");
      if (line.trim() === "---") {
        const yamlSource = text.slice(searchStart, cursor);
        const bodyStart = lineEnd.nextStart;
        return finish(yamlSource, text.slice(bodyStart));
      }
      cursor = lineEnd.nextStart;
    }
  } catch (error) {
    return {
      ok: false,
      error: `frontmatter parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function findLineEnd(text: string, start: number): { lineEnd: number; nextStart: number } {
  const nl = text.indexOf("\n", start);
  if (nl === -1) {
    return { lineEnd: text.length, nextStart: text.length };
  }
  return { lineEnd: nl, nextStart: nl + 1 };
}

function finish(yamlSource: string, body: string): FrontmatterResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch (error) {
    return {
      ok: false,
      error: `invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // An empty block parses to null; per §11 that is a valid (empty) map.
  if (parsed === null || parsed === undefined) {
    return { ok: true, data: {}, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "frontmatter root must be a YAML mapping" };
  }
  return { ok: true, data: parsed as Record<string, unknown>, body };
}
