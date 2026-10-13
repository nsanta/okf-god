import { readFile } from "node:fs/promises";
import type { CatalogEntry } from "./catalog.ts";

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
 */
export async function readResource(entry: CatalogEntry, maxChars: number = DEFAULT_MAX_CHARS): Promise<ReadResult> {
  const raw = await readFile(entry.path, "utf8");
  const totalChars = raw.length;
  const bounded = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;

  if (totalChars <= bounded) {
    return { text: raw, truncated: false, totalChars };
  }

  const head = raw.slice(0, bounded);
  const marker =
    `\n\n[... truncated ${totalChars - bounded} of ${totalChars} characters. ` +
    `The full file is at ${entry.path} — read it from there for the rest.]\n`;
  return { text: head + marker, truncated: true, totalChars };
}
