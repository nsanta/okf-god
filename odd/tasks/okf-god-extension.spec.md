# okf-god implementation spec (for worker delegation)

Context: this spec is the complete delegation brief, rooted at
/home/nicolas/projects/okf_god. It implements a pi extension over the Open
Knowledge Format v0.2
(GoogleCloudPlatform/knowledge-catalog, `okf/SPEC.md`). Reference copy of the
full spec: /tmp/okf-spec.md (re-fetchable from
https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md
if missing). A worker must read the OKF spec sections cited below before
writing code.

## Allowed edit surfaces
- src/**
- tests/**

package.json and package-lock.json are already correct (devDependency
`@earendil-works/pi-coding-agent` 1.2.0, deps `typebox` ^1, `yaml` ^2). Do not
modify them, tsconfig.json, vitest.config.ts, .gitignore, odd/, or .atl/.
Never run `git commit`. Five test files already exist under tests/ and MUST
keep passing unchanged; extend behavior so they pass, do not rewrite them.

## Goal
A pi extension (default-export factory receiving `ExtensionAPI`) that indexes
skills, docs, and agents in Open Knowledge Format v0.2 (markdown + YAML
frontmatter), exposes model tools for requirement-based lazy loading AND
graph-based navigation over concept links, tracks which resources the agent
uses, and displays that usage. Permissive conformance per OKF §11: never
reject documents; tolerate unknown fields, unknown types, missing
frontmatter, and broken links.

## OKF v0.2 alignment (spec §4–§6, §8, §11)
Surface from frontmatter at scan time (frontmatter-only indexing; never
retain bodies in the catalog):
- `type` → entry `okfType?` (consumer-defined concept type; tolerate missing).
- `resource` → entry `resource?` (canonical URI of the underlying asset).
- `status` → entry `status?` (`draft|stable|deprecated`; absent ⇒ `stable`).
- `stale_after` → entry `staleAfter?` (ISO 8601 string; a concept is stale
  when `now >= stale_after`; plain comparison, no TTL).
- `generated` → entry `generatedAt?` (from `generated.at` when present).
- `verified` → entry `trustTier` derived per §5.3: absent ⇒ `unverified`;
  verified only by non-`human:` actors ⇒ `machine-confirmed`; any
  `human:<id>` verifier ⇒ `human-reviewed`. MUST normalize a bare
  `{ by, at }` mapping to a one-element list before tiering (§5.2).
  Ignore malformed values defensively (never throw).
- Sources (`sources`) are NOT retained at scan time (size); okf_read may
  summarize their count from the parsed frontmatter when reading the file.

Reserved filenames (§3.1): `index.md` and `log.md` are navigational, not
concepts — the scanner skips them in every directory.

## pi API contract (pi 1.2.0 — verify exact signatures against installed types)
Types are installed at
node_modules/@earendil-works/pi-coding-agent (its dist/**/*.d.ts are the
authoritative contract; already in devDependencies). Reference docs
(read-only): that package's docs/extensions.md, docs/tui.md, and
examples/extensions/dynamic-tools.ts, commands.ts, widget-placement.ts.

Confirmed patterns:
- `pi.registerTool({ name, label?, description, promptSnippet?, promptGuidelines?, parameters: Type.Object({...}), execute: async (toolCallId, params, onUpdate?, ctx?, signal?) => ({ content: [{ type: "text", text }], details }) })`
- `pi.registerCommand(name, { description, getArgumentCompletions?, handler: async (args: string, ctx) => {...} })` — flat hyphenated names (/okf-list style)
- `pi.on("session_start" | "tool_call" | "tool_result" | ..., handler)`
- `ctx.ui.setWidget(id, string[], { placement: "belowEditor" })`, `ctx.ui.notify(msg, "info" | "warning" | "error")`, `ctx.hasUI`
- `pi.appendEntry(...)` for durable non-context data — check exact signature in .d.ts
- `ctx.sessionManager.getBranch()` on session_start to reconstruct state
- Factory must not do heavy work: no scans, watchers, or timers in the factory
  body. Lazy-init on first use or session_start.
- For commands that want to hand long text to the model/editor (e.g.
  /okf-graph), verify the exact supported return/notify mechanism from
  docs + .d.ts and use it; degrade to notify with bounded text if long
  return is unsupported.

## Architecture (files under src/)
1. `src/frontmatter.ts` — parse a leading `---\n<yaml>\n---` block. Returns
   `{ ok: true, data: Record<string, unknown>, body: string }` or
   `{ ok: false, error }`. Handle BOM, CRLF, missing/unclosed delimiter,
   non-map YAML root. Never throw.
2. `src/trust.ts` — pure OKF trust/lifecycle derivation:
   `deriveTrustTier(verified: unknown): "unverified"|"machine-confirmed"|"human-reviewed"`
   (normalizes bare mapping, tolerates garbage), `isStale(staleAfter:
   unknown, now?: Date): boolean`, `normalizeStatus(value: unknown): string`
   (absent/unknown ⇒ `stable`; keep any producer string, default only when
   missing).
3. `src/catalog.ts` — `CatalogEntry { kind: "skill"|"doc"|"agent", name,
   title?, description, tags: string[], status, path, section?,
   okfType?, resource?, staleAfter?, generatedAt?, trustTier }`.
   `scanCatalog(roots: Record<kind, string[]>, opts)` walks each root
   recursively (skip `node_modules`, `99-archive` path segments, hidden dirs
   other than the root itself, and reserved filenames `index.md`/`log.md`),
   parses frontmatter only (never retain bodies). Name resolution: skill →
   frontmatter `name` else directory name; agent → frontmatter `name` else
   filename; doc → filename slug. `CatalogCache` class keyed by path with
   `{mtimeMs, size}` invalidation; `scanCatalog` accepts a cache to make
   rescans cheap. Duplicate names: first wins.
4. `src/roots.ts` — default roots per kind, resolved against a cwd: skills
   `[<cwd>/.pi/skills, <cwd>/.agents/skills, ~/.pi/agent/skills,
   ~/.agents/skills]`, docs `[<cwd>/docs]`, agents
   `[<cwd>/.pi/agents, ~/.pi/agent/agents, ~/.agents]`.
   Optional config file override: first `<cwd>/.pi/okf.json`, else
   `~/.pi/agent/okf.json` — shape `{ "skills": [...], "docs": [...],
   "agents": [...], "exclude": [...] }` (paths may be relative to cwd; support
   `~`). Missing roots are skipped silently.
5. `src/search.ts` — pure ranking: `searchEntries(entries, query, opts?)`
   tokenizes query (lowercase, split non-alphanumeric), scores per-token
   matches: tags ×3, name ×2.5, title ×2, description ×1, section ×1; a token
   matching multiple fields sums. Return matches sorted desc, cap 8. Zero-token
   queries return nothing.
6. `src/reader.ts` — `readResource(entry, maxChars = 20000)` →
   `{ text, truncated, totalChars }`; truncated text ends with an explicit
   marker line telling the model the file path to read the rest from.
7. `src/graph.ts` — OKF §6 link graph (the "navigation in graph format"):
   - `extractLinks(body: string): string[]` — markdown link targets
     `[text](target)`; keep only `.md` targets (skip `http(s):`, `mailto:`,
     pure `#anchors`); dedupe, preserve first-seen order.
   - `buildLinkGraph(entries, opts?)` → reads bodies ON DEMAND (lazy: never
     in the factory body; first graph/read-tool use builds it), extracts
     links, and resolves each target: bundle-relative `/x.md` tried against
     each root of the entry's kind (use the entry's root when known; add an
     optional `root?` field to CatalogEntry for this); relative targets
     resolved against the source file's directory (normalize `./`, `../`).
     Edge endpoints map to catalog entries by path when the target exists
     (resolved), otherwise kept as broken links (OKF §6.1: tolerate, never
     reject). Cache invalidation mirrors CatalogCache `{mtimeMs, size}`.
   - Query API: `outgoing(path)`, `backlinks(path)`, `neighbors(path)`
     (both directions, deduped), `graphStats()` ({nodes, edges, broken}),
     and `toMermaid(maxNodes = 40)` — bounded `flowchart LR` Mermaid source
     ranked by degree (highest first), stable order, edges labeled nothing
     (untyped per §6).
8. `src/usage.ts` — pure `UsageRegistry`:
   `record({kind, name, path, source: "okf_read"|"skill_read"|"agent_spawn", ts})`,
   `events()`, `counts()` → `{skill, doc, agent}`; `serialize()`/
   `deserialize()` round-trip for persistence. Newest first in `events()`.
9. `src/index.ts` — thin wiring:
   - Lazy catalog + lazy graph: build on first tool use or command; `ctx.cwd`
     from session_start, else `process.cwd()`.
   - Tools `okf_search`, `okf_read`, `okf_links`, `okf_list` (exposure
     default "direct").
     - `okf_search` params: `{ query: string, kind?: "skill"|"doc"|"agent" }`.
       Results show name/kind/score + one-line `status · trust` signal.
     - `okf_read` params: `{ path: string, maxChars?: number }` — resolves to
       catalog entry (exact path or unique name across kinds); records usage
       (source okf_read); returns formatted content + frontmatter summary
       (okfType, resource, status, trustTier, stale flag when
       `now >= staleAfter`, sources count) + a compact `Links:` section from
       the lazy graph: resolved outgoing names (cap 5) and backlink names
       (cap 5) + counts, so the model can navigate the graph.
     - `okf_links` params: `{ path?: string, name?: string, direction?:
       "out"|"back"|"both" (default "both"), max?: number (default 10) }` —
       resolves entry like okf_read; returns compact related-entry list
       (kind/name/status + broken links marked). Unknown/ambiguous targets
       return a helpful error text, never throw.
     - `okf_list` params: `{ kind?: ... }` — compact table
       name/kind/description(truncated 80 chars)/status. Tool `details` carry
       `{ kind, name, path }` etc.
   - Usage display: on session_start (and after every usage change) if
     `ctx.hasUI`, `ctx.ui.setWidget("okf-god", [counts line like
     "OKF ▸ 2 skills · 1 doc · 1 agent (this session)"], { placement:
     "belowEditor" })`; hide/empty when zero.
   - Commands: `okf-list [kind]`, `okf-links <name>` (same as tool, for the
     human), `okf-graph` (bounded Mermaid via toMermaid(); use the verified
     command return/notify mechanism; cap output), `okf-usage`, `okf-reload`
     (invalidate catalog + graph caches, rescan, notify). Use
     `getArgumentCompletions` for kinds on okf-list.
   - Persistence: every usage event → `pi.appendEntry({ customType:
     "okf-god:usage", data: <event> })` (adapt to exact appendEntry
     signature). On session_start reconstruct the registry by iterating
     `ctx.sessionManager.getBranch()` entries filtered on that customType,
     before setting the widget.
   - Native activity detection: in `tool_call` handler, if toolName is a
     read-shaped tool with a `path`-like input, remember `toolCallId → path`
     for paths matching a catalog skill `SKILL.md` or agent file; in
     `tool_result` for such ids record usage (source skill_read/agent_read)
     and update widget. Also `tool_call` with toolName matching
     /subagent|agent/i and input containing an agent name (e.g. `agent`
     param) → record agent_spawn usage. Be defensive: unknown event shapes
     must never throw; wrap detection in try/catch.
   - All handler errors must be caught and surfaced via
     `ctx.ui.notify(..., "warning")` at most, never crash the session.
   - Keep everything lazy: no filesystem access in the factory body.

## Tests (vitest, tests/*.test.ts; fixture trees via fs.mkdtempSync; no network)
Existing five files must pass unchanged. Add:
- trust: tier derivation (absent, machine-only, human-reviewed, bare-mapping
  normalization, malformed tolerated), isStale boundary, normalizeStatus.
- catalog: reserved `index.md`/`log.md` skipped; OKF fields extracted
  (type/resource/stale_after/generated/trust tiers).
- graph: extraction filters non-md/absolute URLs; `/abs.md` root resolution;
  relative resolution; broken links tolerated; backlinks; toMermaid node cap
  and degree ranking.
- wiring tests are NOT required (UI-dependent); keep pure modules covered.

## Definition of done
- `npm test` all green (existing 5 files + new tests); `npm run typecheck`
  clean.
- Report: files created, test + typecheck summary (pass/fail counts), any
  deviations and why, any pi API signatures adapted, anything left as
  follow-up. Do not commit.

## Evidence log
- Default roots corrected to pi-native discovery (verified against installed pi 1.2.0 resource-loader + pi-subagents discoverAgents): skills <cwd>/.pi/skills + ~/.pi/agent/skills (+ Agent Skills .agents/skills fallbacks), agents <cwd>/.pi/agents + ~/.pi/agent/agents + ~/.agents; pinned by tests/roots.test.ts.
