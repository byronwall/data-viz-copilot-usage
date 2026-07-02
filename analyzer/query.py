"""Cross-source query orchestration and the UI-facing serializers.

This is the public surface app.py drives: list/lookup sessions across all backends,
the daily-usage rollup, and the summary/detail payload builders.
"""
from __future__ import annotations
import os
from typing import Optional

from . import claude, codex, copilot
from .constants import SOURCES
from .models import Session
from .pricing import _req_cost_aic
from .series import build_series
from .text import _reasoning_summary
from .window import _query_sort_key
from .copilot import daily_aic, daily_copilot_tokens
from .codex import daily_codex_tokens, daily_codex_usd
from .claude import daily_claude_tokens, daily_claude_usd


def daily_usage(source: str = "copilot", unit: str = "aic") -> dict:
    """Daily metric for the selected source.

    Copilot keeps its exact AIC calendar. Codex/Claude can show input tokens or
    estimated USD where model pricing is available.
    """
    source = source if source in SOURCES else "copilot"
    unit = unit if unit in {"aic", "usd"} else "aic"
    if source == "copilot":
        return {"days": daily_aic(), "metric": "aic", "unit": "AIC", "cost": True}
    if unit == "usd":
        if source == "codex":
            days = daily_codex_usd()
        elif source == "claude":
            days = daily_claude_usd()
        else:
            days = daily_codex_usd()
            for d, v in daily_claude_usd().items():
                days[d] = days.get(d, 0.0) + v
            for d, v in daily_aic().items():
                days[d] = days.get(d, 0.0) + (v / 100)
        return {"days": days, "metric": "usd", "unit": "$", "cost": False}
    if source == "codex":
        return {"days": daily_codex_tokens(), "metric": "input_tokens", "unit": "input tokens", "cost": False}
    if source == "claude":
        return {"days": daily_claude_tokens(), "metric": "input_tokens", "unit": "input tokens", "cost": False}
    days = daily_copilot_tokens()
    for src_days in (daily_codex_tokens(), daily_claude_tokens()):
        for d, v in src_days.items():
            days[d] = days.get(d, 0.0) + v
    return {"days": days, "metric": "input_tokens", "unit": "input tokens", "cost": False}


def query_sessions(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
    min_tokens: int = 0,
    limit: int = 50,
    sort: str = "total_input",
    source: str = "all",
) -> list[Session]:
    source = source if source in SOURCES else "all"
    if source == "copilot":
        return copilot.query_copilot_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    if source == "codex":
        return codex.query_codex_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    if source == "claude":
        return claude.query_claude_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    sessions = copilot.query_copilot_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    sessions.extend(codex.query_codex_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort))
    sessions.extend(claude.query_claude_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort))
    sessions.sort(key=_query_sort_key(sort))
    return sessions[:limit]


def split_public_sid(sid: str) -> tuple[Optional[str], str]:
    if ":" in sid:
        src, raw = sid.split(":", 1)
        if src in {"copilot", "codex", "claude"}:
            return src, raw
    return None, sid


def get_session(sid: str, source: str = "all") -> Optional[Session]:
    hinted_source, raw_sid = split_public_sid(sid)
    source = hinted_source or (source if source in {"copilot", "codex", "claude"} else "all")

    if source in {"all", "copilot"}:
        paths = copilot.discover_main_files(3650 * 86400)
        for fp in paths:
            if os.path.basename(os.path.dirname(fp)) == raw_sid:
                s = copilot.assemble_session(fp)
                if s:
                    copilot.link_search_parents([s])
                    copilot.absorb_search_children(s)
                    return s
        if source == "copilot":
            return None

    if source in {"all", "codex"}:
        entries, child_map = codex._load_codex_index()
        ent = entries.get(raw_sid)
        if ent:
            s = codex._assemble_codex_session(ent)
            if s:
                codex._absorb_codex_children(s, entries, child_map)
                return s
        if source == "codex":
            return None

    if source in {"all", "claude"}:
        desktop_meta = claude._claude_desktop_meta()
        for path in claude._claude_transcript_glob():
            stem = os.path.basename(path)[:-6] if path.endswith(".jsonl") else os.path.basename(path)
            if stem == raw_sid:
                s = claude._assemble_claude_session(path, desktop_meta)
                if s:
                    return s
    return None


def public_sid(s: Session) -> str:
    """Stable public id for API/UI routing, namespaced by data source."""
    return s.sid if s.sid.startswith(f"{s.source}:") else f"{s.source}:{s.sid}"


def session_summary(s: Session) -> dict:
    """Lightweight dict for the card list (no per-turn details)."""
    main_calls, kids = build_series(s)

    def with_aic(c):
        return _req_cost_aic(s, c)

    return {
        "sid": public_sid(s),
        "raw_sid": s.sid,
        "source": s.source,
        "source_label": s.source_label,
        "cost_available": s.cost_available,
        "workspace": s.workspace,
        "mtime": s.mtime,
        "last_event_ts": s.last_event_ts,
        "first_user": s.first_user,
        "total_input": s.total_input,
        "total_cached": s.total_cached,
        "total_output": s.total_output,
        "n_requests": s.n_requests,
        "n_compactions": s.n_compactions,
        "duration_ms": s.duration_ms,
        "top_model": s.top_model,
        "total_aic": s.total_aic if s.cost_available else None,
        # dominant reasoning/thinking level(s) across foreground requests (effort, not a token count)
        "reasoning": _reasoning_summary(main_calls),
        "parent_sid": s.parent_sid,
        "parent_first_user": s.parent_first_user,
        "search_children": s.search_children,
        "search_query": s.search_query,
        "main": [{"idx": c["idx"], "t": c["t_rel"], "input": c["input"],
                  "cached": c["cached"], "output": c["output"],
                  "dbg": c["debugName"], "compact": c["is_compact"],
                  "err": c.get("is_error", False),
                  "user": any(t["name"] == "user_message" for t in c["tools_before"]),
                  "aic": with_aic(c), "reasoning": c.get("reasoning", ""),
                  "reasoning_output": c.get("reasoning_output", 0),
                  "cum": c["cum"]} for c in main_calls],
        "kids": [{"label": k["label"], "start_t": k["start_t"], "start_tok": k["start_tok"],
                  "is_search_child": k.get("is_search_child", False),
                  "child_sid": k.get("child_sid"),
                  "top_model": k.get("top_model", "?"),
                  "calls": [{"idx": c["idx"], "t": c["t_rel"], "input": c["input"],
                             "cached": c["cached"], "output": c["output"],
                             "dbg": c["debugName"], "compact": c["is_compact"],
                             "err": c.get("is_error", False),
                             "user": any(t["name"] == "user_message" for t in c["tools_before"]),
                             "aic": with_aic(c), "reasoning": c.get("reasoning", ""),
                             "reasoning_output": c.get("reasoning_output", 0),
                             "cum_offset": c["cum_offset"]} for c in k["calls"]]}
                 for k in kids],
    }


def session_detail(s: Session) -> dict:
    """Full payload including every tool call between requests."""
    main_calls, kids = build_series(s)

    def trim_call(c):
        return {
            "idx": c["idx"], "t": c["t_rel"], "input": c["input"], "cached": c["cached"],
            "output": c["output"], "dbg": c["debugName"], "model": c["model"],
            "ttft": c["ttft"], "compact": c["is_compact"],
            "err": c.get("is_error", False), "err_msg": c.get("error", ""),
            "user": any(t["name"] == "user_message" for t in c["tools_before"]),
            "aic": _req_cost_aic(s, c),
            "reasoning": c.get("reasoning", ""),
            "reasoning_output": c.get("reasoning_output", 0),
            "cum": c.get("cum"), "cum_offset": c.get("cum_offset"),
            "tools": [{"n": t["name"], "a": t["args"], "res": t.get("result", ""),
                       "d": t["dur"], "s": t["status"], "t": t["t_rel"]}
                      for t in c["tools_before"]],
        }

    return {
        "sid": public_sid(s),
        "raw_sid": s.sid,
        "source": s.source,
        "source_label": s.source_label,
        "cost_available": s.cost_available,
        "workspace": s.workspace,
        "mtime": s.mtime,
        "last_event_ts": s.last_event_ts,
        "first_user": s.first_user,
        "total_input": s.total_input,
        "total_cached": s.total_cached,
        "total_output": s.total_output,
        "n_requests": s.n_requests,
        "n_compactions": s.n_compactions,
        "duration_ms": s.duration_ms,
        "top_model": s.top_model,
        "total_aic": s.total_aic if s.cost_available else None,
        "reasoning": _reasoning_summary(main_calls),
        "parent_sid": s.parent_sid,
        "parent_first_user": s.parent_first_user,
        "search_children": s.search_children,
        "search_query": s.search_query,
        "main": [trim_call(c) for c in main_calls],
        "kids": [{"label": k["label"], "start_t": k["start_t"], "start_tok": k["start_tok"],
                  "is_search_child": k.get("is_search_child", False),
                  "child_sid": k.get("child_sid"),
                  "top_model": k.get("top_model", "?"),
                  "calls": [trim_call(c) for c in k["calls"]]} for k in kids],
    }
