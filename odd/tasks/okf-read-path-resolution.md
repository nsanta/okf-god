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
- Native review (RDD on): preflight inspect + START blocked pre-lineage — the
  provider offers only a pre-lineage `external.select_base_ref` capture slot,
  which cannot be satisfied because a failed START creates no lineage to bind
  it to (clean tree, committed-range candidate). ASSESS over
  aebf7fa..HEAD returned risk `unassessable` (untracked fixture
  `docs/testing/mock.md` requires explicit declaration) → high-risk plan:
  writer self-verification + separate independent verifier. Both satisfied:
  worker ran the suite; `gentle-ai-verify` independently re-ran vitest (88
  passed), `tsc --noEmit` (clean), and the display-form/nested repro. Native
  review did NOT close for this candidate — this is a verified work unit,
  not an approved one. Optional manual native review:
  `gentle-ai review start --cwd . --base-ref aebf7fac9436a4ece8ccdd5477a35630f2f11a65 --committed-only --untracked-scope exclude`.
