/**
 * okf-god: a pi extension indexing Open Knowledge Format v0.2 resources
 * (skills, docs, agents) with requirement-based lazy loading, §6 graph
 * navigation, and per-session usage tracking.
 *
 * Everything heavy is lazy: the factory body registers tools, commands, and
 * event handlers only; the catalog and link graph are built on first use or
 * after session_start, never in the factory body.
 */
import { isAbsolute, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CatalogCache,
  scanCatalog,
  type CatalogEntry,
  type CatalogKind,
  type CatalogRoots,
  CATALOG_KINDS,
} from "./catalog.ts";
import { buildLinkGraph, type LinkGraph } from "./graph.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { readResource } from "./reader.ts";
import { configExclude, loadConfig, resolveRoots } from "./roots.ts";
import { searchEntries } from "./search.ts";
import { isStale } from "./trust.ts";
import { buildUsageRows, UsagePopupComponent } from "./usage-popup.ts";
import { isUsageEvent, UsageRegistry, type UsageEvent, type UsageSource } from "./usage.ts";

const USAGE_ENTRY_TYPE = "okf-god:usage";
const WIDGET_ID = "okf-god";
const LIST_DESCRIPTION_WIDTH = 80;
const LINK_NAME_CAP = 5;
const COMMAND_TEXT_CAP = 1200;

interface CatalogState {
  entries: CatalogEntry[];
  roots: CatalogRoots;
  cache: CatalogCache;
}

/** Default export: the extension factory (sync, no heavy work). */
export default function okfGodExtension(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  let catalogPromise: Promise<CatalogState> | null = null;
  let graphPromise: Promise<LinkGraph> | null = null;
  const usage = new UsageRegistry();
  const pendingReads = new Map<string, CatalogEntry>();

  // --- lazy state ---------------------------------------------------------

  function ensureCatalog(): Promise<CatalogState> {
    if (!catalogPromise) {
      const state = (async (): Promise<CatalogState> => {
        const config = await loadConfig(cwd);
        const roots = resolveRoots(cwd, config);
        const cache = new CatalogCache();
        const entries = await scanCatalog(roots, { cache, exclude: configExclude(config) });
        return { entries, roots, cache };
      })();
      // On failure, allow a later retry instead of caching the rejection.
      catalogPromise = state.catch((error) => {
        catalogPromise = null;
        throw error;
      });
    }
    return catalogPromise;
  }

  function ensureGraph(): Promise<LinkGraph> {
    if (!graphPromise) {
      const graph = ensureCatalog().then((state) => buildLinkGraph(state.entries, { roots: state.roots }));
      graphPromise = graph.catch((error) => {
        graphPromise = null;
        throw error;
      });
    }
    return graphPromise;
  }

  function invalidateCaches(): void {
    catalogPromise = null;
    graphPromise = null;
  }

  // --- usage tracking and widget -----------------------------------------

  function recordUsage(event: UsageEvent, ctx?: ExtensionContext): void {
    usage.record(event);
    try {
      pi.appendEntry(USAGE_ENTRY_TYPE, event);
    } catch {
      // persistence is best-effort; never crash the session over it
    }
    if (ctx) updateUsageWidget(ctx);
  }

  function updateUsageWidget(ctx: ExtensionContext): void {
    try {
      if (!ctx.hasUI) return;
      const counts = usage.counts();
      const total = counts.skill + counts.doc + counts.agent;
      if (total === 0) {
        ctx.ui.setWidget(WIDGET_ID, undefined, { placement: "belowEditor" });
        return;
      }
      const parts: string[] = [];
      if (counts.skill > 0) parts.push(`${counts.skill} skill${counts.skill === 1 ? "" : "s"}`);
      if (counts.doc > 0) parts.push(`${counts.doc} doc${counts.doc === 1 ? "" : "s"}`);
      if (counts.agent > 0) parts.push(`${counts.agent} agent${counts.agent === 1 ? "" : "s"}`);
      ctx.ui.setWidget(WIDGET_ID, [`OKF ▸ ${parts.join(" · ")} (this session)`], { placement: "belowEditor" });
    } catch {
      // widget failures must never crash the session
    }
  }

  function warn(ctx: ExtensionContext, error: unknown): void {
    try {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`okf-god: ${message}`, "warning");
    } catch {
      // ignore
    }
  }

  // --- resolution helpers -------------------------------------------------

  async function resolveEntry(query: { path?: string; name?: string }): Promise<CatalogEntry | string> {
    const state = await ensureCatalog();
    const trimmedPath = query.path?.trim();
    const trimmedName = query.name?.trim();

    if (trimmedPath) {
      const exact = state.entries.find((entry) => entry.path === trimmedPath);
      if (exact) return exact;
      if (!trimmedName) {
        return `No catalog entry has path ${trimmedPath}. Use okf_search first, or pass a resource name.`;
      }
    }

    if (trimmedName) {
      const matches = state.entries.filter((entry) => entry.name === trimmedName);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        const listed = matches.map((entry) => `${entry.kind}:${entry.name} (${entry.path})`).join(", ");
        return `Name "${trimmedName}" is ambiguous across kinds: ${listed}. Pass an exact path instead.`;
      }
      return `No catalog entry named "${trimmedName}". Try okf_search to find resource names.`;
    }

    return "Provide either a resource path or a resource name.";
  }

  // --- tools ---------------------------------------------------------------

  const kindSchema = Type.Union(
    [Type.Literal("skill"), Type.Literal("doc"), Type.Literal("agent")],
    { description: "Restrict to one catalog kind" },
  );

  function textResult(text: string, details: unknown) {
    return { content: [{ type: "text" as const, text }], details };
  }

  function describeEntry(entry: CatalogEntry): string {
    const signals: string[] = [entry.status ?? "stable"];
    signals.push(entry.trustTier ?? "unverified");
    return `${entry.kind}/${entry.name} · ${signals.join(" · ")}`;
  }

  function truncate(text: string, width: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
  }

  pi.registerTool({
    name: "okf_search",
    label: "OKF Search",
    description:
      "Search the OKF knowledge catalog (skills, docs, agents) by keyword. " +
      "Returns ranked entries with status and trust signals.",
    promptSnippet: "Search the OKF catalog of skills, docs, and agents before reading resources",
    promptGuidelines: [
      "Use okf_search to discover OKF resources, then okf_read to load one.",
      "Prefer human-reviewed resources over unverified ones; check the stale flag.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to search for (e.g. 'deploy bigquery')" }),
      kind: Type.Optional(kindSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const state = await ensureCatalog();
        const matches = searchEntries(state.entries, params.query, { kind: params.kind });
        if (matches.length === 0) {
          return textResult(`No OKF resources match "${params.query}".`, { results: [] });
        }
        const lines = matches.map((match, index) => {
          const desc = match.entry.description ? ` — ${truncate(match.entry.description, 100)}` : "";
          return `${index + 1}. ${describeEntry(match.entry)} · score ${match.score.toFixed(1)}${desc}`;
        });
        const header = `OKF search "${params.query}"${params.kind ? ` (${params.kind}s only)` : ""} — ${matches.length} match${matches.length === 1 ? "" : "es"}:`;
        return textResult([header, ...lines].join("\n"), {
          results: matches.map((match) => ({ kind: match.entry.kind, name: match.entry.name, path: match.entry.path })),
        });
      } catch (error) {
        warn(ctx, error);
        return textResult(`okf_search failed: ${error instanceof Error ? error.message : String(error)}`, { results: [] });
      }
    },
  });

  pi.registerTool({
    name: "okf_read",
    label: "OKF Read",
    description:
      "Read an OKF resource by path or unique name. Returns the content with a frontmatter " +
      "summary (type, resource, status, trust tier, staleness, source count) and its link " +
      "graph neighborhood so you can navigate to related resources.",
    promptSnippet: "Load an OKF resource with trust/lifecycle signals and related links",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Exact resource file path (from okf_search)" })),
      name: Type.Optional(Type.String({ description: "Unique resource name (alternative to path)" })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters of body content to return" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const resolved = await resolveEntry(params);
        if (typeof resolved === "string") {
          return textResult(resolved, { error: resolved });
        }
        const entry = resolved;

        const [read, graph] = await Promise.all([
          readResource(entry, params.maxChars ?? undefined),
          ensureGraph().catch(() => undefined),
        ]);

        recordUsage(
          { kind: entry.kind, name: entry.name, path: entry.path, source: "okf_read", ts: Date.now() },
          ctx,
        );

        // Frontmatter summary: re-parse from the (top of the) content; frontmatter
        // sits at the top, so truncation does not affect it. Sources are not kept
        // in the catalog, so their count is summarized here (§5.1).
        const parsed = parseFrontmatter(read.text);
        const data = parsed.ok ? parsed.data : {};
        const sourcesCount = countSources(data["sources"]);

        const summary: string[] = [
          `# ${entry.name} (${entry.kind})`,
          `type: ${entry.okfType ?? "unknown"} · status: ${entry.status ?? "stable"} · trust: ${entry.trustTier ?? "unverified"}`,
        ];
        if (entry.resource) summary.push(`resource: ${entry.resource}`);
        if (entry.generatedAt) summary.push(`generated: ${entry.generatedAt}`);
        summary.push(
          isStale(entry.staleAfter)
            ? `STALE: content is past its stale_after (${entry.staleAfter}) — verify before relying on it`
            : `stale: no${entry.staleAfter ? ` (stale_after ${entry.staleAfter})` : ""}`,
        );
        summary.push(`sources: ${sourcesCount}`);

        const lines = [...summary];
        if (graph) {
          lines.push(linksSection(entry, graph));
        }
        lines.push("", read.text);
        return textResult(lines.join("\n"), { kind: entry.kind, name: entry.name, path: entry.path, truncated: read.truncated });
      } catch (error) {
        warn(ctx, error);
        return textResult(`okf_read failed: ${error instanceof Error ? error.message : String(error)}`, { error: String(error) });
      }
    },
  });

  function linksSection(entry: CatalogEntry, graph: LinkGraph): string {
    const outgoing = graph.outgoing(entry.path);
    const backlinks = graph.backlinks(entry.path);
    const outgoingNames = outgoing.filter((edge) => edge.entry).map((edge) => edge.entry!.name);
    const backlinkNames = backlinks
      .map((edge) => graph.entryAt(edge.sourcePath)?.name)
      .filter((name): name is string => name !== undefined);
    const parts: string[] = [];
    parts.push(
      outgoingNames.length > 0
        ? `→ ${outgoingNames.slice(0, LINK_NAME_CAP).join(", ")}` +
            (outgoingNames.length > LINK_NAME_CAP ? ` (+${outgoingNames.length - LINK_NAME_CAP} more)` : "")
        : `→ none (${outgoing.length} raw links)`,
    );
    parts.push(
      backlinkNames.length > 0
        ? `← ${backlinkNames.slice(0, LINK_NAME_CAP).join(", ")}` +
            (backlinkNames.length > LINK_NAME_CAP ? ` (+${backlinkNames.length - LINK_NAME_CAP} more)` : "")
        : "← none",
    );
    return `Links: ${parts.join(" | ")}`;
  }

  pi.registerTool({
    name: "okf_links",
    label: "OKF Links",
    description:
      "List resources graph-linked to an OKF resource (OKF §6): outgoing links, backlinks, or " +
      "both. Broken links are marked, never rejected.",
    promptSnippet: "Navigate the OKF link graph around a resource",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Exact resource file path" })),
      name: Type.Optional(Type.String({ description: "Unique resource name (alternative to path)" })),
      direction: Type.Optional(
        Type.Union([Type.Literal("out"), Type.Literal("back"), Type.Literal("both")], {
          description: "Which links to list (default: both)",
        }),
      ),
      max: Type.Optional(Type.Number({ description: "Maximum links per direction (default 10)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const resolved = await resolveEntry(params);
        if (typeof resolved === "string") {
          return textResult(resolved, { error: resolved });
        }
        const entry = resolved;
        const graph = await ensureGraph();
        const direction = params.direction ?? "both";
        const cap = params.max ?? 10;

        const lines: string[] = [`Links for ${entry.kind}/${entry.name} (${direction}):`];
        let total = 0;
        if (direction !== "back") {
          for (const edge of graph.outgoing(entry.path).slice(0, cap)) {
            total += 1;
            lines.push(
              edge.entry
                ? `→ ${edge.entry.kind}/${edge.entry.name} · ${edge.entry.status ?? "stable"}`
                : `→ (broken) ${edge.rawTarget}`,
            );
          }
        }
        if (direction !== "out") {
          for (const edge of graph.backlinks(entry.path).slice(0, cap)) {
            total += 1;
            const source = graph.entryAt(edge.sourcePath);
            lines.push(
              source
                ? `← ${source.kind}/${source.name} · ${source.status ?? "stable"}`
                : `← (unknown source) ${edge.sourcePath}`,
            );
          }
        }
        if (total === 0) lines.push("(no links in this direction)");
        return textResult(lines.join("\n"), { kind: entry.kind, name: entry.name, path: entry.path, links: total });
      } catch (error) {
        warn(ctx, error);
        return textResult(`okf_links failed: ${error instanceof Error ? error.message : String(error)}`, { error: String(error) });
      }
    },
  });

  pi.registerTool({
    name: "okf_list",
    label: "OKF List",
    description: "List cataloged OKF resources (optionally one kind) as a compact table with status.",
    promptSnippet: "List available OKF skills, docs, and agents",
    parameters: Type.Object({
      kind: Type.Optional(kindSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const state = await ensureCatalog();
        const entries = params.kind ? state.entries.filter((entry) => entry.kind === params.kind) : state.entries;
        if (entries.length === 0) {
          return textResult("The OKF catalog is empty for this selection.", { count: 0 });
        }
        const lines = entries.slice(0, 50).map((entry) => {
          const desc = truncate(entry.description, LIST_DESCRIPTION_WIDTH);
          return `${entry.name} (${entry.kind}) · ${entry.status ?? "stable"} — ${desc}`;
        });
        if (entries.length > 50) lines.push(`… and ${entries.length - 50} more`);
        return textResult(
          [`OKF catalog — ${entries.length} resource${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
          {
            count: entries.length,
            entries: entries.slice(0, 50).map((entry) => ({ kind: entry.kind, name: entry.name, path: entry.path })),
          },
        );
      } catch (error) {
        warn(ctx, error);
        return textResult(`okf_list failed: ${error instanceof Error ? error.message : String(error)}`, { error: String(error) });
      }
    },
  });

  // --- commands -------------------------------------------------------------

  const kindCompletions = (prefix: string) => {
    const filtered = CATALOG_KINDS.filter((kind) => kind.startsWith(prefix));
    return filtered.length > 0 ? filtered.map((kind) => ({ value: kind, label: kind })) : null;
  };

  async function listText(kind?: string): Promise<string> {
    const state = await ensureCatalog();
    const valid = CATALOG_KINDS.includes(kind as CatalogKind) ? (kind as CatalogKind) : undefined;
    const entries = valid ? state.entries.filter((entry) => entry.kind === valid) : state.entries;
    if (entries.length === 0) return "OKF catalog is empty.";
    const lines = entries.slice(0, 30).map((entry) => {
      const desc = truncate(entry.description, LIST_DESCRIPTION_WIDTH);
      return `${entry.name} (${entry.kind}) · ${entry.status ?? "stable"} — ${desc}`;
    });
    if (entries.length > 30) lines.push(`… and ${entries.length - 30} more`);
    return lines.join("\n");
  }

  pi.registerCommand("okf-list", {
    description: "List OKF catalog resources (optionally: skill | doc | agent)",
    getArgumentCompletions: kindCompletions,
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(await listText(args.trim() || undefined), "info");
      } catch (error) {
        warn(ctx, error);
      }
    },
  });

  pi.registerCommand("okf-links", {
    description: "Show graph links around an OKF resource: /okf-links <name>",
    handler: async (args, ctx) => {
      try {
        const name = args.trim();
        if (!name) {
          ctx.ui.notify("Usage: /okf-links <resource-name>", "warning");
          return;
        }
        const state = await ensureCatalog();
        const matches = state.entries.filter((entry) => entry.name === name);
        if (matches.length !== 1) {
          ctx.ui.notify(
            matches.length === 0
              ? `No OKF resource named "${name}".`
              : `"${name}" is ambiguous (${matches.map((entry) => entry.kind).join(", ")}).`,
            "warning",
          );
          return;
        }
        const entry = matches[0]!;
        const graph = await ensureGraph();
        const out = graph.outgoing(entry.path).map((edge) => edge.entry ? `→ ${edge.entry.kind}/${edge.entry.name}` : `→ (broken) ${edge.rawTarget}`);
        const back = graph.backlinks(entry.path).map((edge) => {
          const source = graph.entryAt(edge.sourcePath);
          return source ? `← ${source.kind}/${source.name}` : `← (unknown) ${edge.sourcePath}`;
        });
        const lines = [`${entry.kind}/${entry.name}:`, ...out, ...back];
        ctx.ui.notify(boundText(lines.join("\n")), "info");
      } catch (error) {
        warn(ctx, error);
      }
    },
  });

  pi.registerCommand("okf-graph", {
    description: "Show a bounded Mermaid view of the OKF link graph",
    handler: async (_args, ctx) => {
      try {
        const graph = await ensureGraph();
        // Command handlers return void (no model-facing return), so the graph
        // is surfaced as a bounded notification.
        ctx.ui.notify(boundText(graph.toMermaid(40)), "info");
      } catch (error) {
        warn(ctx, error);
      }
    },
  });

  pi.registerCommand("okf-usage", {
    description: "Show OKF resource usage for this session",
    handler: async (_args, ctx) => {
      try {
        const counts = usage.counts();
        const total = counts.skill + counts.doc + counts.agent;
        if (total === 0) {
          ctx.ui.notify("No OKF resources used this session yet.", "info");
          return;
        }
        // Catalog failure must not break the popup: rows fall back to names.
        let titles = new Map<string, string>();
        try {
          const state = await ensureCatalog();
          titles = new Map(state.entries.map((entry) => [entry.path, entry.title || entry.name]));
        } catch {
          // catalog unavailable — names only
        }
        const events = usage.events();
        if (!ctx.hasUI) {
          const recent = events
            .slice(0, 8)
            .map((event) => `${event.kind}/${event.name} (${event.source})`);
          ctx.ui.notify(
            boundText(
              `OKF usage — ${counts.skill} skills · ${counts.doc} docs · ${counts.agent} agents\n` +
                recent.join("\n"),
            ),
            "info",
          );
          return;
        }
        const rows = buildUsageRows(events, { cwd, titleFor: (event) => titles.get(event.path) });
        await ctx.ui.custom<void>((_tui, theme, _kb, done) => new UsagePopupComponent(rows, theme, done), {
          overlay: true,
          overlayOptions: { anchor: "center", width: 72, maxHeight: 20 },
        });
      } catch (error) {
        warn(ctx, error);
      }
    },
  });

  pi.registerCommand("okf-reload", {
    description: "Rescan the OKF catalog and rebuild the link graph",
    handler: async (_args, ctx) => {
      try {
        invalidateCaches();
        const state = await ensureCatalog();
        await ensureGraph();
        const byKind = countByKind(state.entries);
        ctx.ui.notify(
          `OKF catalog reloaded: ${byKind.skill} skills · ${byKind.doc} docs · ${byKind.agent} agents`,
          "info",
        );
      } catch (error) {
        warn(ctx, error);
      }
    },
  });

  // --- session lifecycle ------------------------------------------------------

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    try {
      cwd = ctx.cwd || process.cwd();
      // Reconstruct branch-sensitive usage from the active branch (never from
      // every file entry — abandoned branches are alternative histories).
      usageRestoreFromBranch(ctx);
      updateUsageWidget(ctx);
    } catch (error) {
      warn(ctx, error);
    }
  });

  function usageRestoreFromBranch(ctx: ExtensionContext): void {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const custom = entry as { type: "custom"; customType?: string; data?: unknown };
      if (custom.customType !== USAGE_ENTRY_TYPE) continue;
      if (isUsageEvent(custom.data)) usage.record(custom.data);
    }
  }

  // --- native activity detection ---------------------------------------------

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    try {
      const input = (event.input ?? {}) as Record<string, unknown>;

      // Agent spawns: subagent-ish tools carrying an agent name parameter.
      if (/subagent|agent/i.test(event.toolName) && event.toolName !== "okf_read") {
        const agentName = typeof input["agent"] === "string" ? input["agent"].trim() : "";
        if (agentName) {
          try {
            const state = await ensureCatalog();
            const match = state.entries.find(
              (entry) => entry.kind === "agent" && (entry.name === agentName || entry.path === agentName),
            );
            recordUsage(
              {
                kind: "agent",
                name: match?.name ?? agentName,
                path: match?.path ?? "",
                source: "agent_spawn",
                ts: Date.now(),
              },
              ctx,
            );
          } catch {
            // catalog unavailable: record without resolution
            recordUsage({ kind: "agent", name: agentName, path: "", source: "agent_spawn", ts: Date.now() }, ctx);
          }
        }
      }

      // Read-shaped tools reading a cataloged skill or agent file. Awaited so
      // pendingReads is settled before the matching tool_result can fire.
      if (event.toolName === "read" || (/read/i.test(event.toolName) && event.toolName !== "okf_read")) {
        const pathValue = readPathFrom(input);
        if (pathValue) {
          try {
            const state = await ensureCatalog();
            const match = state.entries.find(
              (entry) =>
                (entry.kind === "skill" || entry.kind === "agent") &&
                (entry.path === pathValue || entry.path === resolveMaybeRelative(pathValue)),
            );
            if (match) pendingReads.set(event.toolCallId, match);
          } catch {
            // catalog unavailable: skip detection silently
          }
        }
      }
    } catch (error) {
      warn(ctx, error);
    }
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    try {
      const match = pendingReads.get(event.toolCallId);
      if (!match) return;
      pendingReads.delete(event.toolCallId);
      if (event.isError) return;
      const source: UsageSource = match.kind === "skill" ? "skill_read" : "agent_read";
      recordUsage({ kind: match.kind, name: match.name, path: match.path, source, ts: Date.now() }, ctx);
    } catch (error) {
      warn(ctx, error);
    }
  });

  function resolveMaybeRelative(pathValue: string): string {
    try {
      return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
    } catch {
      return pathValue;
    }
  }
}

// --- module-level helpers ---------------------------------------------------

function readPathFrom(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "absolute_path", "file"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function countSources(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) return 1;
  return 0;
}

function countByKind(entries: CatalogEntry[]): Record<CatalogKind, number> {
  const counts: Record<CatalogKind, number> = { skill: 0, doc: 0, agent: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

function boundText(text: string): string {
  if (text.length <= COMMAND_TEXT_CAP) return text;
  return `${text.slice(0, COMMAND_TEXT_CAP)}\n… (truncated; full data available via the okf_* tools)`;
}
