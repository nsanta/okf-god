# Feature: usage-popup

Show the session's used OKF resources (skills, docs, agents) in a TUI popup
overlay listing each resource's **title** and **relative path**, replacing the
current `/okf-usage` notification summary.

## Context

- okf-god already tracks usage (`src/usage.ts`: `UsageRegistry`, events with
  `kind`, `name`, `path`, `source`, `ts`) and shows counts in a widget.
- `/okf-usage` currently renders counts plus the 8 most recent events via
  `ctx.ui.notify` — transient and low-detail.
- pi overlay pattern (verified against `examples/extensions/overlay-qa-tests.ts`):
  `ctx.ui.custom<void>(factory, { overlay: true, overlayOptions: { anchor, width, maxHeight } })`;
  component implements `render(width): string[]`, `handleInput(data)`,
  `invalidate()`, `dispose()`; close with `done()`; theme via `theme.fg`;
  `truncateToWidth` / `matchesKey` from `@earendil-works/pi-tui`.
- `CatalogEntry.title?: string` resolves display titles; fallback to `name`.
- Relative path: `path.relative(cwd, event.path)`.
- Repo state: clean, on `main` at `b3ac3cf`.

## Tasks

- [ ] T1: Add scrollable usage popup overlay component (title + relative path
      per resource, kind label, dedup by kind:name, newest first, close on
      Esc/q/Enter) — `src/usage-popup.ts` (new).
- [ ] T2: Rewire `/okf-usage` to open the popup; keep `notify` only for the
      empty case; widget counts unchanged — `src/index.ts`.
- [ ] T3: Tests for row building (dedup, title fallback, relative path) and
      empty-state behavior — `tests/usage-popup.test.ts` (new).
- [ ] T4: `npm run typecheck` and `npm test` green; work-unit commit on
      feature branch.

## Evidence

- T1–T3: commit `964c6e2` — feat(tui): show session OKF usage in popup overlay
  with title and relative path (branch `feature/usage-popup`). Checks:
  `npm run typecheck` exit 0; `npm test` 11 files / 68 tests passed
  (independent gentle-ai-verify run).
