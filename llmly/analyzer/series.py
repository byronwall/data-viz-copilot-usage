"""Turn-by-turn series construction for the chart + detail pane.

Flattens a Session's main transcript and its (real, search-subagent, and inline)
children into per-request call dicts with cumulative token offsets the UI plots.
"""
from __future__ import annotations

from . import copilot
from .constants import COMPACT_NAMES
from .models import Session


def _top_model(calls: list) -> str:
    """Most common model id across a list of call dicts (the model a sub-agent ran on)."""
    counts: dict[str, int] = {}
    for c in calls:
        m = c.get("model") or "?"
        counts[m] = counts.get(m, 0) + 1
    return max(counts.items(), key=lambda x: x[1])[0] if counts else "?"


def build_series(sess: Session) -> tuple[list, list]:
    """Return (main_calls, child_groups). Each call is a dict with cum tokens, tools_before, etc."""
    p = sess.main
    t0 = p["t0"]
    main_calls = []
    pending = []
    for e in p["events"]:
        if e["kind"] == "tool":
            pending.append({"name": e["name"], "args": e["args"], "result": e.get("result", ""),
                            "dur": e["dur"], "status": e["status"], "t_rel": e["ts"] - t0})
        elif e["kind"] == "user":
            pending.append({"name": "user_message", "args": e["text"], "result": "",
                            "dur": 0, "status": "ok", "t_rel": e["ts"] - t0})
        elif e["kind"] == "req":
            main_calls.append({
                "idx": len(main_calls),
                "ts": e["ts"], "t_rel": e["ts"] - t0,
                "input": e["input"], "cached": e["cached"], "output": e["output"],
                "debugName": e["debugName"], "model": e["model"], "ttft": e["ttft"],
                "nano_aiu": e.get("nano_aiu"), "reasoning": e.get("reasoning", ""),
                "reasoning_output": e.get("reasoning_output", 0),
                "is_compact": e["debugName"] in COMPACT_NAMES,
                "is_error": e.get("is_error", False), "error": e.get("error", ""),
                "tools_before": pending[:],
            })
            pending = []
    cum = 0
    for c in main_calls:
        cum += c["input"]
        c["cum"] = cum

    kids = []
    for c in sess.children:
        creqs = [e for e in c["events"] if e["kind"] == "req"]
        # skip title-only generators with at most 2 reqs
        if c["label"].startswith("title-") and len(creqs) <= 2:
            continue
        if not creqs:
            continue
        start_t = creqs[0]["ts"] - t0
        if start_t < 0:
            continue
        ccalls = []
        pending = []
        for e in c["events"]:
            if e["kind"] == "tool":
                pending.append({"name": e["name"], "args": e["args"], "result": e.get("result", ""),
                                "dur": e["dur"], "status": e["status"], "t_rel": e["ts"] - t0})
            elif e["kind"] == "user":
                pending.append({"name": "user_message", "args": e["text"], "result": "",
                                "dur": 0, "status": "ok", "t_rel": e["ts"] - t0})
            elif e["kind"] == "req":
                ccalls.append({"idx": len(ccalls), "ts": e["ts"], "t_rel": e["ts"] - t0,
                               "input": e["input"], "cached": e["cached"], "output": e["output"],
                               "debugName": e["debugName"], "model": e["model"], "ttft": e["ttft"],
                               "nano_aiu": e.get("nano_aiu"), "reasoning": e.get("reasoning", ""),
                               "reasoning_output": e.get("reasoning_output", 0),
                               "is_compact": e["debugName"] in COMPACT_NAMES,
                               "is_error": e.get("is_error", False), "error": e.get("error", ""),
                               "tools_before": pending[:]})
                pending = []
        # Each sub-agent gets its own line rising from a 0 baseline at its spawn
        # point — cum_offset is the kid's OWN running total, not a continuation of
        # the parent's stack. (Mirrors how search-subagents are anchored below.)
        cc = 0
        for x in ccalls:
            cc += x["input"]
            x["cum_offset"] = cc
        kids.append({"label": c["label"], "start_t": start_t, "start_tok": 0,
                     "calls": ccalls, "top_model": _top_model(ccalls)})

    # Absorb search-children as virtual kids, anchored at the parent's tool_call.ts
    for csid in sess.search_children:
        cpath = sess.search_child_paths.get(csid)
        if not cpath:
            continue
        child_sess = copilot.assemble_session(cpath)
        if not child_sess:
            continue
        c_main, c_kids = build_series(child_sess)  # may recurse but find-sessions have no children
        spawn_ts = sess.search_child_spawn_ts.get(csid, child_sess.main["t0"])
        start_t = (spawn_ts - t0) if spawn_ts and t0 else (child_sess.main["t0"] - t0)
        if start_t < 0:
            start_t = 0
        # Anchor search-subagents at y=0 with their OWN cumulative — they get their own
        # dedicated line rising from the spawn point, not a continuation of the parent's stack.
        spawn_offset_on_parent = start_t
        cc = 0
        flat_calls = []
        for x in c_main:
            x = dict(x)
            cc += x["input"]
            # rebase time onto parent's clock; cum_offset is just the child's own running total
            x["t_rel"] = spawn_offset_on_parent + x["t_rel"]
            x["cum_offset"] = cc
            flat_calls.append(x)
        kids.append({
            "label": f"🔍 search-subagent {csid[:8]}",
            "start_t": start_t,
            "start_tok": 0,
            "calls": flat_calls,
            "is_search_child": True,
            "child_sid": csid,
            "top_model": _top_model(flat_calls),
        })

    return main_calls, kids
