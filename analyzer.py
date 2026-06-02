"""Loads VS Code Copilot chat debug logs and aggregates per-session token usage.

Layout on disk (under VS Code's workspaceStorage dir — see _default_workspace_storage):
  <workspaceStorage>/<wsid>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl
  ...                                                              .../<sid>/title-*.jsonl
  ...                                                              .../<sid>/runSubagent-*.jsonl

`main.jsonl` is the foreground panel/editAgent. Sibling jsonl files in the same dir are child sessions
(`title-*` = chat title generator, `runSubagent-*` = subagents). Sessions whose first user message starts
with "Find relevant code snippets for:" are standalone subagent-search sessions in their own session dir;
they appear in the main list as just another session (no parent linkage in the log files).
"""
from __future__ import annotations
import os, sys, json, glob, time, math
from dataclasses import dataclass, field
from typing import Optional


def _default_workspace_storage() -> str:
    """Locate VS Code's workspaceStorage dir for the current platform.

    Override with the COPILOT_USAGE_STORAGE env var if your install is non-standard
    (e.g. VS Code Insiders or VSCodium — point it at the equivalent workspaceStorage dir).
    """
    env = os.environ.get("COPILOT_USAGE_STORAGE")
    if env:
        return os.path.expanduser(env)
    if sys.platform == "darwin":
        root = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        root = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
    else:  # linux / other unix
        root = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(root, "Code", "User", "workspaceStorage")


BASE = _default_workspace_storage()
COMPACT_NAMES = {
    "summarizeConversationHistory",
    "summarizeConversationHistory-simple",
    "summarizeVirtualTools",
}
FIND_PREFIX = "Find relevant code snippets for:"

# ---------- Cache ----------

_FILE_CACHE: dict[str, tuple[float, dict]] = {}
_MODELS_CACHE: dict[str, tuple[float, dict]] = {}  # session_dir -> (mtime, {model_id: (multiplier, premium)})
_GLOBAL_PRICES: dict[str, tuple[float, bool]] | None = None  # union across all models.json with non-null billing
_GLOBAL_PRICES_BUILT_AT: float = 0.0


def _build_global_prices() -> dict[str, tuple[float, bool]]:
    """Scan every models.json on disk; keep the best (non-null, highest multiplier) entry per model id."""
    global _GLOBAL_PRICES, _GLOBAL_PRICES_BUILT_AT
    # rebuild at most once every 10 minutes
    if _GLOBAL_PRICES is not None and (time.time() - _GLOBAL_PRICES_BUILT_AT) < 600:
        return _GLOBAL_PRICES
    table: dict[str, tuple[float, bool]] = {}
    for fp in glob.glob(f"{BASE}/*/GitHub.copilot-chat/debug-logs/*/models.json"):
        try:
            with open(fp) as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for m in data:
            mid = m.get("id")
            if not mid:
                continue
            b = m.get("billing") or {}
            mult = b.get("multiplier")
            premium = b.get("is_premium")
            if mult is None and premium is None:
                continue  # skip un-populated entries
            mult_f = float(mult or 0)
            prem_b = bool(premium) if premium is not None else mult_f > 0
            cur = table.get(mid)
            # prefer the entry with the largest multiplier (newest/most-accurate)
            if not cur or mult_f > cur[0]:
                table[mid] = (mult_f, prem_b)
    _GLOBAL_PRICES = table
    _GLOBAL_PRICES_BUILT_AT = time.time()
    return table


def _load_models_json(session_dir: str) -> dict:
    """Return {model_id: (multiplier, is_premium)} for one session dir."""
    path = os.path.join(session_dir, "models.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    cached = _MODELS_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    info: dict[str, tuple[float, bool]] = {}
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, list):
            for m in data:
                mid = m.get("id")
                b = m.get("billing") or {}
                if mid:
                    info[mid] = (float(b.get("multiplier", 0) or 0), bool(b.get("is_premium", False)))
    except Exception:
        pass
    _MODELS_CACHE[path] = (mtime, info)
    return info


def _aic_for(model_id: str, models_info: dict) -> float:
    """AIC = premium-request multiplier (Copilot's billing unit). Non-premium = 0.

    Falls back to the global price table if the session-local models.json doesn't have
    a populated entry (recent gpt-5.x families often have null billing locally).
    """
    mult, premium = models_info.get(model_id, (0.0, False))
    if not premium and mult == 0:
        # try global table
        g = _build_global_prices().get(model_id)
        if g:
            mult, premium = g
    return mult if premium else 0.0


def _short(s, n=200):
    if not isinstance(s, str):
        s = str(s)
    s = s.replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


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
                        "args": _short(a.get("args", "") or "", 280),
                        "result_chars": len(a.get("result", "") or ""),
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

# Per-session-dir daily AIC totals are persisted here so the full-history calendar view
# doesn't reparse every jsonl on every request. Keyed by the dir's file signature
# (name/mtime/size of every *.jsonl + models.json), so only changed sessions recompute.
DAILY_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".daily_aic_cache.json")


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
            aic = _aic_for(e["model"], models_info)
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
        with open(DAILY_CACHE_PATH) as f:
            cache = json.load(f)
        if cache.get("version") != 1:
            raise ValueError
    except Exception:
        cache = {"version": 1, "dirs": {}}
    dirs = cache["dirs"]
    seen = set()
    dirty = False
    totals: dict[str, float] = {}
    for fp in glob.glob(f"{BASE}/*/GitHub.copilot-chat/debug-logs/*/main.jsonl"):
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
            tmp = DAILY_CACHE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, DAILY_CACHE_PATH)
        except OSError:
            pass
    return totals


# ---------- Discovery ----------

def discover_main_files(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
) -> list[str]:
    """All main.jsonl files whose mtime falls in the window.

    Pass EITHER `since_seconds` (relative to now) OR `start_ts`/`end_ts` (absolute epoch
    seconds). If both are given, the absolute window wins.
    """
    if start_ts is None and end_ts is None and since_seconds is not None:
        start_ts = time.time() - since_seconds
        end_ts = time.time()
    if start_ts is None:
        start_ts = 0
    if end_ts is None:
        end_ts = time.time()
    pat = f"{BASE}/*/GitHub.copilot-chat/debug-logs/*/main.jsonl"
    out = []
    for fp in glob.glob(pat):
        try:
            mt = os.path.getmtime(fp)
            if start_ts <= mt <= end_ts and os.path.getsize(fp) >= 200:
                out.append(fp)
        except OSError:
            continue
    return out


# ---------- Session assembly ----------

@dataclass
class Session:
    sid: str
    workspace: str
    mtime: float
    main: dict
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


def assemble_session(main_path: str) -> Optional[Session]:
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
    total_aic = sum(_aic_for(r["model"], models_info) for r in all_reqs)

    # Detect if this is a search-subagent find-session
    search_query = None
    first_u = main["first_user"]
    if first_u.startswith(FIND_PREFIX):
        search_query = first_u[len(FIND_PREFIX):].strip()

    return Session(
        sid=sid,
        workspace=ws,
        mtime=os.path.getmtime(main_path),
        main=main,
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


# ---------- Series build (for chart + detail pane) ----------

def build_series(sess: Session) -> tuple[list, list]:
    """Return (main_calls, child_groups). Each call is a dict with cum tokens, tools_before, etc."""
    p = sess.main
    t0 = p["t0"]
    main_calls = []
    pending = []
    for e in p["events"]:
        if e["kind"] == "tool":
            pending.append({"name": e["name"], "args": e["args"], "result_chars": e["result_chars"],
                            "dur": e["dur"], "status": e["status"], "t_rel": e["ts"] - t0})
        elif e["kind"] == "user":
            pending.append({"name": "user_message", "args": e["text"], "result_chars": 0,
                            "dur": 0, "status": "ok", "t_rel": e["ts"] - t0})
        elif e["kind"] == "req":
            main_calls.append({
                "idx": len(main_calls),
                "ts": e["ts"], "t_rel": e["ts"] - t0,
                "input": e["input"], "cached": e["cached"], "output": e["output"],
                "debugName": e["debugName"], "model": e["model"], "ttft": e["ttft"],
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
        pcum = 0
        for mc in main_calls:
            if mc["t_rel"] <= start_t:
                pcum = mc["cum"]
            else:
                break
        ccalls = []
        pending = []
        for e in c["events"]:
            if e["kind"] == "tool":
                pending.append({"name": e["name"], "args": e["args"], "result_chars": e["result_chars"],
                                "dur": e["dur"], "status": e["status"], "t_rel": e["ts"] - t0})
            elif e["kind"] == "user":
                pending.append({"name": "user_message", "args": e["text"], "result_chars": 0,
                                "dur": 0, "status": "ok", "t_rel": e["ts"] - t0})
            elif e["kind"] == "req":
                ccalls.append({"idx": len(ccalls), "ts": e["ts"], "t_rel": e["ts"] - t0,
                               "input": e["input"], "cached": e["cached"], "output": e["output"],
                               "debugName": e["debugName"], "model": e["model"], "ttft": e["ttft"],
                               "is_compact": e["debugName"] in COMPACT_NAMES,
                               "is_error": e.get("is_error", False), "error": e.get("error", ""),
                               "tools_before": pending[:]})
                pending = []
        cc = 0
        for x in ccalls:
            cc += x["input"]
            x["cum_offset"] = pcum + cc
        kids.append({"label": c["label"], "start_t": start_t, "start_tok": pcum, "calls": ccalls})

    # Absorb search-children as virtual kids, anchored at the parent's tool_call.ts
    for csid in sess.search_children:
        cpath = sess.search_child_paths.get(csid)
        if not cpath:
            continue
        child_sess = assemble_session(cpath)
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
        })

    return main_calls, kids


# ---------- Query API ----------

def query_sessions(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
    min_tokens: int = 0,
    limit: int = 50,
    sort: str = "total_input",
) -> list[Session]:
    paths = discover_main_files(since_seconds=since_seconds, start_ts=start_ts, end_ts=end_ts)
    sessions: list[Session] = []
    for fp in paths:
        s = assemble_session(fp)
        if not s:
            continue
        if s.total_input < min_tokens:
            continue
        sessions.append(s)
    key = {
        "total_input": lambda s: -s.total_input,
        "recent": lambda s: -s.mtime,
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


def session_summary(s: Session) -> dict:
    """Lightweight dict for the card list (no per-turn details)."""
    main_calls, kids = build_series(s)

    def with_aic(c):
        return _aic_for(c["model"], s.models_info)

    return {
        "sid": s.sid,
        "workspace": s.workspace,
        "mtime": s.mtime,
        "first_user": s.first_user,
        "total_input": s.total_input,
        "total_cached": s.total_cached,
        "total_output": s.total_output,
        "n_requests": s.n_requests,
        "n_compactions": s.n_compactions,
        "duration_ms": s.duration_ms,
        "top_model": s.top_model,
        "total_aic": s.total_aic,
        "parent_sid": s.parent_sid,
        "parent_first_user": s.parent_first_user,
        "search_children": s.search_children,
        "search_query": s.search_query,
        "main": [{"idx": c["idx"], "t": c["t_rel"], "input": c["input"],
                  "cached": c["cached"], "output": c["output"],
                  "dbg": c["debugName"], "compact": c["is_compact"],
                  "err": c.get("is_error", False),
                  "aic": with_aic(c),
                  "cum": c["cum"]} for c in main_calls],
        "kids": [{"label": k["label"], "start_t": k["start_t"], "start_tok": k["start_tok"],
                  "is_search_child": k.get("is_search_child", False),
                  "child_sid": k.get("child_sid"),
                  "calls": [{"idx": c["idx"], "t": c["t_rel"], "input": c["input"],
                             "cached": c["cached"], "output": c["output"],
                             "dbg": c["debugName"], "compact": c["is_compact"],
                             "err": c.get("is_error", False),
                             "aic": with_aic(c),
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
            "aic": _aic_for(c["model"], s.models_info),
            "cum": c.get("cum"), "cum_offset": c.get("cum_offset"),
            "tools": [{"n": t["name"], "a": t["args"], "rc": t["result_chars"],
                       "d": t["dur"], "s": t["status"], "t": t["t_rel"]}
                      for t in c["tools_before"]],
        }

    return {
        "sid": s.sid,
        "workspace": s.workspace,
        "mtime": s.mtime,
        "first_user": s.first_user,
        "total_input": s.total_input,
        "total_cached": s.total_cached,
        "total_output": s.total_output,
        "n_requests": s.n_requests,
        "n_compactions": s.n_compactions,
        "duration_ms": s.duration_ms,
        "top_model": s.top_model,
        "total_aic": s.total_aic,
        "parent_sid": s.parent_sid,
        "parent_first_user": s.parent_first_user,
        "search_children": s.search_children,
        "search_query": s.search_query,
        "main": [trim_call(c) for c in main_calls],
        "kids": [{"label": k["label"], "start_t": k["start_t"], "start_tok": k["start_tok"],
                  "is_search_child": k.get("is_search_child", False),
                  "child_sid": k.get("child_sid"),
                  "calls": [trim_call(c) for c in k["calls"]]} for k in kids],
    }
