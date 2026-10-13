import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CatalogEntry, CatalogKind, CatalogRoots } from "./catalog.ts";

/**
 * OKF §6 link graph. Links are standard markdown links; `/x.md` targets are
 * bundle-relative (tried against the entry's root, then each root of the
 * entry's kind), other targets are resolved against the source file's
 * directory. Broken links are tolerated and kept (§6.1), never rejected.
 */

const MARKDOWN_LINK = /\[[^\]\n]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Extract markdown link targets from a body: `.md` targets only, deduped, first-seen order. */
export function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const target = match[1];
    if (!target || !isConceptLink(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push(target);
  }
  return links;
}

function isConceptLink(target: string): boolean {
  if (!target.toLowerCase().endsWith(".md")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // http:, https:, mailto:, …
  if (target.startsWith("#")) return false; // pure in-page anchor
  return true;
}

/** One directed link from a source document to its (resolved or broken) target. */
export interface LinkEdge {
  sourcePath: string;
  /** Target exactly as written in the markdown. */
  rawTarget: string;
  /** Absolute path the target resolved to, when a path could be derived. */
  targetPath?: string;
  /** Catalog entry at the target, when the target exists in the catalog. */
  entry?: CatalogEntry;
  /** True when the target does not exist in the catalog (OKF §6.1 tolerates this). */
  broken: boolean;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  broken: number;
}

export interface BuildGraphOptions {
  /** Roots used to resolve bundle-relative `/x.md` targets, per kind. */
  roots?: CatalogRoots;
  /** Body reader override (defaults to fs.readFile); useful for tests. */
  read?: (path: string) => Promise<string>;
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

/**
 * Directed link graph over catalog entries, with `{mtimeMs, size}` cache
 * invalidation mirroring CatalogCache: rebuilds re-read only changed files.
 */
export class LinkGraph {
  private nodesByPath = new Map<string, CatalogEntry>();
  private outgoingBySource = new Map<string, LinkEdge[]>();
  private backlinksByTarget = new Map<string, LinkEdge[]>();
  private fingerprints = new Map<string, FileFingerprint>();
  private linkCache = new Map<string, string[]>(); // path -> raw targets
  private roots?: CatalogRoots;
  private edgeCount = 0;
  private brokenCount = 0;

  /**
   * (Re)build the graph from catalog entries. Files whose fingerprint is
   * unchanged keep their cached link extraction.
   */
  async rebuild(entries: CatalogEntry[], opts: BuildGraphOptions = {}): Promise<void> {
    this.roots = opts.roots;
    const read = opts.read ?? ((path: string) => readFile(path, "utf8"));

    this.nodesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    this.outgoingBySource = new Map();
    this.backlinksByTarget = new Map();
    this.edgeCount = 0;
    this.brokenCount = 0;

    // Drop cache entries for files that vanished.
    const livePaths = new Set(entries.map((entry) => entry.path));
    for (const path of [...this.linkCache.keys()]) {
      if (!livePaths.has(path)) {
        this.linkCache.delete(path);
        this.fingerprints.delete(path);
      }
    }

    for (const entry of entries) {
      const targets = await this.targetsFor(entry, read);
      const edges = targets.map((rawTarget) => this.resolveEdge(entry, rawTarget));
      this.outgoingBySource.set(entry.path, edges);
      for (const edge of edges) {
        this.edgeCount += 1;
        if (edge.broken) this.brokenCount += 1;
        if (edge.entry) {
          const backlinks = this.backlinksByTarget.get(edge.entry.path) ?? [];
          backlinks.push(edge);
          this.backlinksByTarget.set(edge.entry.path, backlinks);
        }
      }
    }
  }

  private async targetsFor(entry: CatalogEntry, read: (path: string) => Promise<string>): Promise<string[]> {
    let fingerprint: FileFingerprint;
    try {
      const info = await stat(entry.path);
      fingerprint = { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return [];
    }

    const cached = this.fingerprints.get(entry.path);
    if (
      cached &&
      cached.mtimeMs === fingerprint.mtimeMs &&
      cached.size === fingerprint.size &&
      this.linkCache.has(entry.path)
    ) {
      return this.linkCache.get(entry.path)!;
    }

    let body = "";
    try {
      body = await read(entry.path);
    } catch {
      body = "";
    }
    const targets = extractLinks(body);
    this.fingerprints.set(entry.path, fingerprint);
    this.linkCache.set(entry.path, targets);
    return targets;
  }

  private resolveEdge(entry: CatalogEntry, rawTarget: string): LinkEdge {
    const targetPath = this.resolveTarget(entry, rawTarget);
    if (targetPath === undefined) {
      return { sourcePath: entry.path, rawTarget, broken: true };
    }
    const targetEntry = this.nodesByPath.get(targetPath);
    if (!targetEntry) {
      return { sourcePath: entry.path, rawTarget, targetPath, broken: true };
    }
    return { sourcePath: entry.path, rawTarget, targetPath, entry: targetEntry, broken: false };
  }

  private resolveTarget(entry: CatalogEntry, rawTarget: string): string | undefined {
    const decoded = rawTarget.split("#")[0];
    if (decoded.length === 0) return undefined;

    if (decoded.startsWith("/")) {
      // Bundle-relative (OKF §6.1): the entry's own root first, then each
      // configured root of the entry's kind. Prefer the candidate that
      // actually exists in the catalog; otherwise keep the first candidate
      // as a (broken) target path.
      const candidates: string[] = [];
      if (entry.root) candidates.push(entry.root);
      for (const root of this.roots?.[entry.kind as CatalogKind] ?? []) {
        if (!candidates.includes(root)) candidates.push(root);
      }
      if (candidates.length === 0) return undefined;
      const attempts = candidates.map((root) => join(root, decoded.replace(/^\//, "")));
      for (const attempt of attempts) {
        if (this.nodesByPath.has(attempt)) return attempt;
      }
      return attempts[0];
    }

    // Relative target: resolve against the source file's directory.
    return join(dirname(entry.path), decoded);
  }

  /** Edges leaving `path`. */
  outgoing(path: string): LinkEdge[] {
    return [...(this.outgoingBySource.get(path) ?? [])];
  }

  /** The catalog entry at `path`, when the graph was built over it. */
  entryAt(path: string): CatalogEntry | undefined {
    return this.nodesByPath.get(path);
  }

  /** Edges from other documents into `path`. */
  backlinks(path: string): LinkEdge[] {
    return [...(this.backlinksByTarget.get(path) ?? [])];
  }

  /** Distinct catalog entries connected to `path` in either direction. */
  neighbors(path: string): CatalogEntry[] {
    const seen = new Set<string>([path]);
    const result: CatalogEntry[] = [];
    const push = (connected?: string): void => {
      if (!connected || seen.has(connected)) return;
      seen.add(connected);
      const entry = this.nodesByPath.get(connected);
      if (entry) result.push(entry);
    };
    for (const edge of this.outgoing(path)) push(edge.entry?.path);
    // For backlinks the neighbor is the linking document (the edge source).
    for (const edge of this.backlinks(path)) push(edge.sourcePath);
    return result;
  }

  graphStats(): GraphStats {
    return { nodes: this.nodesByPath.size, edges: this.edgeCount, broken: this.brokenCount };
  }

  /**
   * Bounded Mermaid `flowchart LR` source. Nodes are ranked by degree
   * (highest first, ties broken by path for stable output) and capped at
   * `maxNodes`; only edges between selected nodes are drawn. Links are
   * untyped (§6).
   */
  toMermaid(maxNodes: number = 40): string {
    const degrees = new Map<string, number>();
    for (const path of this.nodesByPath.keys()) degrees.set(path, 0);
    const edges: LinkEdge[] = [];
    for (const list of this.outgoingBySource.values()) edges.push(...list);

    for (const edge of edges) {
      if (edge.entry) {
        degrees.set(edge.entry.path, (degrees.get(edge.entry.path) ?? 0) + 1);
      }
      degrees.set(edge.sourcePath, (degrees.get(edge.sourcePath) ?? 0) + 1);
    }

    const selected = [...degrees.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, Math.max(0, Math.floor(maxNodes)));
    const selectedSet = new Set(selected.map(([path]) => path));

    const lines: string[] = ["flowchart LR"];
    if (selected.length === 0) {
      lines.push("    %% empty graph");
      return lines.join("\n");
    }

    const ids = new Map<string, string>();
    selected.forEach(([path], index) => {
      const id = `n${index}`;
      ids.set(path, id);
      const entry = this.nodesByPath.get(path);
      lines.push(`    ${id}["${mermaidLabel(entry?.name ?? path)}"]`);
    });

    let drawn = 0;
    for (const edge of edges) {
      if (drawn >= MERMAID_MAX_EDGES) break;
      const sourceId = ids.get(edge.sourcePath);
      const targetId = edge.entry ? ids.get(edge.entry.path) : undefined;
      if (!sourceId || !targetId) continue;
      lines.push(`    ${sourceId} --> ${targetId}`);
      drawn += 1;
    }
    if (drawn === 0) lines.push("    %% no edges within selected nodes");
    return lines.join("\n");
  }
}

const MERMAID_MAX_EDGES = 120;

function mermaidLabel(label: string): string {
  return label.replace(/["\\]/g, " ").trim() || "unnamed";
}

/** Convenience factory: build a fully-populated graph in one call. */
export async function buildLinkGraph(entries: CatalogEntry[], opts: BuildGraphOptions = {}): Promise<LinkGraph> {
  const graph = new LinkGraph();
  await graph.rebuild(entries, opts);
  return graph;
}
