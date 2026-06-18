"""Codex local session support.

Codex layout on disk (under CODEX_HOME / ~/.codex):
  state_5.sqlite or sqlite/state_5.sqlite thread index + parent/child edges
  sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
"""
from __future__ import annotations
import os, json, glob, time, sqlite3, copy
from typing import Optional

import analyzer
from .constants import COMPACT_NAMES
from .models import Session
from .text import _short, _short_json, _result_text, _parse_iso_ms
from .window import resolve_window

# ---------- Cache ----------

_CODEX_SESSION_CACHE: dict[str, tuple[float, Optional[Session]]] = {}


def _candidate_codex_state_dbs() -> list[str]:
    """Possible Codex thread-index DB locations, newest layouts first.

    Recent Codex desktop builds write the live state DB under ~/.codex/sqlite while
    older installs kept it at ~/.codex/state_5.sqlite. Some machines can have both;
    the root DB may be stale but non-empty, so callers must pick the freshest valid
    index instead of using the first file that exists.
    """
    bases = [analyzer.CODEX_BASE]
    if os.path.basename(os.path.normpath(analyzer.CODEX_BASE)) == "sqlite":
        bases.append(os.path.dirname(os.path.normpath(analyzer.CODEX_BASE)))
    out: list[str] = []
    for base in bases:
        for path in (os.path.join(base, "sqlite", "state_5.sqlite"),
                     os.path.join(base, "state_5.sqlite")):
            if path not in out:
                out.append(path)
    return out


def _codex_state_db() -> str:
    best_path = os.path.join(analyzer.CODEX_BASE, "state_5.sqlite")
    best_updated = -1
    for db in _candidate_codex_state_dbs():
        if not os.path.exists(db):
            continue
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                row = con.execute("select max(updated_at_ms) from threads").fetchone()
                updated = int(row[0] or 0) if row else 0
            finally:
                con.close()
        except sqlite3.Error:
            continue
        if updated > best_updated:
            best_path = db
            best_updated = updated
    return best_path


def _codex_rollout_glob() -> list[str]:
    paths = glob.glob(os.path.join(analyzer.CODEX_BASE, "sessions", "**", "*.jsonl"), recursive=True)
    paths.extend(glob.glob(os.path.join(analyzer.CODEX_BASE, "archived_sessions", "*.jsonl")))
    return sorted(set(paths))


def _codex_source_obj(src):
    if isinstance(src, dict):
        return src
    if not isinstance(src, str) or not src.startswith("{"):
        return src
    try:
        return json.loads(src)
    except Exception:
        return src


def _codex_parent_from_source(src) -> Optional[str]:
    obj = _codex_source_obj(src)
    if not isinstance(obj, dict):
        return None
    sub = obj.get("subagent")
    if not isinstance(sub, dict):
        return None
    spawn = sub.get("thread_spawn")
    if isinstance(spawn, dict) and spawn.get("parent_thread_id"):
        return str(spawn["parent_thread_id"])
    return None


def _codex_agent_label(src, nickname="", role="") -> str:
    obj = _codex_source_obj(src)
    if isinstance(obj, dict):
        sub = obj.get("subagent")
        if isinstance(sub, dict):
            spawn = sub.get("thread_spawn")
            if isinstance(spawn, dict):
                nick = spawn.get("agent_nickname") or nickname
                r = spawn.get("agent_role") or role
                return " ".join(x for x in [nick, r] if x) or "subagent"
            if sub.get("other"):
                return str(sub["other"])
    return " ".join(x for x in [nickname, role] if x)


def _codex_is_internal(src, model="", title="", first_user="", thread_source="") -> bool:
    obj = _codex_source_obj(src)
    if model == "codex-auto-review":
        return True
    if isinstance(obj, dict):
        sub = obj.get("subagent")
        if isinstance(sub, dict) and sub.get("other") == "guardian":
            return True
    text = (title or first_user or "").lstrip()
    return text.startswith("The following is the Codex agent history whose request action you are assessing")


def _codex_meta_from_rollout(path: str) -> dict:
    stem = os.path.basename(path).replace(".jsonl", "")
    fallback_id = stem[-36:] if len(stem) >= 36 else stem
    meta = {
        "id": fallback_id,
        "rollout_path": path,
        "created_at_ms": 0,
        "updated_at_ms": 0,
        "source": "",
        "thread_source": "",
        "model_provider": "",
        "cwd": "",
        "title": "",
        "first_user_message": "",
        "model": "",
        "reasoning_effort": "",
        "agent_nickname": "",
        "agent_role": "",
        "parent_thread_id": None,
    }
    try:
        st = os.stat(path)
        meta["created_at_ms"] = int(st.st_mtime * 1000)
        meta["updated_at_ms"] = int(st.st_mtime * 1000)
    except OSError:
        pass
    try:
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                ts = _parse_iso_ms(d.get("timestamp"))
                if ts:
                    meta["created_at_ms"] = min(meta["created_at_ms"] or ts, ts)
                    meta["updated_at_ms"] = max(meta["updated_at_ms"] or ts, ts)
                p = d.get("payload") if isinstance(d.get("payload"), dict) else {}
                if d.get("type") == "session_meta":
                    meta["id"] = p.get("id") or meta["id"]
                    meta["source"] = p.get("source") or meta["source"]
                    meta["thread_source"] = p.get("thread_source") or meta["thread_source"]
                    meta["model_provider"] = p.get("model_provider") or meta["model_provider"]
                    meta["cwd"] = p.get("cwd") or meta["cwd"]
                    meta["agent_nickname"] = p.get("agent_nickname") or meta["agent_nickname"]
                    meta["agent_role"] = p.get("agent_role") or meta["agent_role"]
                    meta["parent_thread_id"] = p.get("parent_thread_id") or _codex_parent_from_source(meta["source"])
                elif d.get("type") == "turn_context":
                    meta["model"] = p.get("model") or meta["model"]
                    meta["reasoning_effort"] = p.get("effort") or meta["reasoning_effort"]
                elif d.get("type") == "event_msg" and p.get("type") == "user_message" and not meta["first_user_message"]:
                    msg = p.get("message")
                    meta["first_user_message"] = _short(msg if isinstance(msg, str) else _short_json(msg), 600)
                if meta["first_user_message"] and meta["model"] and meta["id"] and meta["cwd"]:
                    break
    except OSError:
        pass
    if not meta["title"]:
        meta["title"] = meta["first_user_message"]
    return meta


def _load_codex_index() -> tuple[dict[str, dict], dict[str, list[str]]]:
    """Return ({thread_id: metadata}, {parent_thread_id: [child_thread_id, ...]})."""
    db = _codex_state_db()
    entries: dict[str, dict] = {}
    child_map: dict[str, list[str]] = {}
    if os.path.exists(db):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            try:
                for row in con.execute("""
                    select id, rollout_path, created_at_ms, updated_at_ms, source, model_provider,
                           cwd, title, tokens_used, first_user_message, agent_nickname, agent_role,
                           model, reasoning_effort, thread_source, archived
                    from threads
                """):
                    ent = dict(row)
                    ent["parent_thread_id"] = _codex_parent_from_source(ent.get("source"))
                    entries[ent["id"]] = ent
                for row in con.execute("select parent_thread_id, child_thread_id from thread_spawn_edges"):
                    pid, cid = row["parent_thread_id"], row["child_thread_id"]
                    child_map.setdefault(pid, []).append(cid)
                    if cid in entries:
                        entries[cid]["parent_thread_id"] = pid
            finally:
                con.close()
        except sqlite3.Error:
            entries = {}
            child_map = {}
    if not entries:
        for path in _codex_rollout_glob():
            ent = _codex_meta_from_rollout(path)
            entries[ent["id"]] = ent
            if ent.get("parent_thread_id"):
                child_map.setdefault(ent["parent_thread_id"], []).append(ent["id"])
    return entries, child_map


def _codex_tool_name(p: dict) -> str:
    typ = p.get("type")
    if typ == "tool_search_call":
        return "tool_search"
    if typ == "web_search_call":
        return "web_search"
    if typ == "image_generation_call":
        return "image_generation"
    ns = p.get("namespace")
    nm = p.get("name")
    return f"{ns}.{nm}" if ns and nm else (nm or ns or typ or "?")


def _codex_make_tool_event(call: dict, output_payload: dict, ts: int) -> dict:
    status = output_payload.get("status") or call.get("status") or "ok"
    return {
        "kind": "tool",
        "ts": ts,
        "name": call.get("name") or "?",
        "args": _short_json(call.get("args"), 4000),
        "result": _result_text(_short_json(output_payload.get("output") or output_payload.get("tools") or "", 4000), 2000),
        "dur": call.get("dur", 0) or 0,
        "status": status,
    }


def _codex_update_tool_end(tool_event: dict, p: dict) -> None:
    dur = p.get("duration")
    if isinstance(dur, dict):
        tool_event["dur"] = int((dur.get("secs", 0) or 0) * 1000 + (dur.get("nanos", 0) or 0) / 1_000_000)
    elif p.get("duration_ms") is not None:
        tool_event["dur"] = int(p.get("duration_ms") or 0)
    if p.get("status"):
        tool_event["status"] = p["status"]
    if p.get("success") is False:
        tool_event["status"] = "error"
    result_bits = []
    for k in ("stdout", "stderr", "result"):
        if p.get(k):
            result_bits.append(str(p[k]))
    if result_bits and not tool_event.get("result"):
        tool_event["result"] = _result_text("\n".join(result_bits), 2000)


def _assemble_codex_session(entry: dict) -> Optional[Session]:
    path = entry.get("rollout_path") or ""
    if not path or not os.path.exists(path):
        return None
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    cached = _CODEX_SESSION_CACHE.get(path)
    if cached and cached[0] == mtime:
        return copy.deepcopy(cached[1]) if cached[1] else None

    events = []
    first_user = entry.get("first_user_message") or ""
    t0 = None
    last_ts = 0
    current_model = entry.get("model") or "?"
    current_effort = entry.get("reasoning_effort") or ""
    model_counts: dict[str, int] = {}
    pending_after_req: list[dict] = []
    calls_by_id: dict[str, dict] = {}
    tool_events_by_call_id: dict[str, dict] = {}
    inside_response = False

    def append_after_or_now(ev: dict) -> None:
        if inside_response:
            pending_after_req.append(ev)
        else:
            events.append(ev)

    try:
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                ts = _parse_iso_ms(d.get("timestamp"))
                if not ts:
                    continue
                t0 = min(t0 or ts, ts)
                last_ts = max(last_ts, ts)
                payload = d.get("payload") if isinstance(d.get("payload"), dict) else {}
                rtype = d.get("type")

                if rtype == "turn_context":
                    current_model = payload.get("model") or current_model
                    current_effort = payload.get("effort") or current_effort
                    continue

                if rtype == "compacted" or (rtype == "event_msg" and payload.get("type") == "context_compacted"):
                    events.append({
                        "kind": "req", "ts": ts, "input": 0, "cached": 0, "output": 0,
                        "reasoning_output": 0, "debugName": "context_compacted", "ttft": 0,
                        "model": current_model or "?", "reasoning": current_effort or "",
                        "nano_aiu": None, "is_error": False, "error": "",
                    })
                    inside_response = False
                    if pending_after_req:
                        events.extend(pending_after_req)
                        pending_after_req = []
                    continue

                if rtype == "event_msg":
                    et = payload.get("type")
                    if et == "user_message":
                        msg = payload.get("message") or ""
                        text = _short(msg if isinstance(msg, str) else _short_json(msg), 600)
                        events.append({"kind": "user", "ts": ts, "text": text})
                        if not first_user:
                            first_user = text
                    elif et == "token_count":
                        info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                        usage = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else None
                        if not usage:
                            inside_response = False
                            if pending_after_req:
                                events.extend(pending_after_req)
                                pending_after_req = []
                            continue
                        inp = int(usage.get("input_tokens", 0) or 0)
                        cached = int(usage.get("cached_input_tokens", 0) or 0)
                        out = int(usage.get("output_tokens", 0) or 0)
                        reasoning_out = int(usage.get("reasoning_output_tokens", 0) or 0)
                        model = current_model or entry.get("model") or "?"
                        model_counts[model] = model_counts.get(model, 0) + 1
                        events.append({
                            "kind": "req", "ts": ts, "input": inp, "cached": cached, "output": out,
                            "reasoning_output": reasoning_out, "debugName": "codex", "ttft": 0,
                            "model": model, "reasoning": current_effort or "",
                            "nano_aiu": None, "is_error": False, "error": "",
                        })
                        inside_response = False
                        if pending_after_req:
                            events.extend(pending_after_req)
                            pending_after_req = []
                    elif et and et.endswith("_end"):
                        cid = payload.get("call_id")
                        if cid and cid in tool_events_by_call_id:
                            _codex_update_tool_end(tool_events_by_call_id[cid], payload)
                    elif et == "task_complete":
                        pass
                    continue

                if rtype != "response_item":
                    continue
                ptype = payload.get("type")
                if ptype in {"reasoning", "function_call", "custom_tool_call", "web_search_call",
                             "image_generation_call", "tool_search_call"} or (ptype == "message" and payload.get("role") == "assistant"):
                    inside_response = True

                if ptype in {"function_call", "custom_tool_call", "tool_search_call", "web_search_call", "image_generation_call"}:
                    cid = payload.get("call_id") or f"{ptype}:{ts}:{len(calls_by_id)}"
                    calls_by_id[cid] = {
                        "name": _codex_tool_name(payload),
                        "args": payload.get("arguments") if "arguments" in payload else payload.get("input"),
                        "ts": ts,
                        "status": payload.get("status") or "ok",
                        "dur": 0,
                    }
                elif ptype in {"function_call_output", "custom_tool_call_output", "tool_search_output"}:
                    cid = payload.get("call_id") or f"{ptype}:{ts}:{len(calls_by_id)}"
                    call = calls_by_id.get(cid) or {"name": ptype.replace("_output", ""), "args": "", "ts": ts, "status": "ok", "dur": 0}
                    ev = _codex_make_tool_event(call, payload, ts)
                    tool_events_by_call_id[cid] = ev
                    append_after_or_now(ev)
    except OSError:
        _CODEX_SESSION_CACHE[path] = (mtime, None)
        return None

    if pending_after_req:
        events.extend(pending_after_req)
    reqs = [e for e in events if e["kind"] == "req" and not e.get("is_error")]
    token_reqs = [e for e in reqs if e.get("input") or e.get("output") or e.get("cached")]
    if not token_reqs:
        _CODEX_SESSION_CACHE[path] = (mtime, None)
        return None
    t0 = t0 or min(e["ts"] for e in events if e.get("ts"))
    main = {"events": events, "t0": t0, "first_user": first_user, "path": path}
    total_input = sum(r.get("input", 0) for r in reqs)
    total_cached = sum(r.get("cached", 0) for r in reqs)
    total_output = sum(r.get("output", 0) for r in reqs)
    n_compact = sum(1 for r in reqs if r.get("debugName") in COMPACT_NAMES)
    top_model = max(model_counts.items(), key=lambda x: x[1])[0] if model_counts else (entry.get("model") or current_model or "?")
    sid = entry.get("id") or os.path.basename(path).replace(".jsonl", "")
    source = entry.get("source") or ""
    thread_source = entry.get("thread_source") or ""
    agent_label = _codex_agent_label(source, entry.get("agent_nickname") or "", entry.get("agent_role") or "")
    first_user = first_user or entry.get("title") or sid
    workspace = entry.get("cwd") or "Codex"
    sess = Session(
        sid=sid,
        workspace=workspace,
        mtime=mtime,
        last_event_ts=last_ts,
        main=main,
        source="codex",
        source_label="Codex",
        path=path,
        cost_available=False,
        agent_label=agent_label,
        is_internal=_codex_is_internal(source, top_model, entry.get("title") or "", first_user, thread_source),
        total_input=total_input,
        total_cached=total_cached,
        total_output=total_output,
        n_requests=len(reqs),
        n_compactions=n_compact,
        duration_ms=max(0, last_ts - t0),
        top_model=top_model,
        first_user=first_user,
        total_aic=0.0,
        models_info={},
        parent_sid=entry.get("parent_thread_id"),
    )
    _CODEX_SESSION_CACHE[path] = (mtime, sess)
    return copy.deepcopy(sess)


def _absorb_codex_children(parent: Session, entries: dict[str, dict], child_map: dict[str, list[str]], seen: set[str] | None = None) -> None:
    seen = seen or set()
    if parent.sid in seen:
        return
    seen.add(parent.sid)
    for cid in child_map.get(parent.sid, []):
        ent = entries.get(cid)
        if not ent:
            continue
        child = _assemble_codex_session(ent)
        if not child or child.is_internal:
            continue
        _absorb_codex_children(child, entries, child_map, seen)
        label = child.agent_label or child.first_user or f"subagent {child.sid[:8]}"
        cmain = copy.deepcopy(child.main)
        cmain["label"] = f"sub-agent {label}"
        parent.children.append(cmain)
        parent.total_input += child.total_input
        parent.total_cached += child.total_cached
        parent.total_output += child.total_output
        parent.n_requests += child.n_requests
        parent.n_compactions += child.n_compactions
        parent.last_event_ts = max(parent.last_event_ts, child.last_event_ts)
        if parent.main.get("t0"):
            parent.duration_ms = max(parent.duration_ms, parent.last_event_ts - parent.main["t0"])


def query_codex_sessions(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
    min_tokens: int = 0,
    limit: int = 50,
    sort: str = "total_input",
) -> list[Session]:
    win_start, win_end = resolve_window(since_seconds, start_ts, end_ts)
    entries, child_map = _load_codex_index()
    child_ids = {cid for kids in child_map.values() for cid in kids}
    sessions: list[Session] = []
    for ent in entries.values():
        upd = (ent.get("updated_at_ms") or 0) / 1000
        if upd and upd < win_start:
            continue
        s = _assemble_codex_session(ent)
        if not s or s.is_internal:
            continue
        started = (s.main["t0"] / 1000) if s.main.get("t0") else s.mtime
        ended = max(s.last_event_ts / 1000, started)
        if started > win_end or ended < win_start:
            continue
        if s.total_input < min_tokens:
            continue
        if s.sid in child_ids or s.parent_sid:
            continue
        sessions.append(s)

    key = {
        "total_input": lambda s: -s.total_input,
        "recent": lambda s: -s.last_event_ts,
        "requests": lambda s: -s.n_requests,
        "duration": lambda s: -s.duration_ms,
        "uncached": lambda s: -(s.total_input - s.total_cached),
        "aic": lambda s: -s.total_input,
    }.get(sort, lambda s: -s.total_input)
    sessions.sort(key=key)
    top = sessions[:limit]
    for s in top:
        _absorb_codex_children(s, entries, child_map)
    return top


def _codex_file_signature(path: str) -> list:
    try:
        st = os.stat(path)
        return [st.st_mtime, st.st_size]
    except OSError:
        return []


def _daily_codex_for_entry(ent: dict) -> dict[str, float]:
    """Lightweight {YYYY-MM-DD: input_tokens}; avoids loading tool outputs."""
    if _codex_is_internal(
        ent.get("source") or "",
        ent.get("model") or "",
        ent.get("title") or "",
        ent.get("first_user_message") or "",
        ent.get("thread_source") or "",
    ):
        return {}
    path = ent.get("rollout_path") or ""
    days: dict[str, float] = {}
    try:
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                p = d.get("payload") if isinstance(d.get("payload"), dict) else {}
                if d.get("type") != "event_msg" or p.get("type") != "token_count":
                    continue
                info = p.get("info") if isinstance(p.get("info"), dict) else {}
                usage = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}
                inp = usage.get("input_tokens", 0) or 0
                if not inp:
                    continue
                ts = _parse_iso_ms(d.get("timestamp"))
                if not ts:
                    continue
                day = time.strftime("%Y-%m-%d", time.localtime(ts / 1000))
                days[day] = days.get(day, 0.0) + inp
    except OSError:
        pass
    return days


def daily_codex_tokens() -> dict[str, float]:
    entries, _ = _load_codex_index()
    try:
        with open(analyzer.DAILY_CODEX_CACHE_PATH) as f:
            cache = json.load(f)
        if cache.get("version") != 1:
            raise ValueError
    except Exception:
        cache = {"version": 1, "files": {}}
    files_cache = cache["files"]
    seen = set()
    dirty = False
    totals: dict[str, float] = {}
    for ent in entries.values():
        path = ent.get("rollout_path") or ""
        if not path:
            continue
        seen.add(path)
        sig = _codex_file_signature(path)
        if not sig:
            continue
        cached = files_cache.get(path)
        if not cached or cached.get("sig") != sig:
            days = _daily_codex_for_entry(ent)
            files_cache[path] = {"sig": sig, "days": days}
            dirty = True
        else:
            days = cached.get("days", {})
        for d, v in days.items():
            totals[d] = totals.get(d, 0.0) + v
    for path in [p for p in files_cache if p not in seen]:
        del files_cache[path]
        dirty = True
    if dirty:
        try:
            tmp = analyzer.DAILY_CODEX_CACHE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, analyzer.DAILY_CODEX_CACHE_PATH)
        except OSError:
            pass
    return totals
