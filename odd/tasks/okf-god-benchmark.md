# Feature: okf-god benchmark (core)

Benchmark of token consumption and retrieval accuracy: **okf-god vs standard pi**
(same model, same fixtures, same tasks). No external harnesses in this scope.

## Decisions

- Location: `bench/` inside this repo. New code only under `bench/**`; docs updates
  (README link) allowed. No changes to `src/**` behavior.
- Arms: (A) `standard` — pi with default tools, no okf-god; (B) `okf-god` — pi with
  the extension loaded. Both arms see the same fixture workspace on disk.
- Model: single background model for all runs (default `zai/glm-5.3-flash`,
  overridable via flag). N repetitions per cell (default 3) for variance; no seed
  support assumed.
- Metrics per run: input / output / cacheRead tokens (from pi session JSONL),
  wall time, task correctness.
- Task suites (deterministic grading, no LLM judge in core):
  1. `fact-qa` — single-concept facts stated in frontmatter/body; exact-match gold answers.
  2. `multi-hop` — answers reachable only by following 2–3 catalog links A→B→C;
     exact-match gold answers.
- Answer extraction: model instructed to end with `ANSWER: <value>`; scorer
  normalizes (case, whitespace, punctuation) and compares to gold.
- Sizes: S (30 concepts) default; M (120) optional via flag; L (500) scaffold only.
- Honesty constraints: report okf-god's fixed tool-description overhead; report
  cache tokens separately; per-cell mean ± stddev; CSV + Markdown summary.
- Benchmark runs call the live model API (user-owned cost); runner prints the
  estimated cell count before executing and requires `--yes` to run.

## Tasks

1. [ ] Explore pi headless contract: print-mode invocation, model/provider flags,
       extension load/disable flags, session JSONL location + usage fields.
       (read-only; evidence in this file)
2. [x] Pure bench modules + tests: rng (mulberry32), fixtures (S/M/L,
       deterministic, chains A→B→C, distractors, broken links), usage parser
       (message_end assistant usage only), scorer (ANSWER extraction +
       normalization). (evidence: bench/lib/*, bench/test/* — 43 tests)
3. [x] Runner + task suites: bench/run.ts (--yes gating, alternating arm
       order, CSV/JSONL/summary.md/plan.json, SIGINT partial summary),
       README benchmark section. (evidence: bench/run.ts, 19 runner tests)
4. [x] Verification: bench 62/62 + root 60/60 (one pre-existing wiring flake
       under full-suite parallelism — flagged as upstream follow-up), both
       typechecks clean, independent gentle-ai-verify PASS (fair arms,
       single spawn site behind --yes, chain-gold isolation, 64 unique fact
       keys), live smoke 8/8 invocations (S, k=2, reps=1):
       accuracy 4/4 both arms; standard 20,775 total tokens vs okf-god
       38,987 (+87.7%) with okf-god input 30% LOWER and cacheRead higher;
       okf-god slower per run (~28–32s vs 6–12s). Native review of the
       accumulated tree: TERMINAL lens_context_budget_exceeded (zero-commit
       repo → candidate is the whole tree; no lineage created, nothing to
       repair). Remedy: initial work-unit commit(s) by the user so future
       candidates review as diffs. Roots-fix candidate earlier: consent
       declined by host (candidate-scoped, respected).

## Evidence log

- Full matrix run 2026-10-13 (`bench/results/full-rep3/`, gitignored): 72/72
  invocations, 0 timeouts, all stop=stop. Accuracy 1.000 ± 0.000 on every
  cell (both arms, both suites) — fixture S does not discriminate accuracy.
  Token means per run: fact-qa okf-god 6,571 vs standard 4,685 total (+40%,
  input +142, cacheRead +1,736); multi-hop 11,491 vs 7,200 (+60%, input +25
  ≈ parity, cacheRead +4,235). Latency: okf-god 14.0s/21.9s vs 8.3s/9.8s
  (fact-qa/multi-hop) — tool round-trips dominate. Honest reading: at S
  size okf-god pays per-round cache/latency overhead; its input-parity on
  multi-hop plus earlier input reductions suggest the discriminating
  experiments are larger fixtures (M/L) and distractor-hardened tasks.

- Work-unit commits: `2184ad7` feat(bench): token and accuracy benchmark of
  okf-god vs standard pi (bench/); `e594898` docs: repository README
  (benchmark section).- 2026-10-13: feasibility designed in session; user chose core scope
  (okf-god vs standard pi, no external harness adapters).
- 2026-10-13 headless contract (gentle-ai-explore, verified against installed
  pi 1.2.0 dist/):
  - Print mode: `pi -p "<prompt>"` (or auto when stdin/stdout non-TTY); cwd via
    spawn option (no --cwd flag); exit 1 on error/aborted/length (stdout may
    still carry partial text); NO built-in timeout — harness kills (SIGTERM).
  - Model pin: `--model provider/id --thinking <level>` on BOTH arms.
  - Extensions: baseline `-ne` (--no-extensions; explicit -e paths still load);
    treatment adds `-e <repo>/src/index.ts` (jiti loads TS directly; factory
    must be default export).
  - Usage: `--mode json` streams events to stdout; assistant messages carry
    `usage {input, output, cacheRead, cacheWrite, totalTokens, cost}`; one
    assistant message PER tool round — sum across all; sum identically in both
    arms.
  - Hygiene recipe (both arms, same temp fixture cwd):
    `pi -ne -ns -nc --no-session --offline --model <id> --thinking <lvl> -p ...`
    (+ `-e` on treatment). `-ns` kills user/project skills, `-nc` kills
    AGENTS.md/CLAUDE.md even from parents, `--no-session` keeps both arms
    cache-cold; leave fixture dir trust-unapproved.
  - Fairness notes: treatment tool declarations ARE part of the measured
    treatment; record stopReason/exit per run; spawn with stdin ignored.
