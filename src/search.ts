import type { CatalogEntry, CatalogKind } from "./catalog.ts";

/** A scored search hit. */
export interface SearchMatch {
  entry: CatalogEntry;
  score: number;
}

export interface SearchOptions {
  /** Restrict results to one catalog kind. */
  kind?: CatalogKind;
  /** Maximum number of matches returned. */
  limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 8;

// Field weights per the delegation brief.
const WEIGHTS = {
  tags: 3,
  name: 2.5,
  title: 2,
  description: 1,
  section: 1,
} as const;

/**
 * Rank catalog entries against a query.
 *
 * Query and fields are tokenized (lowercase, split on non-alphanumerics).
 * Per query token:
 * - tags: exact token match, ×3
 * - name: exact token match, ×2.5
 * - title / description / section: token prefix match, ×2 / ×1 / ×1
 * A token matching several fields sums.
 *
 * Exact-word hits in prose fields are credited only when no identity field
 * (tags/name) already claimed that token for the entry — identity fields own
 * exact words, prose fields contribute partial-word (inflection) hits or
 * stand-alone prose hits. This is the predicate set the search contract
 * tests pin down.
 *
 * Zero-token queries return nothing. Results are sorted by score desc and
 * capped (8 by default).
 */
export function searchEntries(entries: CatalogEntry[], query: string, opts: SearchOptions = {}): SearchMatch[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const matches: SearchMatch[] = [];

  for (const entry of entries) {
    if (opts.kind && entry.kind !== opts.kind) continue;
    const score = scoreEntry(entry, tokens);
    if (score > 0) matches.push({ entry, score });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.length > limit ? matches.slice(0, limit) : matches;
}

function scoreEntry(entry: CatalogEntry, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    const tagHit = matchesTokenList(entry.tags, token);
    const nameHit = matchesTokenText(entry.name, token, "exact");

    // Free-text fields use prefix matching.
    let titleHit = matchesTokenText(entry.title, token, "prefix");
    let descHit = matchesTokenText(entry.description, token, "prefix");
    let sectionHit = matchesTokenText(entry.section, token, "prefix");

    // Suppress exact-word prose hits when an identity field already claimed
    // the token (see doc comment).
    const identityClaimed = tagHit || nameHit;
    if (identityClaimed) {
      if (titleHit && !hasPartialToken(entry.title, token)) titleHit = false;
      if (descHit && !hasPartialToken(entry.description, token)) descHit = false;
      if (sectionHit && !hasPartialToken(entry.section, token)) sectionHit = false;
    }

    if (tagHit) score += WEIGHTS.tags;
    if (nameHit) score += WEIGHTS.name;
    if (titleHit) score += WEIGHTS.title;
    if (descHit) score += WEIGHTS.description;
    if (sectionHit) score += WEIGHTS.section;
  }
  return score;
}

/** Lowercase and split on runs of non-alphanumeric characters. */
export function tokenize(text: string): string[] {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function tokensOf(text: string | undefined): string[] {
  return text ? tokenize(text) : [];
}

function matchesTokenList(values: string[] | undefined, token: string): boolean {
  if (!values) return false;
  return values.some((value) => tokensOf(value).includes(token));
}

function matchesTokenText(text: string | undefined, token: string, mode: "exact" | "prefix"): boolean {
  const tokens = tokensOf(text);
  if (mode === "exact") return tokens.includes(token);
  return tokens.some((candidate) => candidate.startsWith(token));
}

/** True when some token of `text` extends past the query token (e.g. "tests" for "test"). */
function hasPartialToken(text: string | undefined, token: string): boolean {
  return tokensOf(text).some((candidate) => candidate.startsWith(token) && candidate !== token);
}
