# Feature: okf_read path resolution (display forms and nested folders)

## Problem

`okf_search` renders entries as `kind/name` (e.g. `doc/mock`), which looks like a
path. `okf_read path="doc/mock"` fails because `CatalogEntry.path` is an absolute
filesystem path and `resolveEntry` does exact matching only. Nested folders make
it worse: `docs/guides/foo.md` displays as `doc/foo` (no section info) and cannot
be addressed by any relative form.

## Goal

`okf_read` (and `okf_links`) resolve any path form that search can surface or a
caller can reasonably derive:

1. Absolute filesystem path (existing behavior).
2. Display form `kind/name` (e.g. `doc/mock`).
3. Root-relative path with or without `.md` extension (e.g. `docs/mock.md`,
   `docs/mock`, `guides/deploy.md`), matched as a path suffix; a leading
   `kind/` segment is tolerated and stripped.
4. Existing `name` fallbacks unchanged (unique name, ambiguity error).

Ambiguous suffix matches report all candidates; unknown paths report an error
that lists accepted forms and suggests `okf_search`.

## Tasks

- [x] T1: Add pure resolver module `src/resolve.ts` with the resolution ladder
      above; unit tests in `tests/resolve.test.ts`. (19 unit tests)
- [x] T2: Wire `src/index.ts` `resolveEntry` through the new module; keep name
      resolution semantics; improve error text for path misses.
- [x] T3: Wiring tests: `okf_read` with `{path: "doc/runbook"}` (display form)
      and a nested doc read via section-qualified form. Fixture added:
      `docs/guides/nested.md`.

## Constraints

- No change to `describeEntry` display format (`kind/name`) — existing tests pin it.
- Catalog dedupe guarantees `kind:name` uniqueness; display form is unambiguous by construction.
- Path suffix matching normalizes separators and strips one trailing `.md`.

## Evidence

- Implemented by `gentle-ai-worker`; verified by `gentle-ai-verify`.
- `npx vitest run`: 12 files / 88 tests passed (20 new: resolve 19, wiring +1).
- `npx tsc --noEmit`: clean.
- Repro of the original failure: `okf_read {path: "doc/runbook"}` and
  `{path: "doc/guides/nested"}` resolve to real file contents; the old error
  string `"No catalog entry has path"` no longer appears in src/ or tests/.
- Scope note: `docs/testing/mock.md` is the user's own manual fixture
  (pre-existing untracked); intentionally excluded from this change.
- Work-unit commit: 87f953c `fix(catalog): resolve okf_read paths from search
  display forms and nested folders` (branch feature/okf-read-path-resolution).
- Native review (RDD on): COMPLETED AND APPROVED. Lineage `review-0296bfcef66a2853`,
  medium tier, 6 files / 386 lines, lens `review-reliability` (consent granted by
  the user; managed-assets sync run per the provider stop; facade capture ran
  the reviewer; store revision sha256:a57b725f). Authority burned via
  acknowledge-approved (gentle-ai.review-acknowledged/v1). Delivery remains
  ordinary repository policy.
- Advisory findings (non-blocking, informational; follow-up work, never a
  reason to re-run review on this candidate):
  - R3-display-form-backslash (SUGGESTION, src/resolve.ts:64-70)
  - R3-suffix-false-positives (WARNING, src/resolve.ts:79-89)
  - R3-wiring-count-coupling (SUGGESTION, tests/wiring.test.ts:235-236)
- Untracked-files blocker from the earlier ASSESS round: RESOLVED —
  docs/testing/mock.md committed as c493804 (test fixture), tree fully clean,
  so the review candidate covers every change with nothing outside scope.
