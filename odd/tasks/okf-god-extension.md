# Feature: okf-god extension

Pi extension that manages skills, documentation, and agents in Open Knowledge
Format (OKF v0.2, GoogleCloudPlatform/knowledge-catalog okf/SPEC.md), loads
them on demand (no eager loading), navigates the bundle link graph, and
displays which resources the agent used.

Location: `/home/nicolas/projects/okf_god` (standalone project; later linked
into `~/.pi/agent/extensions/`).

## Decisions

- Complement pi's native skill system (never replace system-prompt skill ads).
- One tool namespace: `okf_search`, `okf_read`, `okf_list`.
- Frontmatter-only indexing at scan time; bodies read strictly on demand.
- Usage tracked in-session, persisted via `pi.appendEntry()`, reconstructed on
  `session_start` from `ctx.sessionManager.getBranch()`.
- Display: TUI widget with per-kind counts + `/okf-list`, `/okf-usage`,
  `/okf-reload` commands.
- User-level install, project-scoped roots via optional `.pi/okf.json` /
  `~/.pi/agent/okf.json`, else conventional defaults.
- Skip `99-archive/` path segments and reserved OKF filenames (`index.md`,
  `log.md`) at scan time; permissive conformance (OKF §11): never reject
  documents, tolerate unknown fields/types and broken links.
- OKF v0.2 families surfaced from frontmatter: `type` (okfType), `resource`,
  `status` (default stable), `stale_after` staleness, `generated.at`, and
  derived trust tiers per §5.3 (unverified / machine-confirmed /
  human-reviewed, bare-mapping normalization per §5.2).
- Graph navigation (OKF §6): markdown links between concepts are directed
  edges; lazy link graph with outgoing/backlinks/neighbors, bounded Mermaid
  export (`okf-graph`), navigation via `okf_links` tool and `Links:` section
  in `okf_read`.
- Truncate large `okf_read` results (default 20000 chars) and report truncation.
- No git commits by the agent: commits are user-owned (per user's standing
  preference); work is delivered ready-to-commit in reviewable units.

## Tasks

1. [x] Scaffold project: git, package.json, tsconfig, vitest, deps. (evidence: scaffold commit pending user commit)
2. [x] Frontmatter parser + OKF v0.2 catalog scanner (trust/lifecycle
       derivation, reserved filenames) with mtime cache (unit tests).
       (evidence: tests/catalog.test.ts, tests/trust.test.ts, tests/okf-fields.test.ts)
3. [x] Pure modules: search ranking, truncating reader, link graph
       (extraction, resolution, backlinks, Mermaid) (unit tests).
       (evidence: tests/search.test.ts, tests/reader.test.ts, tests/graph.test.ts)
4. [x] Lazy-load tools `okf_search` / `okf_read` / `okf_links` / `okf_list`
       + usage recording. (evidence: src/index.ts; tests/wiring.test.ts)
5. [x] Usage persistence + session reconstruction + widget + commands
       (incl. `/okf-graph`, `/okf-links`). (evidence: src/index.ts; tests/wiring.test.ts)
6. [x] Native activity detection: SKILL.md reads (tool_call/tool_result), subagent runs.
       (evidence: src/index.ts; tests/wiring.test.ts)
7. [x] Verification: vitest green (58/58, 9 files), `tsc --noEmit` clean,
       independent gentle-ai-verify PASS (6/6 checks incl. live node smoke),
       native review APPROVED (lineage review-544c1159b30cf315, lens
       review-reliability; 7 informational advisories, none blocking;
       acknowledgement burned), README.md + docs/architecture.md.

## Evidence log

- Exploration: pi 1.2.0 extension API confirmed (registerTool/registerCommand/
  setWidget/appendEntry/session_start); examples read: dynamic-tools.ts,
  commands.ts, widget-placement.ts; user agents at `~/.pi/agent/agents/*.md`
  use frontmatter (name/description/tools); yolp `docs/` is OKF v0.2 with
  per-dir `index.md` and frontmatter type/title/description/tags/status.
- 2026 OKF v0.2 spec read in full (fetched from
  GoogleCloudPlatform/knowledge-catalog main, 1006 lines): provenance
  (`sources`), trust (`generated`/`verified`, §5.3 tiers), lifecycle
  (`status`, `stale_after`), graph cross-linking (§6), reserved
  `index.md`/`log.md`, permissive conformance (§11). Brief updated to align
  catalog entries + navigation with v0.2; `sources` not retained at scan
  (size), summarized on read.
- Implementation delegated to gentle-ai-worker: 9 src modules + 9 test
  files; 58/58 tests, typecheck strict clean; pi signatures adapted
  (execute arg order, positional appendEntry, required tool label, void
  command handlers, session_start shape).
- Independent verification (gentle-ai-verify): PASS 6/6 — tests, typecheck,
  contract integrity (5 pre-existing test files untouched), surface
  integrity (only src/** + tests/** added; no commits), code spot checks
  (lazy factory, defensive handlers, exclusions, broken-link tolerance),
  live node smoke of scanCatalog → search → extractLinks → backlinks.
- Native review (RDD on): lineage review-544c1159b30cf315, tier medium,
  lens review-reliability, candidate = 24 untracked paths (package-lock
  excluded as machine-generated). APPROVED with 7 informational advisories
  (agent-detection regex breadth, roots config gaps, pendingReads map
  growth, pending-reads race WARNING, resolve fallback, stale cwd,
  wiring test-order coupling). Acknowledgement burned; delivery = ordinary
  repository policy (commits user-owned).
- Reviewer model routing configured once at user request:
  ~/.pi/gentle-ai/models.json, all review keys → zai/glm-5.3-flash.
- Docs: README.md (root) + docs/architecture.md (252 lines, 4 Mermaid
  diagrams), all export names/API notes verified against code and
  installed pi .d.ts. Documentation-only change; no new review lineage
  (passive docs, code candidate already approved).
- Memory/Engram mirror: not available in this session (no mem_* tools
  callable); this file is the durable task record.
