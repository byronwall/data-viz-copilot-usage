# AGENTS.md

Operational guidance for agents working in this repo.

## Project Shape

- This is a deliberately small Flask app, not an installable Python package. Keep `[tool.uv].package = false`.
- Runtime Python code lives in `app.py` and `analyzer.py`.
- Browser code is plain JavaScript in `static/app.js`; CSS is in `static/style.css`; templates are in `templates/`.
- Avoid adding build systems, bundlers, task runners, or framework migrations unless the user explicitly asks for them.

## Standard Commands

- Run the app: `uv run app.py`
- Run on a specific port: `uv run app.py --port 5057`
- Run unit tests: `uv run pytest`
- Check Python syntax when parser/app code changes: `uv run python -m py_compile analyzer.py app.py tests/test_analyzer.py`
- Check frontend syntax when `static/app.js` changes: `node --check static/app.js`

Use `uv` for Python dependency management. Add test-only dependencies with `uv add --dev <package>` so `pyproject.toml` and `uv.lock` stay in sync.

## Testing Conventions

- Put unit tests under `tests/` with filenames matching `test_*.py`.
- `pytest` is the standard test entry point. Existing `unittest.TestCase` tests are fine; pytest discovers and runs them.
- Prefer hermetic fixtures over live local agent history. For Codex tests, create temporary rollout JSONL and SQLite state fixtures, then point analyzer globals at the temp directory.
- When changing source parsing, verify both summary and detail payloads. Tool events should attach to the model request that consumed them.

## Frontend Conventions

- Keep the frontend dependency-free unless a real build step becomes necessary.
- Shared detail rendering lives in `static/app.js`; update the turns, by-tool, and by-file views together when changing tool metadata behavior.
- Tool failure display is heuristic. Treat successful terminal statuses such as `ok`, `success`, and Codex `completed` as non-failures, and only add failure markers that are anchored enough to avoid flagging ordinary file contents or test output.

## Documentation

- Update `README.md` when setup, run, or test commands change.
- Update `docs/agent-source-integration-guide.md` when source-adapter behavior, verification commands, or fixture patterns change.
- Keep this file focused on repeatable repo conventions rather than narrative notes from a single debugging session.
