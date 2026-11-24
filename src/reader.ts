import { readFile } from "node:fs/promises";
import type { CatalogEntry } from "./catalog.ts";
import { isHtmlPath, parseHtmlMeta } from "./htmlmeta.ts";

export interface ReadResult {
  text: string;
  truncated: boolean;
  totalChars: number;
}

export const DEFAULT_MAX_CHARS = 20000;

/**
 * Read a catalog resource, truncating to `maxChars` characters. Truncated
 * text ends with an explicit marker line telling the model where to read the
 * rest from.
 *
 * OKF-HTML v0.1: `.html` entries return extracted readable text instead of
 * raw markup — doctype/head/script/style content is dropped, block-level
 * tags become newlines (h1–h6 and li land on their own lines), and runs of
 * blank lines collapse. `maxChars` and the truncation marker then apply to
 * the extracted text.
 */
export async function readResource(
  entry: CatalogEntry,
  maxChars: number = DEFAULT_MAX_CHARS,
): Promise<ReadResult> {
  const raw = await readFile(entry.path, "utf8");
  const text = isHtmlPath(entry.path) ? htmlToReadableText(raw) : raw;
  const totalChars = text.length;
  const bounded =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;

  if (totalChars <= bounded) {
    return { text, truncated: false, totalChars };
  }

  const head = text.slice(0, bounded);
  const marker =
    `\n\n[... truncated ${totalChars - bounded} of ${totalChars} characters. ` +
    `The full file is at ${entry.path} — read it from there for the rest.]\n`;
  return { text: head + marker, truncated: true, totalChars };
}

/** Tags whose boundaries become newlines in readable text (block-level + br). */
const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|br)\b[^>]*>/gi;

/**
 * Hand-rolled HTML-to-text (no new dependencies; OKF-HTML v0.1 reader
 * contract): drop doctype/head/script/style with their content, block tags
 * become newlines, inline tags vanish, runs of blank lines collapse.
 * Entities are kept exactly as written (no decoding in v0.1).
 */
function htmlToReadableText(raw: string): string {
  let text = raw;
  if (text.startsWith("\uFEFF")) text = text.slice(1);

  // Readable region: reuse the htmlmeta body extraction (body…/body, else
  // after </head>, else the whole input) — one spelling of the concept.
  const parsed = parseHtmlMeta(text);
  let region = parsed.ok ? parsed.body : text;

  region = region
    .replace(/<!--[\s\S]*?-->/g, " ") // comments
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ") // defensive: head inside a no-body region
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " "); // code, never prose

  region = region.replace(BLOCK_TAG, "\n").replace(/<[^>]*>/g, "");

  return region
    .replace(/[ \t]+\n/g, "\n") // trailing indentation before line ends
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
}
