# llmly

Interactive web viewer for VS Code Copilot, Codex, and Claude coding-session token usage. It reads local Copilot debug logs, Codex rollout logs, and Claude transcripts, then turns each session into a small-multiple chart of cumulative token use over time, with a drill-in modal showing every LLM call and the tool invocations that fed it.

Copilot data comes from the debug logs that the Copilot extension writes under VS Code's `workspaceStorage` directory (`<workspaceStorage>/<wsid>/GitHub.copilot-chat/debug-logs/`). Codex data comes from `CODEX_HOME` (or `~/.codex`), using `sessions/**/*.jsonl` for per-turn usage and `state_5.sqlite` for thread titles, source metadata, and spawned-subagent parentage. Claude data comes from `CLAUDE_CONFIG_DIR` (or `~/.claude`), using the `projects/<cwd>/<sessionId>.jsonl` transcripts — the same files the Claude Code CLI and the Claude Desktop app both write (Desktop runs Claude Code under the hood). Optional per-session titles/effort are read from the Claude Desktop metadata files when present.

The log location is auto-detected per platform:

| Platform | workspaceStorage                                                        |
| -------- | ----------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Code/User/workspaceStorage`              |
| Linux    | `$XDG_CONFIG_HOME/Code/User/workspaceStorage` (default `~/.config/...`) |
| Windows  | `%APPDATA%\Code\User\workspaceStorage`                                  |

Using VS Code Insiders, VSCodium, or a portable install? Point the `COPILOT_USAGE_STORAGE` env var at the equivalent `workspaceStorage` directory. Using a non-default Codex home? Point `CODEX_USAGE_HOME` or `CODEX_HOME` at that directory. Using a non-default Claude home? Point `CLAUDE_USAGE_HOME` or `CLAUDE_CONFIG_DIR` at it (and `CLAUDE_DESKTOP_SESSIONS` at the Claude Desktop `claude-code-sessions` dir if you want title/effort enrichment from a non-standard install).

## Visuals

These are the same annotated examples from the in-app **guided tour** (the `? Help` button in the toolbar), which renders a live demo session — one main agent that spawned two sub-agents.

### Small multiples, one per session

The default view: a grid of cards, one per session, on a shared y-scale so the heaviest hitter fills the frame. Click any card to drill into its detail.

![](docs/img/small-multiples.png)

### Anatomy of a chart

Each card is one session. The big band plots cumulative input tokens over time; the band below plots per-turn input. Dot size ∝ that turn's input; dot color = cache hit rate.

![](docs/img/chart-anatomy.png)

### Detailed view, session

Click any card or row to open the per-turn detail — every LLM call, its reasoning level, input/cached/output, cache-hit bar, and the tools that fired before that turn.

![](docs/img/detail-view.png)

### Table rollup — a day's worth of usage

The `table` toggle swaps the grid for a sortable rollup, one row per thread: model, reasoning level, request and sub-agent counts, input/cached/uncached/output tokens, cost, and duration. Click any column header to re-sort.

![](docs/img/table-rollup.png)

### Usage calendar

The 📅 calendar is a GitHub-style year heatmap. In Copilot-only mode it shows daily AIC spend, and the unit toggle switches between AIC credits and dollars. In Codex, Claude, or mixed-source mode it shows daily input tokens, because neither Codex rollout logs nor Claude transcripts expose exact AIC or dollar cost.

![](docs/img/calendar.png)

### Colors & marks

![](docs/img/colors-marks.png)

## Run

Requires [uv](https://github.com/astral-sh/uv).

From PyPI:

```sh
uvx llmly
```

The command starts the local Flask server and opens the viewer in your browser. If port 5057 is busy, `llmly` automatically tries the next available port.

From a checkout:

```sh
git clone https://github.com/byronwall/data-viz-copilot-usage.git
cd data-viz-copilot-usage
uv run app.py
```

Then open <http://localhost:5057> if the browser does not open automatically.

CLI flags:

```sh
uvx llmly --port 8000 --host 0.0.0.0 --debug
uvx llmly --no-open
```

uv will create `.venv/` and install Flask on the first run; subsequent runs are instant.

## Publish

The publish script loads `.env`, increments the patch version, runs checks, builds the wheel/sdist, and publishes. Use `PYPI_TOKEN` for production PyPI and `TEST_PYPI_TOKEN` for TestPyPI:

```sh
./publish-llmly.sh test
./publish-llmly.sh prod
```

## Test

Install dev dependencies and run the unit suite with:

```sh
uv run pytest
```

The tests live in `tests/` and use hermetic fixtures for Codex state instead of reading live local agent history.

## What you see

- **Default view**: top 50 sessions from the last 24h, sorted by total input tokens.
- **Filters** in the header: data source (`all` / `Copilot` / `Codex` / `Claude`), time window (1h … 90d), sort key, top-N cap, minimum-token floor.
- **Each card**: a small line chart. y = cumulative input tokens (shared scale across all cards in the result set so the heaviest hitter fills the frame). x = wall-clock time from first activity (per-card scale). Solid blue = the foreground `panel/editAgent` chat. Dashed colored lines = sub-agents (`runSubagent-*`). Orange diamonds = compaction events (`summarizeConversationHistory*`, `summarizeVirtualTools`). Dot size encodes per-turn input tokens. Dot color encodes cache hit on that turn (blue ≥70% / amber 30–70% / red <30%).
- **Click a card** → fullscreen modal with the chart on the left and a per-turn detail table on the right. Hover any dot to highlight (and scroll to) the matching row, and vice versa. Each row shows debugName, reasoning level, input/cached/output, cache-hit bar, and the tools that fired before that turn.
- **`charts` / `table` toggle** (below the controls): switch the result set between the small-multiples grid and a tabular rollup — one row per thread (session), with columns for model, reasoning level, request count, input/cached/cache%/output tokens, available cost, and duration. Click a column header to sort; click a row to open the same detail modal as a card. The active view persists in the URL (`?view=table`).
- **Reasoning level** is the requested effort, *not* a token count. Copilot reads it from each request's `requestOptions`; Codex reads it from the rollout `turn_context.effort`; Claude reads it from the Claude Desktop session metadata when present (transcripts don't log it per request). Codex reasoning-output token counts are included in detail payloads, but not shown as a separate default table column.
- **Codex subagents** are folded into parent Codex threads by default using `thread_spawn_edges`; guardian/internal review threads are hidden from the default Codex view.
- **Claude sub-agents** (Task-tool sidechains in the same transcript) are folded into the parent session as a single `sub-agents` child line. Claude `input` is the full prompt (`input_tokens + cache_read + cache_creation`); `cached` is the cache-read subset, so cache-hit rates and uncached totals follow the same convention as the other sources.

## Endpoints

- `GET /` — UI
- `GET /api/sessions?source=all&since_hours=24&min_tokens=0&limit=50&sort=total_input` — list of session summaries (no per-tool detail)
- `GET /api/session/<source:sid>` — full detail for one session (every LLM call and its preceding tool invocations)
- `GET /api/daily_usage?source=all` — daily selected metric (`AIC` for Copilot-only, input tokens for Codex/Claude/all)
- `GET /api/stats?source=all&since_hours=24` — high-level rollup

`source` values: `all` · `copilot` · `codex` · `claude`. `sort` values: `total_input` · `recent` · `uncached` · `requests` · `duration` · `aic` (`aic` maps to usage for Codex and Claude, since exact cost is unavailable).

## How it works

`llmly/analyzer/` discovers Copilot `main.jsonl` files via the workspaceStorage glob. For each session it parses the foreground log plus any sibling `*.jsonl` files (those are child sessions — `runSubagent-*` and `title-*`). For Codex, it uses `state_5.sqlite` as the thread index and parses rollout JSONL `token_count` events for per-turn usage. For Claude, it globs `projects/*/*.jsonl` and parses each `assistant` record's `message.usage`, deduping the multiple lines that share one `requestId`. Files are cached in-memory keyed by mtime where useful, and daily Codex/Claude token totals are disk-cached by file mtime/size. The frontend renders SVG directly in the browser from the JSON payload so filtering is responsive.

For the implementation write-up and the repeatable process for adding more agent sources, see [docs/agent-source-integration-guide.md](docs/agent-source-integration-guide.md).

## Notes

- VS Code Copilot only logs caching info for some sessions/models. `gemini-3-flash-preview` shows ~17% cache; `gpt-5.x` typically 88–95%.
- Sessions reopened across multiple days will have a `duration` that includes the idle gap.
- "Find relevant code snippets for: …" sessions are standalone subagent search sessions (separate session dirs, no parent linkage in the log files), so they show up as their own cards.
