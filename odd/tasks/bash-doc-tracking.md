# Feature: track docs accessed via bash and native reads

## Problem

Usage tracking misses two access paths:
1. Native `read` of a `docs/*.md` file records nothing (only skills/agents
   are detected today).
2. `bash` commands (`cat docs/x.md`, `grep pattern docs/x.md`, `sed`, …)
   are ignored entirely.

## Decision (user-selected scope)

- Bash command tracking: heuristic path extraction from the command string,
  exact catalog match only. Variable-built paths are knowingly untracked.
- Docs on native reads: extend existing read-shaped detection to docs.
- NOT in scope: generic all-tools path sweep (grep/find/ls inputs).

## Goal

- New usage sources `doc_read` (native read of a doc) and `bash_read`
  (cataloged file referenced by a bash command); `UsageSource` extended
  backward-compatibly (old events must still validate).
- `src/bash-paths.ts`: pure `extractCatalogPaths(command, entries, resolve)`:
  - quote-aware tokenization of the command string;
  - first-token denylist of clear non-read verbs (rm, mv, cp, touch,
    mkdir, rmdir, unlink, chmod, chown, ln, truncate, tee, install);
  - path-like tokens (contain `/` or end `.md`), resolved absolute or via
    the provided resolver, matched EXACTLY against entry.path;
  - dedup, catalog order.
- index.ts: read-shaped detection includes docs (source doc_read); bash-
  shaped tool calls extract paths and record per-entry `bash_read` events
  on successful tool_result; pendingReads holds arrays (bash can touch
  several files in one command).
- Widget/popup keep working unchanged (they group by kind).

## Tasks

- [x] T1: usage.ts sources + validation.
- [x] T2: src/bash-paths.ts + unit tests. (10 tests; strict TDD: RED observed before GREEN)
- [x] T3: index.ts wiring (doc_read + bash_read; pendingReads holds route-tagged entry arrays).
- [x] T4: wiring + usage tests. (+3 wiring, +2 usage)

## Constraints

- Zero false-positive tolerance preferred: exact resolved-path match only.
- isUsageEvent must keep accepting all pre-existing sources (session replay).
- Follow existing handler style; tool_call handler stays awaited so
  tool_result ordering holds.

## Evidence

- (pending)
- Implemented by `gentle-ai-worker` with strict TDD (RED: 3 failures
  observed pre-implementation; GREEN after). Verified by `gentle-ai-verify`:
  14 files / 114 tests (run twice, reproducible), `tsc --noEmit` clean,
  behaviors a-e spot-checked, no race in tool_call→tool_result ordering,
  no test deleted or weakened. Note: bash detection is heuristic by design
  (denylisted verbs, variable-built paths untracked); pre-existing `-t`
  single-test isolation quirk in wiring.test.ts documented, not introduced
  by this change.
- Native review (RDD on): DECLINED for this candidate by explicit user
  decision (consent relayed losslessly; provider recorded
  `consent: declined_this_candidate`, no review record created). Provider
  assessed the candidate HIGH risk (7 files / 419 lines; evidence: "code
  that starts other processes in src/index.ts" — the bash-wiring change).
  Future reviews stay enabled; delivery follows ordinary repository policy
  on the verification evidence above.
