# okf-god

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that indexes skills, docs, and
agents written in the **Open Knowledge Format v0.2** (OKF,
[GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)),
loads them on demand (requirement-based lazy loading), lets the model **navigate the bundle link
graph**, tracks which resources the agent actually used, and displays that usage in the TUI.

- **Frontmatter-only indexing** at scan time; bodies are read strictly on demand.
- **Graph navigation** (OKF §6): markdown links between concepts are directed edges; the model can
  walk outgoing links and backlinks, and you can render the bundle as bounded Mermaid.
- **OKF v0.2 trust & lifecycle surfaced**: `type`, `resource`, `status`, `stale_after`,
  `generated.at`, and derived trust tiers (`unverified` / `machine-confirmed` / `human-reviewed`).
- **Permissive conformance** (OKF §11): unknown fields, unknown types, missing frontmatter, and
  broken links are tolerated — never rejected.

## Install

```bash
npm install
```

Then register the extension with pi (user-level, all sessions):

```bash
pi extension add /path/to/okf_god   # or link into ~/.pi/agent/extensions/
```

The default-export factory (`src/index.ts`) receives `ExtensionAPI`; the factory body does **no**
filesystem work — the catalog and link graph build lazily on first use or on `session_start`.

## What gets indexed

| Kind   | Default roots                                                                        | Names from                          |
| ------ | ------------------------------------------------------------------------------------ | ----------------------------------- |
| skill  | `<cwd>/.pi/skills`, `<cwd>/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/skills` | frontmatter `name`, else directory  |
| doc    | `<cwd>/docs`                                                                         | filename slug                       |
| agent  | `<cwd>/.pi/agents`, `~/.pi/agent/agents`, `~/.agents`                                | frontmatter `name`, else filename   |

Skipped everywhere: `node_modules/`, `99-archive/`, hidden directories, and the reserved OKF
filenames `index.md` / `log.md` (§3.1).

Override roots per project or user with `.pi/okf.json` (cwd) or `~/.pi/agent/okf.json`:

```json
{
  "skills": ["knowledge/skills"],
  "docs": ["docs"],
  "agents": ["~/my-agents"],
  "exclude": ["drafts"]
}
```

Relative paths resolve against cwd; `~` is expanded; missing roots are skipped silently.

## Model tools

| Tool         | Parameters                                        | What it does                                                                                         |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `okf_search` | `query`, `kind?`                                  | Weighted ranking (tags ×3, name ×2.5, title ×2, description/section ×1), top 8, with trust/status.   |
| `okf_read`   | `path`, `maxChars?` (default 20000)               | Resolves entry by exact path or unique name; returns content + OKF summary (type/status/trust/stale/sources) + `Links:` section; records usage. |
| `okf_links`  | `path?`/`name?`, `direction?` (`out`\|`back`\|`both`), `max?` (10) | Graph navigation: resolved related entries; broken links marked.                     |
| `okf_list`   | `kind?`                                           | Compact table: name / kind / description (80 chars) / status.                                        |

`okf_read` truncates long files and appends an explicit marker naming the file path so the model can
read the rest itself.

## Commands

| Command           | Effect                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `/okf-list [kind]`| Catalog table in the UI (kind completion provided).                    |
| `/okf-links <name>`| Graph neighbors for one entry, same resolution as the tool.           |
| `/okf-graph`      | Bounded Mermaid `flowchart LR` of the bundle graph (degree-ranked).    |
| `/okf-usage`      | Per-kind distinct-usage counts for this session.                       |
| `/okf-reload`     | Invalidate catalog + graph caches and rescan.                          |

## Usage display & persistence

A `belowEditor` widget shows live counts, e.g. `OKF ▸ 2 skills · 1 doc · 1 agent (this session)`,
hidden when zero. Every usage event is appended to the session as a custom entry
(`okf-god:usage`) and reconstructed on `session_start` from `ctx.sessionManager.getBranch()`.

Usage sources: `okf_read` (tool), `skill_read` / `agent_read` (native read-shaped tool calls whose
path matches a cataloged `SKILL.md` / agent file), and `agent_spawn` (subagent-style tool calls
naming a cataloged agent). Detection is defensive: unknown event shapes never throw.

## OKF v0.2 alignment

| Spec                              | Where in okf-god                                                     |
| --------------------------------- | -------------------------------------------------------------------- |
| §4.1 frontmatter fields           | `CatalogEntry.okfType/resource/staleAfter/generatedAt/trustTier`     |
| §5.2–5.3 trust tiers              | `src/trust.ts` — `deriveTrustTier` (bare `verified` mapping normalized per §5.2) |
| §5.4–5.5 status & staleness       | `normalizeStatus` (absent ⇒ `stable`), `isStale` (`now >= stale_after`) |
| §6 cross-linking / graph          | `src/graph.ts` — extraction, `/abs` + relative resolution, broken links tolerated |
| §3.1 reserved filenames           | `index.md` / `log.md` skipped at scan                                |
| §11 permissive conformance        | no document is ever rejected; unknown keys/types ignored             |

`sources` (§5.1) are not retained in the catalog (size); `okf_read` summarizes their count.

## Development

```bash
npm test          # vitest — 58 tests, 9 files
npm run typecheck # tsc --noEmit (strict)
```

Pure modules (`frontmatter`, `trust`, `catalog`, `roots`, `search`, `reader`, `graph`, `usage`) are
fully unit-tested with `mkdtemp` fixture trees; `src/index.ts` wiring is covered by mock-based
tests. See [docs/architecture.md](docs/architecture.md) for the design, diagrams, and decisions.

No commits are made by agents; delivery is an ordinary repository decision.

## Benchmark

`bench/` measures token consumption and exact-match retrieval accuracy of okf-god vs standard pi:
same model, same synthetic OKF fixture, byte-identical prompts, alternating arm order.

```bash
node --experimental-strip-types bench/run.ts        # print the plan; no model calls, exits 0
node --experimental-strip-types bench/run.ts --yes  # live run — spends real API tokens
npx vitest run --config bench/vitest.config.ts      # bench unit tests (no pi spawned)
```

With `--yes`, results land in `bench/results/<timestamp>/`: `raw.csv` + `raw.jsonl` per-run records,
`summary.md` (per arm × suite stats, two-arm deltas, honesty notes), `plan.json`, and the fixture
kept under `workspace/`. Module map and verified pi `--mode json` contract:
[bench/README.md](bench/README.md).
