"""The Session dataclass — the common in-memory shape every backend assembles into."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Session:
    sid: str
    workspace: str
    mtime: float
    # epoch ms of the LAST real conversation event. Unlike mtime, this is immune to the
    # log file being rewritten/touched later (which Copilot does on reopen) — so it's the
    # honest "when did this chat actually happen" timestamp for display.
    last_event_ts: int
    main: dict
    source: str = "copilot"
    source_label: str = "Copilot"
    path: str = ""
    cost_available: bool = True
    agent_label: str = ""
    is_internal: bool = False
    children: list[dict] = field(default_factory=list)
    total_input: int = 0
    total_cached: int = 0
    total_output: int = 0
    n_requests: int = 0
    n_compactions: int = 0
    duration_ms: int = 0
    top_model: str = "?"
    first_user: str = ""
    total_aic: float = 0.0
    models_info: dict = field(default_factory=dict)
    # If this is a "Find relevant code snippets for:" search-subagent session, the parent that spawned it
    parent_sid: Optional[str] = None
    parent_first_user: Optional[str] = None
    # Reverse: list of search-subagent sids spawned by this parent (populated later)
    search_children: list[str] = field(default_factory=list)
    # parent's tool_call.ts (epoch ms) per search-child sid — used to anchor on the parent timeline
    search_child_spawn_ts: dict = field(default_factory=dict)
    # filesystem path lookups so summary can lazily load child series
    search_child_paths: dict = field(default_factory=dict)
    # The search query text (for find-sessions only)
    search_query: Optional[str] = None
