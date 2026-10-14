/**
 * Pure ASCII layout of the OKF link graph (§6) for the /okf-graph overlay.
 * The function returns unstyled, deterministic strings; the popup component
 * applies theme colors (whole-line styling keyed on the exported markers).
 *
 * Selection mirrors `LinkGraph.toMermaid` exactly: every catalog node starts
 * at degree 0, each link adds 1 to its source and (when resolved to a catalog
 * entry) its target; nodes rank degree-descending with ties broken by path
 * ascending; the pool caps at `maxNodes` (default 12, local to this view —
 * toMermaid keeps its own default of 40). Only edges whose endpoints are both
 * in the selection are drawn; links to capped-out nodes disappear, while
 * broken targets (§6.1) always render under their source, marked with ✗.
 *
 * Layout convention (single convention, pinned by tests):
 * 1. Sources with rendered outgoing targets print `name ──▶ firstTarget`,
 *    further targets indented as `  └─▶ target`, in the source document's
 *    first-seen link order (extractLinks order — deterministic).
 * 2. Selected nodes with no rendered outgoing target but at least one drawn
 *    incoming edge are NOT listed separately: they already appear as targets
 *    under their sources, so every drawn edge renders exactly once.
 * 3. Remaining selected nodes (no drawn edges at all) are listed under an
 *    `isolated:` marker line, in selection order.
 *
 * Node labels are catalog entry names (same label rule as toMermaid). No
 * line has trailing whitespace; the caller truncates to the viewport width.
 */
import type { CatalogEntry } from "./catalog.ts";
import type { GraphStats, LinkGraph } from "./graph.ts";

/** Marker line heading the isolated-node group (no drawn edges). */
export const ASCII_ISOLATED_MARKER = "isolated:";
/** Marker appended to broken (§6.1) link targets. */
export const ASCII_BROKEN_MARK = " ✗";
/** Single-line body for a graph with no catalog entries. */
export const ASCII_EMPTY_GRAPH = "(empty graph)";

const ARROW = " ──▶ ";
const CONTINUATION = "  └─▶ ";
const ISOLATED_INDENT = "  ";
/** Cap local to the ASCII view; toMermaid keeps its own default of 40. */
const DEFAULT_MAX_NODES = 12;

export interface AsciiGraphOptions {
  /** Selected-node cap (degree desc, path asc); clamped like toMermaid. */
  maxNodes?: number;
}

export interface AsciiGraphResult {
  lines: string[];
  stats: GraphStats;
  shownNodes: number;
  totalNodes: number;
}

/** Render the link graph as bounded, deterministic ASCII lines. */
export function toAsciiGraph(graph: LinkGraph, opts: AsciiGraphOptions = {}): AsciiGraphResult {
  const stats = graph.graphStats();
  const nodes = graph.nodes();

  if (nodes.length === 0) {
    return { lines: [ASCII_EMPTY_GRAPH], stats, shownNodes: 0, totalNodes: 0 };
  }

  const maxNodes = Math.max(0, Math.floor(opts.maxNodes ?? DEFAULT_MAX_NODES));
  const byPath = new Map<string, CatalogEntry>(nodes.map((entry) => [entry.path, entry]));
  const labelFor = (path: string): string => byPath.get(path)?.name ?? path;

  // Degree pool over ALL catalog nodes — same rule as LinkGraph.toMermaid.
  const degrees = new Map<string, number>(nodes.map((entry) => [entry.path, 0]));
  for (const node of nodes) {
    for (const edge of graph.outgoing(node.path)) {
      degrees.set(edge.sourcePath, (degrees.get(edge.sourcePath) ?? 0) + 1);
      if (edge.entry) degrees.set(edge.entry.path, (degrees.get(edge.entry.path) ?? 0) + 1);
    }
  }

  const selected = [...degrees.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxNodes)
    .map(([path]) => path);
  const selectedSet = new Set(selected);

  // Rendered outgoing targets per selected source, first-seen link order.
  // Broken targets always render (marked); resolved targets only when the
  // target node is also selected (same capping as toMermaid).
  const drawnTargets = new Map<string, string[]>();
  const drawnIncoming = new Set<string>();
  for (const path of selected) {
    const targets: string[] = [];
    for (const edge of graph.outgoing(path)) {
      if (edge.broken) {
        targets.push(`${edge.rawTarget}${ASCII_BROKEN_MARK}`);
      } else if (edge.entry && selectedSet.has(edge.entry.path)) {
        targets.push(labelFor(edge.entry.path));
        drawnIncoming.add(edge.entry.path);
      }
    }
    if (targets.length > 0) drawnTargets.set(path, targets);
  }

  const lines: string[] = [];
  // Group 1: sources with rendered outgoing targets (selection order).
  for (const path of selected) {
    const targets = drawnTargets.get(path);
    if (!targets) continue;
    const [first, ...rest] = targets;
    lines.push(`${labelFor(path)}${ARROW}${first}`);
    for (const target of rest) lines.push(`${CONTINUATION}${target}`);
  }
  // Group 2 (incoming-only nodes) is intentionally not printed: those nodes
  // already appear as targets under their sources (see module doc).
  // Group 3: isolated selected nodes (no drawn edges at all).
  const isolated = selected.filter((path) => !drawnTargets.has(path) && !drawnIncoming.has(path));
  if (isolated.length > 0) {
    lines.push(ASCII_ISOLATED_MARKER);
    for (const path of isolated) lines.push(`${ISOLATED_INDENT}${labelFor(path)}`);
  }

  return { lines, stats, shownNodes: selected.length, totalNodes: nodes.length };
}
