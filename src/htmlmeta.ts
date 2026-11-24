import type { FrontmatterResult } from "./frontmatter.ts";

/**
 * OKF-HTML v0.1 metadata parsing (docs/okf-html.html, rules 1–5): a
 * self-contained HTML document stores its OKF fields as
 * `<meta name="okf:..." content="...">` tags plus the `<title>` element.
 *
 * Like `parseFrontmatter`, this parser never throws. Unlike markdown, an
 * HTML document has no "missing frontmatter" state (OKF §11): any string
 * input yields `{ ok: true, data, body }` — zero `okf:` metas is a valid
 * permissive document. Only non-string input is rejected, mirroring
 * `parseFrontmatter`'s guard.
 */

/** True when a catalog path is an OKF-HTML document (one spelling for all modules). */
export function isHtmlPath(path: string): boolean {
  return path.toLowerCase().endsWith(".html");
}

/**
 * Parse OKF metadata and the readable region out of an HTML document.
 *
 * `data`: every `<meta name="okf:<field>">` becomes key `<field>` (dotted
 * keys stay dotted, e.g. `generated.at`); repeated names accumulate into
 * arrays in document order; the `<title>` element maps to `title` (an
 * explicit `okf:title` meta wins); plain `name="description"` is a fallback
 * alias for `description` (`okf:description` wins). Name matching is
 * case-insensitive; keys keep the spelling written after the `okf:` prefix.
 *
 * `body`: content between `<body>` and `</body>` when both are present,
 * else content after `</head>`, else the whole input.
 */
export function parseHtmlMeta(raw: string): FrontmatterResult {
  try {
    if (typeof raw !== "string") {
      return { ok: false, error: "no html: input is not a string" };
    }

    // Strip a UTF-8 byte-order mark, then slice everything from clean text
    // (mirrors parseFrontmatter's BOM handling).
    let text = raw;
    if (text.startsWith("\uFEFF")) text = text.slice(1);

    const data = collectMetas(text);
    applyTitle(data, text);

    return { ok: true, data, body: extractBody(text) };
  } catch {
    // OKF §11: the parser never throws and never rejects a document.
    return { ok: true, data: {}, body: raw };
  }
}

/** Collect okf:* metas plus the plain `description` fallback alias. */
function collectMetas(text: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let descriptionAlias: string | undefined;

  for (const tag of text.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag[0]);
    const name = attrs.get("name");
    if (name === undefined) continue;
    const content = attrs.get("content");
    if (content === undefined) continue;

    const lower = name.toLowerCase();
    if (lower.startsWith("okf:")) {
      // The key keeps the spelling written after the okf: prefix; dotted
      // names stay dotted. Repeated names accumulate in document order.
      const key = name.slice(4);
      const existing = data[key];
      if (existing === undefined) {
        data[key] = content;
      } else if (Array.isArray(existing)) {
        existing.push(content);
      } else {
        data[key] = [existing, content];
      }
    } else if (lower === "description" && descriptionAlias === undefined) {
      descriptionAlias = content; // plain HTML alias: first one wins
    }
  }

  // Rule 3: the plain description is only a fallback alias; an explicit
  // okf:description wins regardless of tag order.
  if (descriptionAlias !== undefined && !("description" in data)) {
    data.description = descriptionAlias;
  }
  return data;
}

/** Attribute map of one tag string; attribute names are lowercased. */
function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const attr of tag.matchAll(
    /\s([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g,
  )) {
    const name = attr[1]!.toLowerCase();
    const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
    attrs.set(name, value);
  }
  return attrs;
}

/** Map the `<title>` element to `title` unless an okf:title meta exists. */
function applyTitle(data: Record<string, unknown>, text: string): void {
  if (data["title"] !== undefined) return;
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (!match) return;
  const title = collapseWhitespace(match[1] ?? "");
  if (title.length > 0) data.title = title;
}

/** Content between <body>…</body>, else after </head>, else the whole input. */
function extractBody(text: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(text);
  if (body) return body[1] ?? "";

  const headEnd = searchFrom(text, /<\/head\s*>/i);
  if (headEnd !== -1) return text.slice(headEnd);

  return text;
}

/** End index of the first `</head>` match, or -1. */
function searchFrom(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (!match) return -1;
  return match.index + match[0].length;
}

/**
 * Extract h1–h6 text in document order: duplicates are kept (no dedup),
 * inline tags are stripped, internal whitespace is collapsed.
 */
export function extractHtmlHeadings(html: string): string[] {
  const headings: string[] = [];
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = collapseWhitespace((match[2] ?? "").replace(/<[^>]*>/g, " "));
    if (text.length > 0) headings.push(text);
  }
  return headings;
}

/** Collapse whitespace runs (including newlines) to single spaces and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
