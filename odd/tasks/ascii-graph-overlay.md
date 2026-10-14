# Feature: ASCII link-graph overlay for /okf-graph

## Problem

`/okf-graph` renders Mermaid *source text* (`LinkGraph.toMermaid`) into a
notification. That is a flowchart definition, not a visualization. The user
wants the graph rendered directly in the terminal.

## Decision

Pure-local ASCII rendering (user-selected): no network, no external
renderer dependencies, works in every terminal. Pi TUI's Image component
(Kitty/iTerm2) was considered and intentionally NOT used.

## Goal

`/okf-graph` opens a centered, scrollable overlay (same pattern as the
usage popup) showing an ASCII rendering of the OKF link graph:

- Layered left-to-right sketch: `source ──▶ target` per link, indented
  continuation targets (`└─▶`), broken targets marked.
- Nodes ranked by degree (desc, tie-break by path — same rule as
  `toMermaid`), capped (default 12 nodes) for legibility.
- Isolated nodes (no edges within selection) listed in a separate group.
- Header with stats: total/shown nodes, link count, broken count.
- Deterministic output; theme-colored via the component (pure layout
  function returns unstyled lines).
- `/okf-graph --mermaid` keeps the old Mermaid text export.
- No-UI fallback: plain notification with the ASCII lines (bounded).

## Tasks

- [x] T1: `src/graph-ascii.ts` — pure `toAsciiGraph(graph, {maxNodes?})`
      returning `{ lines, stats, shownNodes, totalNodes }`; unit tests in
      `tests/graph-ascii.test.ts`. (7 tests; sinks render as targets under
      their sources — convention documented and pinned)
- [x] T2: `src/graph-popup.ts` — `GraphPopupComponent implements Component`
      mirroring `UsagePopupComponent` (border, title, scroll, esc/q close).
- [x] T3: Rewire `/okf-graph` in `src/index.ts`: overlay by default,
      `--mermaid` argument keeps the text behavior; no-UI fallback
      notification. Extended `tests/wiring.test.ts` (+3 tests).
- [x] T0 (scope decision): `LinkGraph.nodes()` read-only accessor added
      (5-line insertion) — whole-graph views need node enumeration, which
      was private. Approved mid-task after the worker surfaced the gap.

## Constraints

- Zero new dependencies; no network access.
- Follow the UsagePopupComponent house pattern (theme tokens border/accent/
  dim, truncateToWidth/visibleWidth, invalidate/dispose semantics).
- Keep `toMermaid` untouched (still used by tool path and `--mermaid`).

## Evidence

- Implemented by `gentle-ai-worker` (one scope stop resolved: LinkGraph had
  no node enumeration; nodes() accessor approved as the fix).
- Verified by `gentle-ai-verify`: 13 files / 99 tests passed; `tsc --noEmit`
  clean; wiring spot-checks green (overlay opens with GraphPopupComponent,
  --mermaid unchanged, no-UI emits ASCII with ──▶ and ✗ marks);
  `git diff src/graph.ts` confirmed nodes() is the only change and
  `toMermaid` is untouched.
- Work-unit commit: d3424ce `feat(tui): render OKF link graph as ASCII overlay
  in /okf-graph`.
- Native review (RDD on): DECLINED for this candidate by explicit user
  decision (consent relayed losslessly; provider recorded
  `consent: declined_this_candidate`, lineage review-97afd680a81759ac was
  pre-allocated but no review record was created). Candidate was medium
  risk, 8 files / 531 lines, target sha256:7b4ab93e…. Future reviews stay
  enabled; this is not the kill switch. Delivery follows ordinary
  repository policy on the strength of the verification evidence above.
