"""GitHub Copilot chat session support.

Copilot layout on disk (under VS Code's workspaceStorage dir — see paths._default_workspace_storage):
  <workspaceStorage>/<wsid>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl
  ...                                                              .../<sid>/title-*.jsonl
  ...                                                              .../<sid>/runSubagent-*.jsonl

`main.jsonl` is the foreground panel/editAgent. Sibling jsonl files in the same dir are child sessions
(`title-*` = chat title generator, `runSubagent-*` = subagents). Sessions whose first user message starts
with "Find relevant code snippets for:" are standalone subagent-search sessions in their own session dir;
they appear in the main list as just another session (no parent linkage in the log files).
"""
from __future__ import annotations
import os
import json
import glob
import time

from llmly import analyzer
from .constants import COMPACT_NAMES, FIND_PREFIX
from .models import Session
from .paths import candidate_workspace_storage_paths
from .pricing import _aic_for_req, _load_models_json
from .text import _short, _clip, _result_text
from .window import resolve_window

# ---------- Cache ----------

_FILE_CACHE: dict[str, tuple[float, dict]] = {}


# ---------- jsonl parsing ----------

def _reasoning_level(a: dict) -> str:
    """The reasoning/thinking *level* requested for one llm_request.

    VS Code Copilot does NOT log a separate reasoning token COUNT — reasoning is folded
    into outputTokens. What it does log is the requested effort, in requestOptions:
      OpenAI responses API: {"reasoning": {"effort": "low|medium|high|xhigh", ...}}
      Anthropic:            {"thinking": {"type": "enabled", "budget_tokens": 16000}}
    Returns a short label ("xhigh", "medium", "think:16k", …) or "" when none was set.
    """
    ro = a.get("requestOptions")
    if isinstance(ro, str):
        try:
            ro = json.loads(ro)
        except Exception:
            ro = {}
    if not isinstance(ro, dict):
        return ""
    r = ro.get("reasoning")
    if isinstance(r, dict) and r.get("effort"):
        return str(r["effort"])
    th = ro.get("thinking")
    if isinstance(th, dict) and th.get("type") == "enabled":
        b = th.get("budget_tokens")
        try:
            return f"think:{int(b) // 1000}k" if b else "think"
        except (TypeError, ValueError):
            return "think"
    return ""


def _load_jsonl(path: str) -> dict:
    """Parse one jsonl file into ordered events. Cached by mtime."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {"events": [], "t0": None, "first_user": ""}
    cached = _FILE_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    events = []
    first_user = ""
    t0 = None
    try:
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                ts = d.get("ts")
                t = d.get("type")
                if t in ("llm_request", "user_message", "tool_call") and ts:
                    if t0 is None or ts < t0:
                        t0 = ts
                a = d.get("attrs") or {}
                if t == "llm_request":
                    events.append({
                        "kind": "req",
                        "ts": ts,
                        "input": a.get("inputTokens", 0) or 0,
                        "cached": a.get("cachedTokens", 0) or 0,
                        "output": a.get("outputTokens", 0) or 0,
                        "debugName": a.get("debugName", "?"),
                        "ttft": a.get("ttft", 0) or 0,
                        "model": a.get("model", "?"),
                        # requested reasoning/thinking effort level (not a token count — VS Code
                        # doesn't log reasoning tokens separately; they're inside outputTokens)
                        "reasoning": _reasoning_level(a),
                        # billed credits ×1e9, reported by the Copilot API per request;
                        # None on older logs / failed requests
                        "nano_aiu": a.get("copilotUsageNanoAiu"),
                        # failed requests (server error / websocket drop) report no usage;
                        # they show up as 0/0 token turns unless flagged
                        "is_error": d.get("status") == "error",
                        "error": _short(a.get("error", "") or "", 140),
                    })
                elif t == "tool_call":
                    events.append({
                        "kind": "tool",
                        "ts": ts,
                        "name": d.get("name", "?"),
                        "args": _clip(a.get("args", "") or "", 4000),
                        "result": _result_text(a.get("result", "") or "", 2000),
                        "dur": d.get("dur", 0) or 0,
                        "status": d.get("status", "?"),
                    })
                elif t == "user_message":
                    c = a.get("content") or a.get("text") or ""
                    text = _short(c, 600) if isinstance(c, str) else ""
                    events.append({"kind": "user", "ts": ts, "text": text})
                    if not first_user and isinstance(c, str):
                        first_user = c[:240]
    except OSError:
        pass
    out = {"events": events, "t0": t0, "first_user": first_user, "path": path}
    _FILE_CACHE[path] = (mtime, out)
    return out


# ---------- Daily AIC aggregate (disk-cached) ----------

def _session_dir_signature(sess_dir: str) -> list:
    sig = []
    for fp in sorted(glob.glob(os.path.join(sess_dir, "*.jsonl"))):
        try:
            st = os.stat(fp)
            sig.append([os.path.basename(fp), st.st_mtime, st.st_size])
        except OSError:
            continue
    mj = os.path.join(sess_dir, "models.json")
    try:
        sig.append(["models.json", os.path.getmtime(mj), os.path.getsize(mj)])
    except OSError:
        pass
    return sig


def _daily_aic_for_dir(sess_dir: str) -> dict[str, float]:
    """{YYYY-MM-DD: aic} for every llm_request in this session dir, bucketed by local day."""
    models_info = _load_models_json(sess_dir)
    if not models_info:
        for sibling in glob.glob(os.path.dirname(sess_dir) + "/*/models.json"):
            mi = _load_models_json(os.path.dirname(sibling))
            if mi:
                models_info = mi
                break
    days: dict[str, float] = {}
    for fp in glob.glob(os.path.join(sess_dir, "*.jsonl")):
        data = _load_jsonl(fp)
        for e in data["events"]:
            if e["kind"] != "req" or not e.get("ts"):
                continue
            aic = _aic_for_req(e, models_info)
            if aic <= 0:
                continue
            day = time.strftime("%Y-%m-%d", time.localtime(e["ts"] / 1000))
            days[day] = days.get(day, 0.0) + aic
    return days


def daily_aic() -> dict[str, float]:
    """Total AIC per local calendar day across ALL sessions on disk.

    Every session dir is counted exactly once (search-subagent find-sessions live in
    their own dirs, so there's no double counting with parent absorption).
    """
    try:
        with open(analyzer.DAILY_CACHE_PATH) as f:
            cache = json.load(f)
        if cache.get("version") != 2:  # v2: nanoAiu/token-price credits replaced multiplier counting
            raise ValueError
    except Exception:
        cache = {"version": 2, "dirs": {}}
    dirs = cache["dirs"]
    seen = set()
    dirty = False
    totals: dict[str, float] = {}
    for fp in glob.glob(f"{analyzer.BASE}/*/GitHub.copilot-chat/debug-logs/*/main.jsonl"):
        sess_dir = os.path.dirname(fp)
        seen.add(sess_dir)
        sig = _session_dir_signature(sess_dir)
        ent = dirs.get(sess_dir)
        if not ent or ent.get("sig") != sig:
            days = _daily_aic_for_dir(sess_dir)
            dirs[sess_dir] = {"sig": sig, "days": days}
            dirty = True
        else:
            days = ent["days"]
        for d, v in days.items():
            totals[d] = totals.get(d, 0.0) + v
    for d in [d for d in dirs if d not in seen]:
        del dirs[d]
        dirty = True
    if dirty:
        try:
            tmp = analyzer.DAILY_CACHE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, analyzer.DAILY_CACHE_PATH)
        except OSError:
            pass
    return totals


def daily_copilot_tokens() -> dict[str, float]:
    """Total input tokens per local calendar day across Copilot sessions."""
    totals: dict[str, float] = {}
    for fp in glob.glob(f"{analyzer.BASE}/*/GitHub.copilot-chat/debug-logs/*/*.jsonl"):
        data = _load_jsonl(fp)
        for e in data["events"]:
            if e["kind"] != "req" or not e.get("ts"):
                continue
            day = time.strftime("%Y-%m-%d", time.localtime(e["ts"] / 1000))
            totals[day] = totals.get(day, 0.0) + (e.get("input", 0) or 0)
    return totals


# ---------- Discovery ----------

def discover_main_files(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
) -> list[str]:
    """Candidate main.jsonl files for the window, pre-filtered by mtime.

    mtime is the LAST write: mtime < window start ⇒ the session ended before the
    window and can't intersect it, so it's skipped cheaply. No upper mtime cut is
    applied — a session started inside (or before) the window keeps a fresh mtime
    while it's active. The precise "lifetime intersects window" test happens in
    query_sessions() against the session's first/last event timestamps.
    """
    start_ts, _ = resolve_window(since_seconds, start_ts, end_ts)
    pat = f"{analyzer.BASE}/*/GitHub.copilot-chat/debug-logs/*/main.jsonl"
    out = []
    for fp in glob.glob(pat):
        try:
            if os.path.getmtime(fp) >= start_ts and os.path.getsize(fp) >= 200:
                out.append(fp)
        except OSError:
            continue
    return out


def diagnose_copilot_logs() -> dict:
    """Inspect likely VS Code Copilot log locations without parsing sessions."""
    candidates = [(analyzer.BASE, "effective BASE")]
    candidates.extend(candidate_workspace_storage_paths())
    seen = set()
    roots = []
    for root, label in candidates:
        if root in seen:
            continue
        seen.add(root)
        workspace_pat = os.path.join(root, "*")
        debug_pat = os.path.join(root, "*", "GitHub.copilot-chat", "debug-logs")
        session_pat = os.path.join(root, "*", "GitHub.copilot-chat", "debug-logs", "*")
        main_pat = os.path.join(root, "*", "GitHub.copilot-chat", "debug-logs", "*", "main.jsonl")
        jsonl_pat = os.path.join(root, "*", "GitHub.copilot-chat", "debug-logs", "*", "*.jsonl")
        main_files = glob.glob(main_pat)
        readable_main = []
        for fp in main_files:
            try:
                readable_main.append({"path": fp, "size": os.path.getsize(fp), "mtime": os.path.getmtime(fp)})
            except OSError:
                continue
        roots.append({
            "label": label,
            "path": root,
            "exists": os.path.isdir(root),
            "workspace_dirs": len([p for p in glob.glob(workspace_pat) if os.path.isdir(p)]),
            "debug_log_dirs": len([p for p in glob.glob(debug_pat) if os.path.isdir(p)]),
            "session_dirs": len([p for p in glob.glob(session_pat) if os.path.isdir(p)]),
            "main_jsonl": len(main_files),
            "jsonl_files": len(glob.glob(jsonl_pat)),
            "recent_main": sorted(readable_main, key=lambda item: item["mtime"], reverse=True)[:5],
        })
    return {
        "env": os.environ.get("COPILOT_USAGE_STORAGE"),
        "effective_base": analyzer.BASE,
        "roots": roots,
    }


# ---------- Session assembly ----------

def assemble_session(main_path: str) -> "Session | None":
    main = _load_jsonl(main_path)
    if not main["events"] or main["t0"] is None:
        return None
    reqs = [e for e in main["events"] if e["kind"] == "req"]
    if not reqs:
        return None
    sess_dir = os.path.dirname(main_path)
    sid = os.path.basename(sess_dir)
    # <BASE>/<ws>/GitHub.copilot-chat/debug-logs/<sid> — walk up 3 dirs for the workspace id
    ws = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(sess_dir))))
    children = []
    for cf in glob.glob(f"{sess_dir}/*.jsonl"):
        if cf == main_path:
            continue
        cs = _load_jsonl(cf)
        if not any(e["kind"] == "req" for e in cs["events"]):
            continue
        cs["label"] = os.path.basename(cf).replace(".jsonl", "")
        children.append(cs)

    # totals
    all_reqs = list(reqs)
    for c in children:
        all_reqs.extend(e for e in c["events"] if e["kind"] == "req")
    total_input = sum(r["input"] for r in all_reqs)
    total_cached = sum(r["cached"] for r in all_reqs)
    total_output = sum(r["output"] for r in all_reqs)
    n_compact = sum(1 for r in all_reqs if r["debugName"] in COMPACT_NAMES)
    last_ts = max(e["ts"] for e in main["events"] if e.get("ts")) if main["events"] else main["t0"]
    duration_ms = last_ts - main["t0"]

    # most common model in foreground requests
    model_counts: dict[str, int] = {}
    for r in reqs:
        model_counts[r["model"]] = model_counts.get(r["model"], 0) + 1
    top_model = max(model_counts.items(), key=lambda x: x[1])[0] if model_counts else "?"

    # AIC from models.json (session dir + parent workspace dir as fallback)
    models_info = _load_models_json(sess_dir)
    if not models_info:
        # try sibling dirs in same workspace as fallback
        for sibling in glob.glob(os.path.dirname(sess_dir) + "/*/models.json"):
            mi = _load_models_json(os.path.dirname(sibling))
            if mi:
                models_info = mi
                break
    total_aic = sum(_aic_for_req(r, models_info) for r in all_reqs)

    # Detect if this is a search-subagent find-session
    search_query = None
    first_u = main["first_user"]
    if first_u.startswith(FIND_PREFIX):
        search_query = first_u[len(FIND_PREFIX):].strip()

    return Session(
        sid=sid,
        workspace=ws,
        mtime=os.path.getmtime(main_path),
        last_event_ts=last_ts,
        main=main,
        source="copilot",
        source_label="Copilot",
        path=main_path,
        cost_available=True,
        children=children,
        total_input=total_input,
        total_cached=total_cached,
        total_output=total_output,
        n_requests=len(all_reqs),
        n_compactions=n_compact,
        duration_ms=duration_ms,
        top_model=top_model,
        first_user=first_u,
        total_aic=total_aic,
        models_info=models_info,
        search_query=search_query,
    )


# ---------- Parent linkage for search-subagent find-sessions ----------

# We match a find-session to its parent by:
#   parent has a tool_call name=='search_subagent' whose args.query starts with the find-session's
#   search_query text. Multiple parents can match — prefer the closest temporal match (parent's
#   tool_call ts within ±5min of find-session's t0).

def _extract_search_queries(session_main_path: str) -> list[tuple[int, str]]:
    """Return [(ts, query_first_120chars), ...] for every search_subagent tool_call in this session."""
    out = []
    try:
        with open(session_main_path) as f:
            for line in f:
                if '"name":"search_subagent"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                a = d.get("attrs") or {}
                args_str = a.get("args") or ""
                try:
                    args = json.loads(args_str)
                    q = (args.get("query") or "").strip()
                    if q:
                        out.append((d.get("ts", 0) or 0, q[:120]))
                except Exception:
                    continue
    except OSError:
        pass
    return out


def link_search_parents(sessions: list[Session], scan_window_days: int = 30) -> None:
    """Mutate `sessions` to:
        1. set parent_sid on every find-session (even those whose parent is outside the result set)
        2. attach search_children to every parent (even children outside the result set)

    Scans a wider window than `sessions` so parents/children outside the current query window
    are still discoverable.
    """
    if not sessions:
        return
    paths = discover_main_files(scan_window_days * 86400)

    # Build {query_prefix: [(parent_sid, parent_first_user, parent_path, tool_ts), ...]}
    query_index: dict[str, list[tuple[str, str, str, int]]] = {}
    # Also enumerate find-sessions in the wide window so parents can pull their full list
    finds_in_window: list[tuple[str, str, str, str, int]] = []  # (sid, first_user, query, path, t0)
    for fp in paths:
        ms = _load_jsonl(fp)
        first_u = ms.get("first_user", "") or ""
        sid = os.path.basename(os.path.dirname(fp))
        if first_u.startswith(FIND_PREFIX):
            q = first_u[len(FIND_PREFIX):].strip()
            finds_in_window.append((sid, first_u, q, fp, ms.get("t0") or 0))
            continue
        for ts, q in _extract_search_queries(fp):
            query_index.setdefault(q[:120], []).append((sid, first_u, fp, ts))

    # For every find-session in the window, identify the best parent (closest tool_call ts)
    find_to_parent: dict[str, tuple[str, str, int, str]] = {}  # sid -> (psid, pfu, spawn_ts, fpath)
    for fsid, _fu, q, fpath, ft0 in finds_in_window:
        cands = query_index.get(q[:120], [])
        if not cands:
            continue
        best = min(cands, key=lambda c: abs(c[3] - ft0))
        find_to_parent[fsid] = (best[0], best[1][:240], best[3], fpath)

    # Apply to find-sessions in `sessions` so they get parent_sid (used for filtering)
    finds_in_result = {s.sid: s for s in sessions if s.search_query}
    for fsid, (psid, pfu, _ts, _fpath) in find_to_parent.items():
        if fsid in finds_in_result:
            finds_in_result[fsid].parent_sid = psid
            finds_in_result[fsid].parent_first_user = pfu

    # Attach search_children to every parent in `sessions`
    parents_in_result = {s.sid: s for s in sessions if not s.search_query}
    children_by_parent: dict[str, list[tuple[str, int, str]]] = {}
    for fsid, (psid, _pfu, spawn_ts, fpath) in find_to_parent.items():
        children_by_parent.setdefault(psid, []).append((fsid, spawn_ts, fpath))
    for psid, parent in parents_in_result.items():
        cs = children_by_parent.get(psid, [])
        # sort by spawn time so they appear in chronological order
        cs.sort(key=lambda x: x[1])
        parent.search_children = [c[0] for c in cs]
        parent.search_child_spawn_ts = {c[0]: c[1] for c in cs}
        parent.search_child_paths = {c[0]: c[2] for c in cs}


def absorb_search_children(parent: Session) -> None:
    """Fold each linked search-child's totals into the parent's headline numbers.

    Requires link_search_parents() to have populated parent.search_child_paths first.
    """
    for csid, cpath in parent.search_child_paths.items():
        child = assemble_session(cpath)
        if not child:
            continue
        parent.total_input += child.total_input
        parent.total_cached += child.total_cached
        parent.total_output += child.total_output
        parent.total_aic += child.total_aic
        parent.n_requests += child.n_requests
        parent.n_compactions += child.n_compactions


# ---------- Query ----------

def query_copilot_sessions(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
    min_tokens: int = 0,
    limit: int = 50,
    sort: str = "total_input",
) -> list[Session]:
    win_start, win_end = resolve_window(since_seconds, start_ts, end_ts)
    paths = discover_main_files(start_ts=win_start, end_ts=win_end)
    sessions: list[Session] = []
    for fp in paths:
        s = assemble_session(fp)
        if not s:
            continue
        # A session belongs to the window if its lifetime INTERSECTS it:
        # [first event ts, last event ts] overlaps [win_start, win_end]. This keeps
        # ongoing chats visible both in historical windows (they started there)
        # and in "last N hours" windows (they're active there) regardless of
        # where the chat began. We use the last EVENT time, not the file mtime —
        # Copilot rewrites the log on reopen, bumping mtime to "now" with no new
        # events, which would otherwise drag a stale session into recent windows.
        started = (s.main["t0"] / 1000) if s.main.get("t0") else s.mtime
        ended = max(s.last_event_ts / 1000, started)
        if started > win_end or ended < win_start:
            continue
        if s.total_input < min_tokens:
            continue
        sessions.append(s)
    key = {
        "total_input": lambda s: -s.total_input,
        "recent": lambda s: -s.last_event_ts,
        "requests": lambda s: -s.n_requests,
        "duration": lambda s: -s.duration_ms,
        "uncached": lambda s: -(s.total_input - s.total_cached),
        "aic": lambda s: -s.total_aic,
    }.get(sort, lambda s: -s.total_input)
    sessions.sort(key=key)

    # Wire parent linkage on the FULL sorted list first so we know which sessions are find-sessions
    # with identified parents. Then hide those from the result (they'll appear as virtual children
    # inside the parent's chart). Take limit AFTER filtering so we don't lose slots.
    link_search_parents(sessions)
    visible = [s for s in sessions if not (s.search_query and s.parent_sid)]
    top = visible[:limit]

    # Absorb each parent's search-children into its totals so the parent's headline numbers
    # reflect what the user truly spent (including subagent searches it spawned).
    for parent in top:
        absorb_search_children(parent)
    return top
