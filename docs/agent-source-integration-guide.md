# Adding agent sources to the usage viewer

This guide documents how Codex support was added to the original VS Code Copilot
usage viewer, and how to repeat the same process for future agent runtimes.

The important design decision is that the UI does not need one implementation per
agent. Each agent source should be adapted into the same normalized session model:
a session has user events, model-request events, tool events, child sessions, token
totals, metadata, and a flag that says whether exact cost is available.

## Current sources

The app now supports two local data sources:

| Source | Primary storage | Request usage | Child linkage | Exact cost |
| --- | --- | --- | --- | --- |
| Copilot | VS Code `workspaceStorage/*/GitHub.copilot-chat/debug-logs/*` | `request` entries in `main.jsonl` and sibling JSONL files | Sibling `runSubagent-*` and `title-*` files; search subagents are inferred by matching tool calls | Yes, from `models.json` billing metadata |
| Codex | `CODEX_USAGE_HOME`, `CODEX_HOME`, or `~/.codex` | Rollout `event_msg` records whose payload type is `token_count` | `thread_spawn_edges` in `state_5.sqlite`, with rollout fallback metadata | No, rollout logs expose tokens but not AIC or dollar billing |

The user-facing source filter is intentionally small: `all`, `copilot`, and
`codex`. Everything else is normalized behind the API boundary.

## What changed for Codex

Codex support was implemented by adding a second backend adapter inside
`analyzer.py` and then teaching the API and frontend to pass a `source` filter
through the existing views.

The major code areas are:

- `analyzer.py`: source discovery, Codex rollout parsing, child folding, source
  dispatch, public IDs, summaries, details, and daily usage aggregation.
- `app.py`: `source` query parameters, `/api/daily_usage`, and source-aware detail
  lookup.
- `static/app.js`: source toggle, URL state, calendar metric switching, source
  pills in mixed views, and cost hiding when unavailable.
- `templates/index.html`: data-source buttons.
- `tests/test_analyzer.py`: fixtures for Codex token counts, tool attribution,
  child folding, source filtering, daily usage, and state DB selection.
- `.gitignore`: daily Codex token cache.

## Codex data discovery

Codex local state can exist in more than one layout, so discovery is deliberately
defensive.

1. Resolve the Codex home directory:
   - `CODEX_USAGE_HOME` first, because it is specific to this viewer.
   - `CODEX_HOME` second, because it matches Codex itself.
   - `~/.codex` as the default.
2. Find the thread-index database:
   - Prefer the freshest valid `sqlite/state_5.sqlite`.
   - Fall back to root-level `state_5.sqlite`.
   - Open SQLite read-only with `file:<path>?mode=ro`.
   - Choose by `max(updated_at_ms)` in the `threads` table rather than by the
     first file that exists, because stale root DBs can coexist with newer
     `sqlite/` DBs.
3. Read rollout JSONL paths from the `threads.rollout_path` column.
4. If the DB is missing or unusable, scan rollout files directly:
   - `sessions/**/*.jsonl`
   - `archived_sessions/*.jsonl`
5. Extract lightweight metadata from rollouts when DB metadata is unavailable:
   - `session_meta` for thread ID, source, cwd, provider, agent labels, and parent
     source hints.
   - `turn_context` for model and reasoning effort.
   - first `event_msg` user message for title/preview fallback.

This gives Codex the same durable index behavior Copilot gets from the VS Code
debug-log directory tree.

## Codex usage extraction

The exact per-request token data comes from rollout records like:

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage": {
        "input_tokens": 100,
        "cached_input_tokens": 20,
        "output_tokens": 10,
        "reasoning_output_tokens": 3
      }
    }
  }
}
```

The parser maps this record to a normalized request event:

```python
{
    "kind": "req",
    "input": input_tokens,
    "cached": cached_input_tokens,
    "output": output_tokens,
    "reasoning_output": reasoning_output_tokens,
    "debugName": "codex",
    "model": current_model,
    "reasoning": current_effort,
}
```

Do not use aggregate DB fields such as `tokens_used` for the per-turn chart. The
viewer needs request-level usage so it can render the timeline, cache rate, and
tool context accurately.

Codex does not currently expose exact Copilot-style AIC or dollar cost in the
rollout logs. The adapter sets `cost_available=False`, `total_aic=0`, and public
payloads return `total_aic: null`. The UI treats Codex usage as token usage, not
as cost.

## Tool attribution

The detail view expects each model request to include the tools and user messages
that happened before that request. Copilot logs already fit that model closely.
Codex rollouts need one important ordering fix.

Codex may log `response_item` tool calls and outputs before the `token_count`
record for the same model response. If those tool outputs were appended
immediately, `build_series()` would attach them to the request that just happened.
That is backwards for the viewer: those outputs become context for the next model
request.

The Codex parser handles this with two pieces of state:

- `inside_response`: set when response items indicate the assistant is producing
  reasoning, a message, or a tool call.
- `pending_after_req`: tool outputs observed while `inside_response` is true.

When a `token_count` event arrives, the parser appends the request first, then
flushes `pending_after_req` into the event stream. During `build_series()`, those
flushed tool events are therefore pending for the next request.

This is the main subtle parser rule to preserve for any future source whose log
format interleaves assistant responses, tool calls, and usage records.

## Child sessions and internal sessions

Codex spawned agents are linked with `thread_spawn_edges`:

```sql
select parent_thread_id, child_thread_id from thread_spawn_edges
```

The Codex adapter:

1. Builds a `child_map` from parent thread ID to child thread IDs.
2. Marks child sessions with `parent_sid`.
3. Hides child threads from the top-level result list.
4. Recursively folds child sessions into the parent:
   - child `main` payloads are copied into `parent.children`;
   - child totals are added to the parent totals;
   - child labels come from agent nickname/role when available.

Codex also creates internal review/guardian threads that should not show up in
normal usage views. The current internal-session detector excludes:

- model `codex-auto-review`;
- source metadata with `subagent.other == "guardian"`;
- review prompts that start with the Codex agent-history assessment text.

For future agents, explicitly document which sessions are user-facing and which
are runtime/internal. Hide internal sessions by default unless the product goal
changes.

## Normalized session contract

Every source adapter should return `Session` objects with the same high-level
shape. The fields most relevant to source integration are:

```python
Session(
    sid="raw-source-session-id",
    workspace="project or cwd label",
    mtime=<file mtime seconds>,
    last_event_ts=<epoch milliseconds>,
    main={"events": [...], "t0": <epoch milliseconds>, "first_user": "..."},
    source="codex",
    source_label="Codex",
    path="/path/to/source/log",
    cost_available=False,
    agent_label="optional child label",
    is_internal=False,
    children=[],
    total_input=0,
    total_cached=0,
    total_output=0,
    n_requests=0,
    n_compactions=0,
    duration_ms=0,
    top_model="?",
    first_user="...",
    total_aic=0.0,
    models_info={},
)
```

The event stream in `main["events"]` should use only these normalized event kinds:

### Request events

```python
{
    "kind": "req",
    "ts": <epoch milliseconds>,
    "input": 0,
    "cached": 0,
    "output": 0,
    "reasoning_output": 0,
    "debugName": "codex",
    "model": "gpt-5.1",
    "reasoning": "medium",
    "ttft": 0,
    "nano_aiu": None,
    "is_error": False,
    "error": "",
}
```

Use a value from `COMPACT_NAMES` for `debugName` when the event is a context
compaction. The current compaction names include:

- `summarizeConversationHistory`
- `summarizeConversationHistory-simple`
- `summarizeVirtualTools`
- `context_compacted`
- `compacted`

### Tool events

```python
{
    "kind": "tool",
    "ts": <epoch milliseconds>,
    "name": "exec_command",
    "args": "...",
    "result": "...",
    "dur": 0,
    "status": "ok",
}
```

Tool args/results should be clipped before they reach the API payload. The
frontend renders these strings directly in expandable detail rows.

### User events

```python
{
    "kind": "user",
    "ts": <epoch milliseconds>,
    "text": "user message preview",
}
```

User events become `user_message` entries in each request's `tools_before` list.
That is how the charts mark human turns with a star.

## Public API contract

The backend exposes source-aware endpoints while keeping the payload shape stable:

- `GET /api/sessions?source=all|copilot|codex&...`
- `GET /api/session/<source:sid>`
- `GET /api/daily_usage?source=all|copilot|codex`
- `GET /api/stats?source=all|copilot|codex&since_hours=24`

Session IDs are namespaced at the API boundary with `public_sid()`:

```text
copilot:<raw-copilot-session-id>
codex:<raw-codex-thread-id>
```

`get_session()` accepts the namespaced ID and uses the prefix as a source hint.
This prevents collisions across agents and lets the UI open details without
remembering which adapter produced the row.

The legacy `/api/daily_aic` endpoint remains as a Copilot-only compatibility
endpoint. New UI code should use `/api/daily_usage`.

## Daily usage metric

The calendar cannot honestly mix Copilot AIC with Codex tokens as a single cost
metric. The current rule is:

- `source=copilot`: metric is AIC, with optional UI conversion to dollars.
- `source=codex`: metric is input tokens.
- `source=all`: metric is input tokens across available sources.

Codex daily usage is scanned directly from rollout `token_count` events and
cached on disk in `.daily_codex_cache.json`. Cache entries are keyed by rollout
path with an mtime/size signature, so historical scans stay fast without
pretending the source logs are immutable.

For a future source, decide early whether the daily calendar should show exact
cost, input tokens, or a source-specific metric. Then return:

```python
{
    "days": {"YYYY-MM-DD": 123.0},
    "metric": "input_tokens",
    "unit": "input tokens",
    "cost": False,
}
```

## Frontend integration rules

The UI changes for Codex were intentionally small.

1. Add the source to the header toggle.
2. Store `SOURCE` in URL state so shared links preserve the selected source.
3. Include `source` in `/api/sessions` and `/api/daily_usage` requests.
4. Show source pills only in `source=all` views.
5. Hide the AIC/USD unit toggle when the selected source has no exact cost.
6. Render unavailable cost as empty/null rather than zero dollars.
7. Keep table, chart, modal, and child-session rendering shared across sources.

Avoid branching the charting logic by source. If the UI needs source-specific
checks, prefer tiny feature flags from the payload, such as `cost_available` and
`source_label`.

## Future agent integration checklist

Use this checklist when adding the next local agent runtime.

1. Identify local storage roots.
   - Add a viewer-specific env var first, for example `FOO_USAGE_HOME`.
   - Fall back to the agent's own env var if one exists.
   - Fall back to the platform default location.

2. Find the durable session index.
   - Prefer a DB or manifest that maps session IDs to trace files.
   - If multiple indexes can exist, choose the freshest valid one.
   - Open databases read-only.
   - Provide a file-scan fallback if practical.

3. Locate request-level usage.
   - Find the record that represents one model request's input, cached input,
     output, and reasoning output if available.
   - Confirm whether numbers are per request or cumulative.
   - Do not build charts from aggregate totals unless no request-level data exists.

4. Map raw events into the normalized event stream.
   - `user` for human messages.
   - `tool` for tool outputs/results that should become context for a later model
     request.
   - `req` for model requests with token counts.
   - compactions as zero-token `req` events with a `COMPACT_NAMES` debug name.

5. Fix event-ordering mismatches.
   - Check whether usage records come before or after tool outputs.
   - Ensure `build_series()` will attach tools to the request that consumed those
     tool outputs, not the request that produced them.

6. Decide cost semantics.
   - If exact cost exists and can be expressed in the current Copilot-style AIC
     units, set `cost_available=True` and populate `total_aic`.
   - If a future source exposes exact cost in different units, extend the public
     payload deliberately instead of overloading `total_aic`.
   - If exact cost does not exist, set `cost_available=False` and return null cost
     values in public payloads.
   - Do not infer dollars from model names unless billing data is present in logs
     or a maintained pricing table.

7. Identify child and internal sessions.
   - Use explicit parent/child edges when available.
   - Fall back to source metadata only if edges are absent.
   - Fold child totals into parent totals when the user's mental model is "one
     parent task spawned helpers".
   - Hide runtime/internal review sessions by default.

8. Add source dispatch.
   - Add the source ID to `SOURCES`.
   - Implement `query_<source>_sessions()`.
   - Extend `query_sessions()` and `get_session()`.
   - Namespace public IDs with `public_sid()`.

9. Add daily aggregation.
   - Return `/api/daily_usage` payloads with explicit `metric`, `unit`, and `cost`.
   - Add a per-source disk cache if full-history scanning is expensive.
   - Add cache files to `.gitignore`.

10. Add minimal UI.
    - Add one source-filter button.
    - Preserve source in URL state.
    - Keep visual rendering source-agnostic.

11. Test with fixtures.
    - Parser maps request totals correctly.
    - Tool attribution lands on the expected request.
    - Child folding and internal-session exclusion work.
    - Source filtering returns only the requested source.
    - Detail lookup works with namespaced IDs.
    - Daily usage uses the right metric.
    - The app still works with mixed `source=all` results.

## Testing pattern used for Codex

Codex tests create a temporary fake Codex home, write rollout JSONL fixtures, and
build a minimal `state_5.sqlite` with the `threads` and `thread_spawn_edges`
tables. The tests then point `analyzer.CODEX_BASE` and
`analyzer.DAILY_CODEX_CACHE_PATH` at the temp directory and clear the in-memory
Codex session cache.

The Codex fixture coverage currently verifies:

- request totals from `token_count.info.last_token_usage`;
- tool outputs emitted during one response attach to the next request;
- `reasoning_output_tokens` are preserved;
- Codex detail payloads expose `total_aic: null`;
- spawned children fold into the parent and guardian threads are excluded;
- daily Codex usage returns input tokens, not cost;
- Flask source filtering and namespaced detail lookup work;
- the freshest `sqlite/state_5.sqlite` is preferred over a stale root DB.

For future sources, copy this fixture style. It is faster and more stable than
depending on live local agent history in tests.

## Verification commands

After adding or changing a source adapter, run:

```sh
node --check static/app.js
uv run python -m py_compile analyzer.py app.py tests/test_analyzer.py
uv run pytest
```

Then smoke test the running app:

```sh
uv run app.py --port 5057
```

Open:

- `http://127.0.0.1:5057/?source=all&hours=720`
- `http://127.0.0.1:5057/?source=codex&hours=720`
- `http://127.0.0.1:5057/?source=copilot&hours=720`

Check that:

- mixed results show source pills;
- source filters change the result set;
- the calendar unit changes from AIC in Copilot mode to input tokens in Codex or
  mixed mode;
- Codex rows do not show fake cost;
- clicking a card opens the same detail modal for both sources;
- child/subagent lines appear under parent sessions.

## Common mistakes to avoid

- Treating cumulative totals as per-request totals.
- Showing unavailable cost as zero cost.
- Letting source-specific logic leak into chart rendering.
- Forgetting to namespace public session IDs.
- Attaching tool outputs to the response that produced them instead of the next
  request that consumes them.
- Showing internal review/guardian sessions as user work.
- Building the daily calendar from a metric that mixes cost and tokens.
- Relying on one hard-coded local state layout when the agent has migrated its
  DB or trace location across versions.
