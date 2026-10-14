import type { CatalogEntry } from "./catalog.ts";

/**
 * Verbs whose first argument is a write/create target, not something being
 * read. When a bash command starts with one of these, path extraction is
 * skipped entirely: usage tracking means "accessed for reading", so
 * `rm docs/runbook.md` must not record a doc usage.
 */
const NON_READ_VERBS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "rmdir",
  "unlink",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "tee",
  "install",
]);

/** `FOO=bar cmd …` style leading environment assignments. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Pure heuristic: extract the cataloged files a bash command reads.
 *
 * - The command is tokenized quote-aware (single/double quotes are stripped
 *   but keep their inner text, including whitespace); tokens split on
 *   whitespace and shell operators (| ; & > < ( )) and newlines.
 * - Leading env assignments are stripped, then the first token is checked
 *   against the non-read verb denylist (case-sensitive): a match returns [].
 * - Remaining tokens that look path-like (contain "/" or end with ".md",
 *   case-insensitive) are resolved via the injected resolver and matched
 *   EXACTLY against entry.path — no substring or fuzzy matching.
 * - Matches are deduplicated and returned in catalog order; a single command
 *   may touch several cataloged files.
 *
 * Variable-built paths (`cat $FILE`) never match: they are not path-like or
 * do not resolve to an exact catalog path. Zero false positives preferred.
 */
export function extractCatalogPaths(
  command: string,
  entries: CatalogEntry[],
  resolve: (p: string) => string,
): CatalogEntry[] {
  const tokens = stripEnvAssignments(tokenize(command));
  if (tokens.length === 0 || NON_READ_VERBS.has(tokens[0]!)) return [];

  const resolved = new Set<string>();
  for (const token of tokens) {
    if (!isPathLike(token)) continue;
    try {
      resolved.add(resolve(token));
    } catch {
      // resolver failure: this token cannot match, skip it silently
    }
  }
  const matches: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path) || !resolved.has(entry.path)) continue;
    seen.add(entry.path);
    matches.push(entry);
  }
  return matches;
}

/**
 * Quote-aware tokenizer: single/double quotes keep their inner text (quotes
 * stripped); whitespace, shell operators, and newlines split tokens.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (isBoundary(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function isBoundary(char: string): boolean {
  return /\s/.test(char) || "|;&><()".includes(char);
}

function stripEnvAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index++;
  return tokens.slice(index);
}

/** A token is a read-access candidate when it contains "/" or ends with ".md". */
function isPathLike(token: string): boolean {
  return token.includes("/") || /\.md$/i.test(token);
}
