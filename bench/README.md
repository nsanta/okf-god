# okf-god benchmark (wave A: pure bench modules)

Pure, deterministic building blocks for the okf-god vs standard-pi benchmark.
No model calls, no pi invocations — wave B (`bench/run.ts`, separate) wires
these into the live runner.

## Modules (`bench/lib/`)

| Module | Exports | Purpose |
| --- | --- | --- |
| `rng.ts` | `createRng`, `Rng` | Seedable mulberry32 PRNG; pure 32-bit math, zero deps. |
| `fixtures.ts` | `generateFixture`, `writeIndex`, `SIZE_CONCEPTS`, `chainCountFor`, `factSentence`, types | Deterministic synthetic OKF v0.2 bundles (docs only) with controlled facts, A→B→C chains, sibling/broken/index links, and near-miss distractors. Same `(size, seed)` ⇒ byte-identical tree. |
| `tasks.ts` | `buildTasks`, `TaskSpec`, prompt constants | Deterministic per-suite task selection; identical base instructions for both benchmark arms. |
| `score.ts` | `extractAnswer`, `normalize`, `scoreRun` | `ANSWER:` extraction (last-match, last-line fallback), normalization, exact-match grading. No LLM judge. |
| `usage.ts` | `parseEventStream`, `PiRunStats`, `emptyStats` | Parse pi `--mode json` stdout JSONL into per-run token totals. |

## Verified pi `--mode json` contract (pi 1.2.0, installed docs)

Cited in `bench/lib/usage.ts` and summarized here:

- `docs/json.md`: strict JSONL (one object per LF-terminated record, optional
  preceding CR stripped); first record is the `session` header; `message_end`
  carries the authoritative final message; `message_update` carries only
  deltas plus a cumulative top-level `usage` and is never summed.
- `docs/message-types.md`: assistant messages carry
  `usage {input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?,
  totalTokens, cost{...}}` (`reasoning` already included in `output`);
  `stopReason` is terminal on `message_end`; text blocks are
  `{type: "text", text}`. One assistant message per tool round ⇒ usage is
  summed across all assistant-role `message_end` messages; final text is the
  concatenation of the last assistant message's text blocks.

## Commands

```bash
# bench tests only (root vitest.config.ts is intentionally untouched)
npx vitest run --config bench/vitest.config.ts

# typecheck including bench files (root tsconfig.json is intentionally untouched)
npx tsc --noEmit -p bench/tsconfig.json
```

`npm test` / `npm run typecheck` at the repo root cover only `src/**` and
`tests/**` exactly as before; bench ships its own vitest config and tsconfig
under `bench/` so the root project files stay unmodified.

## Determinism

Fixtures and tasks derive everything from `(size, seed)`: the PRNG shuffles the
slug pool once, and every structural choice (statuses, tags, metrics, values,
chain membership, link placement) is index arithmetic over that order. No
`Date.now`, no `Math.random`, no filesystem-order dependence. `(metric, entity)`
question keys are globally unique per fixture, so every fact-qa gold has exactly
one correct value, and chain golds live only in C.
