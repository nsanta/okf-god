import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { deriveTrustTier, isStale, normalizeStatus } from "./trust.ts";

/** Catalog resource kinds. */
export type CatalogKind = "skill" | "doc" | "agent";

export const CATALOG_KINDS: readonly CatalogKind[] = ["skill", "doc", "agent"];

/**
 * One indexed resource. Only frontmatter is retained at scan time (never
 * bodies). `status`/`trustTier` are populated by `scanCatalog` but typed
 * optional so hand-built entries (tests, tooling) stay valid.
 */
export interface CatalogEntry {
  kind: CatalogKind;
  name: string;
  title?: string;
  description: string;
  tags: string[];
  status?: string;
  path: string;
  /** Directory path (POSIX-separated) relative to the scan root; undefined at the root. */
  section?: string;
  /** OKF §4.1 consumer-defined concept type (`type`). */
  okfType?: string;
  /** OKF §4.1 canonical URI of the underlying asset (`resource`). */
  resource?: string;
  /** OKF §5.5 absolute staleness instant (`stale_after`, ISO 8601 string). */
  staleAfter?: string;
  /** OKF §5.2 content generation instant (`generated.at`). */
  generatedAt?: string;
  /** OKF §5.3 trust tier derived from `verified`. */
  trustTier?: TrustTier;
  /** Root the entry was scanned from (used for bundle-relative link resolution). */
  root?: string;
}

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/** Path segments never scanned, plus OKF §3.1 reserved filenames. */
export const EXCLUDED_SEGMENTS = new Set(["node_modules", "99-archive"]);
export const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

export interface CatalogCacheStat {
  mtimeMs: number;
  size: number;
}

/**
 * Scan cache keyed by absolute file path. An entry is reused only while the
 * file's `{mtimeMs, size}` fingerprint is unchanged.
 */
export class CatalogCache {
  private readonly entries = new Map<string, { stat: CatalogCacheStat; entry: CatalogEntry }>();

  peek(path: string): CatalogCacheStat | undefined {
    return this.entries.get(path)?.stat;
  }

  get(path: string, current: CatalogCacheStat): CatalogEntry | undefined {
    const hit = this.entries.get(path);
    if (!hit) return undefined;
    if (hit.stat.mtimeMs !== current.mtimeMs || hit.stat.size !== current.size) return undefined;
    return hit.entry;
  }

  set(path: string, current: CatalogCacheStat, entry: CatalogEntry): void {
    this.entries.set(path, { stat: current, entry });
  }
}

export interface ScanOptions {
  /** Reuse parsed frontmatter for files whose mtime/size are unchanged. */
  cache?: CatalogCache;
  /** Extra path segments to skip below the roots (from okf.json `exclude`). */
  exclude?: string[];
}

export type CatalogRoots = Record<CatalogKind, string[]>;

/**
 * Walk each root recursively and index skills, docs, and agents from
 * frontmatter only. Never throws for individual files: unreadable or
 * frontmatter-less files yield minimal entries or are skipped, per OKF §11.
 */
export async function scanCatalog(roots: CatalogRoots, opts: ScanOptions = {}): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>(); // `${kind}:${name}` — first wins

  for (const kind of CATALOG_KINDS) {
    for (const root of roots[kind] ?? []) {
      const files = await walkRoot(root, kind, opts.exclude);
      for (const file of files) {
        const entry = await indexFile(kind, root, file, opts.cache);
        if (!entry) continue;
        const key = `${entry.kind}:${entry.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
  }

  return entries;
}

/** Skill roots use the OpenCode convention: a skill is a `<dir>/SKILL.md` file. */
const SKILL_FILE = "SKILL.md";

async function walkRoot(root: string, kind: CatalogKind, exclude?: string[]): Promise<string[]> {
  const files: string[] = [];
  const excludeSet = new Set(exclude ?? []);
  await walk(root, root, kind, files, excludeSet);
  return files;
}

async function walk(root: string, dir: string, kind: CatalogKind, out: string[], exclude: Set<string>): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable root: skipped silently
  }

  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name.startsWith(".") || EXCLUDED_SEGMENTS.has(dirent.name) || exclude.has(dirent.name)) {
        continue;
      }
      await walk(root, full, kind, out, exclude);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!dirent.name.toLowerCase().endsWith(".md")) continue;
    if (RESERVED_FILENAMES.has(dirent.name)) continue; // OKF §3.1 navigational files
    if (kind === "skill" && dirent.name !== SKILL_FILE) continue;
    out.push(full);
  }
}

async function indexFile(
  kind: CatalogKind,
  root: string,
  path: string,
  cache?: CatalogCache,
): Promise<CatalogEntry | undefined> {
  let currentStat: CatalogCacheStat;
  try {
    const info = await stat(path);
    currentStat = { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }

  if (cache) {
    const cached = cache.get(path, currentStat);
    if (cached) return cached;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseFrontmatter(raw);
  const data = parsed.ok ? parsed.data : {};
  const relToRoot = relative(root, path);
  const section = parentSection(relToRoot);

  const entry = buildEntry(kind, path, root, section, data);
  cache?.set(path, currentStat, entry);
  return entry;
}

export function buildEntry(
  kind: CatalogKind,
  path: string,
  root: string,
  section: string | undefined,
  data: Record<string, unknown>,
): CatalogEntry {
  const fileName = path.split(sep).pop() ?? path;
  const baseName = fileName.replace(/\.md$/i, "");

  let name: string;
  if (kind === "skill") {
    // skill: frontmatter `name`, else the directory name (degenerate
    // root-level SKILL.md: the root's basename).
    const fmName = readString(data["name"]);
    const dirName = section ? section.split("/").pop()! : root.split(sep).filter(Boolean).pop() ?? baseName;
    name = fmName ?? dirName;
  } else if (kind === "agent") {
    // agent: frontmatter `name`, else the filename
    name = readString(data["name"]) ?? baseName;
  } else {
    // doc: the filename slug
    name = baseName;
  }

  const generated = readMap(data["generated"]);
  return {
    kind,
    name,
    title: readString(data["title"]),
    description: readString(data["description"]) ?? "",
    tags: readTags(data["tags"]),
    status: normalizeStatus(data["status"]),
    path,
    section,
    okfType: readString(data["type"]),
    resource: readString(data["resource"]),
    staleAfter: readString(data["stale_after"]),
    generatedAt: readString(generated?.["at"]),
    trustTier: deriveTrustTier(data["verified"]),
    root,
  };
}

/** Directory portion of a root-relative path in POSIX form, minus the filename. */
function parentSection(relPath: string): string | undefined {
  const posix = relPath.split(sep).join("/");
  const idx = posix.lastIndexOf("/");
  if (idx === -1) return undefined;
  return posix.slice(0, idx);
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readMap(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length > 0) tags.push(trimmed);
  }
  return tags;
}

/** Staleness convenience so consumers share one OKF reading. */
export function entryIsStale(entry: CatalogEntry, now: Date = new Date()): boolean {
  return isStale(entry.staleAfter, now);
}
