"""Loads Copilot, Codex, and Claude local session logs and aggregates per-session token usage.

This package is the single import surface (`import analyzer`) the Flask app and tests use.
It is split into focused modules:

  paths      - platform-specific discovery of each backend's on-disk location
  constants  - immutable name sets / lookup tables
  text       - source-agnostic text/JSON normalization helpers
  models     - the Session dataclass
  window     - time-window normalization + shared sort key
  pricing    - per-request cost (AIC) computation for every backend
  copilot    - GitHub Copilot chat session support
  codex      - Codex local session support
  claude     - Claude Code / Claude Desktop session support
  series     - turn-by-turn series construction for the chart + detail pane
  query      - cross-source query orchestration + UI-facing serializers

The on-disk base paths below are module-level so they can be rebound at runtime
(the tests do `analyzer.CODEX_BASE = ...`); every submodule reads them back through
the `analyzer` namespace at call time, so a rebind here is seen everywhere.
"""
from __future__ import annotations
import os

from .paths import (
    _default_workspace_storage,
    _default_codex_home,
    _default_claude_home,
    _default_claude_desktop_sessions,
)

# ---------- Mutable, test-patchable configuration ----------

BASE = _default_workspace_storage()
CODEX_BASE = _default_codex_home()
CLAUDE_BASE = _default_claude_home()
CLAUDE_DESKTOP_SESSIONS = _default_claude_desktop_sessions()

# Per-source daily aggregate caches are persisted next to the repo (not inside the
# package dir) so the full-history calendar view doesn't reparse every jsonl per request.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAILY_CACHE_PATH = os.path.join(_REPO_ROOT, ".daily_aic_cache.json")
DAILY_CODEX_CACHE_PATH = os.path.join(_REPO_ROOT, ".daily_codex_cache.json")
DAILY_CLAUDE_CACHE_PATH = os.path.join(_REPO_ROOT, ".daily_claude_cache.json")

# ---------- Public API re-exports ----------

from .constants import COMPACT_NAMES, SOURCES, BACKGROUND_NAMES, FIND_PREFIX
from .models import Session
from .window import resolve_window, _query_sort_key
from .pricing import (
    _parse_billing,
    _build_global_prices,
    _load_models_json,
    _aic_for_req,
    _claude_price,
    _claude_req_aic,
    _req_cost_aic,
    _MODELS_CACHE,
)
from .text import (
    _short,
    _clip,
    _result_text,
    _parse_iso_ms,
    _short_json,
    _reasoning_summary,
)
from .copilot import (
    _FILE_CACHE,
    _load_jsonl,
    _reasoning_level,
    _session_dir_signature,
    _daily_aic_for_dir,
    daily_aic,
    daily_copilot_tokens,
    discover_main_files,
    assemble_session,
    _extract_search_queries,
    link_search_parents,
    absorb_search_children,
    query_copilot_sessions,
)
from .series import _top_model, build_series
from .codex import (
    _CODEX_SESSION_CACHE,
    _candidate_codex_state_dbs,
    _codex_state_db,
    _codex_rollout_glob,
    _load_codex_index,
    _assemble_codex_session,
    _absorb_codex_children,
    query_codex_sessions,
    _codex_file_signature,
    _codex_is_internal,
    daily_codex_tokens,
    daily_codex_usd,
)
from .claude import (
    _CLAUDE_SESSION_CACHE,
    _claude_transcript_glob,
    _claude_desktop_meta,
    _claude_request_tokens,
    _parse_claude_stream,
    _assemble_claude_session,
    query_claude_sessions,
    daily_claude_tokens,
    daily_claude_usd,
)
from .query import (
    daily_usage,
    query_sessions,
    split_public_sid,
    get_session,
    public_sid,
    session_summary,
    session_detail,
)
