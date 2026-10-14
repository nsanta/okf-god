/**
 * Pure query resolution for okf_read/okf_links path and name lookups.
 *
 * `okf_search` displays entries as `kind/name` (e.g. `doc/mock`) and callers
 * often hold root-relative or section-qualified paths, while
 * `CatalogEntry.path` is an absolute filesystem path. The ladder below accepts
 * every form a caller can reasonably derive, in priority order:
 *
 * 1. Exact absolute `entry.path` (historical behavior, unchanged).
 * 2. Display form `kind/name` (e.g. `doc/mock`); `kind:name` is unique in the
 *    catalog by scan-time dedupe.
 * 3. Root-relative suffix match with normalization on both sides: `\` → `/`,
 *    a leading `./` stripped, one trailing `.md` stripped case-insensitively,
 *    and a leading `kind/` segment stripped when it names a catalog kind
 *    (e.g. `docs/mock.md`, `docs/mock`, `guides/deploy`, `doc/guides/deploy`).
 *
 * The first level with at least one match decides: a single match resolves,
 * several matches yield an ambiguity error listing every candidate as
 * `kind:name (path)`, one per line. If the path matches nothing, a present
 * `name` falls through to name handling, which keeps the historical
 * semantics: unique exact name → entry, multiple → ambiguity error across
 * kinds, none → not-found error.
 */
import { type CatalogEntry, type CatalogKind, CATALOG_KINDS } from "./catalog.ts";

/** Either a resolved entry or a model-facing error string. */
export type ResolvedEntry = CatalogEntry | { error: string };

export interface ResolveQuery {
  path?: string;
  name?: string;
}

/** One rung of the path ladder: all entries matching the raw input at that level. */
type PathMatcher = (entries: CatalogEntry[], raw: string) => CatalogEntry[];

function isCatalogKind(value: string): value is CatalogKind {
  return (CATALOG_KINDS as readonly string[]).includes(value);
}

/** POSIX separators plus at most one trailing `.md` stripped. */
function normalizeEntryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\.md$/i, "");
}

/** Normalize a path query for suffix matching (ladder level 3). */
function normalizePathQuery(raw: string): string {
  let value = raw.replace(/\\/g, "/");
  if (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\.md$/i, "");
  const slash = value.indexOf("/");
  if (slash > 0 && isCatalogKind(value.slice(0, slash))) {
    value = value.slice(slash + 1);
  }
  return value;
}

// Level 1: exact absolute path (historical behavior).
const matchAbsolutePath: PathMatcher = (entries, raw) => entries.filter((entry) => entry.path === raw);

// Level 2: display form `kind/name`; `kind:name` is unique by scan dedupe.
const matchDisplayForm: PathMatcher = (entries, raw) => {
  const slash = raw.indexOf("/");
  if (slash <= 0) return [];
  const kind = raw.slice(0, slash);
  if (!isCatalogKind(kind)) return [];
  const name = raw.slice(slash + 1);
  return entries.filter((entry) => entry.kind === kind && entry.name === name);
};

// Level 3: root-relative suffix match, normalized on both sides.
const matchPathSuffix: PathMatcher = (entries, raw) => {
  const needle = normalizePathQuery(raw);
  if (!needle) return [];
  return entries.filter((entry) => {
    const haystack = normalizeEntryPath(entry.path);
    return haystack === needle || haystack.endsWith(`/${needle}`);
  });
};

const PATH_LADDER: readonly PathMatcher[] = [matchAbsolutePath, matchDisplayForm, matchPathSuffix];

function listCandidates(matches: CatalogEntry[]): string {
  return matches.map((entry) => `${entry.kind}:${entry.name} (${entry.path})`).join("\n");
}

/**
 * Resolve a path/name query against catalog entries. See the module header for
 * the path ladder and the name-only semantics.
 */
export function resolveCatalogEntry(entries: CatalogEntry[], query: ResolveQuery): ResolvedEntry {
  const trimmedPath = query.path?.trim();
  const trimmedName = query.name?.trim();

  if (trimmedPath) {
    // The first ladder level with at least one match decides the outcome.
    for (const matchLevel of PATH_LADDER) {
      const matches = matchLevel(entries, trimmedPath);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        return {
          error: `Path "${trimmedPath}" is ambiguous. Candidates:\n${listCandidates(matches)}\nPass a more specific path.`,
        };
      }
    }
    if (!trimmedName) {
      return {
        error:
          `No catalog entry matches path "${trimmedPath}". Accepted forms: an absolute file path, ` +
          `a display form like "doc/mock", or a root-relative path with or without ".md" like ` +
          `"docs/mock.md", "docs/mock", or "guides/deploy". Use okf_search to find resources, ` +
          `or pass a resource name.`,
      };
    }
  }

  if (trimmedName) {
    const matches = entries.filter((entry) => entry.name === trimmedName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return {
        error: `Name "${trimmedName}" is ambiguous across kinds:\n${listCandidates(matches)}\nPass an exact path instead.`,
      };
    }
    return { error: `No catalog entry named "${trimmedName}". Try okf_search to find resource names.` };
  }

  return { error: "Provide either a resource path or a resource name." };
}
