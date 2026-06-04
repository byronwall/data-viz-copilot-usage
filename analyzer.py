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
import os, sys, json, glob, time, math, re
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
# Requests VS Code sends with interactionTypeOverride:"conversation-background" — the
# extension excludes their copilot usage from the per-turn credit badge, so we must too
# (see setLastCopilotUsage gating in the copilot-chat bundle).
BACKGROUND_NAMES = {
    "git-branch",
    "backgroundTodoAgent",
    "summarize",
    "title",
    "promptCategorization",
    "contextualProgressMessage",
    "progressMessages",
}
FIND_PREFIX = "Find relevant code snippets for:"

# ---------- Cache ----------

_FILE_CACHE: dict[str, tuple[float, dict]] = {}
_MODELS_CACHE: dict[str, tuple[float, dict]] = {}  # session_dir -> (mtime, {model_id: billing-info dict})
_GLOBAL_PRICES: dict[str, dict] | None = None  # union across all models.json with non-null billing
_GLOBAL_PRICES_BUILT_AT: float = 0.0


def _parse_billing(m: dict) -> dict | None:
    """Normalize one models.json entry's billing block.

    Two schemas exist on disk:
      old: {"multiplier": 1, "is_premium": true}              (premium-request counting)
      new: {"token_prices": {"batch_size": 1e6, "default":    (credit pricing per token)
            {"input_price": 250, "cache_price": 25, "output_price": 1500}}}
    Returns {"prices": {...}} and/or {"mult": float, "premium": bool}, or None if unpopulated.
    """
    b = m.get("billing") or {}
    info: dict = {}
    tp = b.get("token_prices") or {}
    d = tp.get("default") or {}
    if d:
        info["prices"] = {
            "input": float(d.get("input_price", 0) or 0),
            "cache": float(d.get("cache_price", 0) or 0),
            "output": float(d.get("output_price", 0) or 0),
            "batch": float(tp.get("batch_size", 1_000_000) or 1_000_000),
        }
    mult = b.get("multiplier")
    premium = b.get("is_premium")
    if mult is not None or premium is not None:
        mult_f = float(mult or 0)
        info["mult"] = mult_f
        info["premium"] = bool(premium) if premium is not None else mult_f > 0
    return info or None


def _build_global_prices() -> dict[str, dict]:
    """Scan every models.json on disk; keep the best (populated) billing entry per model id."""
    global _GLOBAL_PRICES, _GLOBAL_PRICES_BUILT_AT
    # rebuild at most once every 10 minutes
    if _GLOBAL_PRICES is not None and (time.time() - _GLOBAL_PRICES_BUILT_AT) < 600:
        return _GLOBAL_PRICES
    table: dict[str, dict] = {}
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
            info = _parse_billing(m)
            if not info:
                continue
            cur = table.get(mid)
            # prefer token-price entries (newer schema); among multiplier-only entries, the largest
            if not cur or ("prices" in info and "prices" not in cur) or \
               ("prices" not in cur and info.get("mult", 0) > cur.get("mult", 0)):
                table[mid] = info
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
    info: dict[str, dict] = {}
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, list):
            for m in data:
                mid = m.get("id")
                if not mid:
                    continue
                bi = _parse_billing(m)
                if bi:
                    info[mid] = bi
    except Exception:
        pass
    _MODELS_CACHE[path] = (mtime, info)
    return info


def _aic_for_req(r: dict, models_info: dict) -> float:
    """Credits (AIC) for one llm_request, matching VS Code's per-turn credit badge.

    Priority:
      1. attrs.copilotUsageNanoAiu — the billed value the Copilot API reports per request.
         This is what VS Code itself sums (÷1e9) for the "N credits" badge, so it's exact.
      2. token_prices from models.json: (input-cached)*input + cached*cache + output*output,
         per batch_size tokens (verified to reproduce nanoAiu to the digit).
      3. Legacy premium-request multiplier (older logs, pre credit-billing).

    Background requests (title generator, todo agent, …) are excluded — VS Code skips
    interactionTypeOverride:"conversation-background" requests when accumulating turn credits.
    """
    if r.get("debugName") in BACKGROUND_NAMES:
        return 0.0
    nano = r.get("nano_aiu")
    if nano is not None:
        return nano / 1e9
    model_id = r.get("model")
    info = models_info.get(model_id)
    if not info or ("prices" not in info and not info.get("premium")):
        # session-local entry missing/unpopulated (recent gpt-5.x often have null billing
        # locally) — fall back to the global table built from every models.json on disk
        info = _build_global_prices().get(model_id) or info or {}
    p = info.get("prices")
    if p:
        inp = r.get("input", 0) or 0
        cached = r.get("cached", 0) or 0
        out = r.get("output", 0) or 0
        return (max(0, inp - cached) * p["input"] + cached * p["cache"] + out * p["output"]) / p["batch"]
    return info.get("mult", 0.0) if info.get("premium") else 0.0


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


# Display order for reasoning levels (low → highest); anything unknown sorts last-but-known.
_REASONING_RANK = {"minimal": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4}


def _reasoning_summary(calls: list) -> str:
    """Collapse a session's per-call reasoning levels into one label for the rollup.

    Most sessions use a single level → just that label. Mixed sessions show the distinct
    levels low→high joined with '·' so the table reveals when a thread spanned levels.
    """
    seen = []
    for c in calls:
        r = c.get("reasoning")
        if r and r not in seen:
            seen.append(r)
    if not seen:
        return ""
    seen.sort(key=lambda r: (_REASONING_RANK.get(r, 99), r))
    return "·".join(seen)


def _short(s, n=200):
    if not isinstance(s, str):
        s = str(s)
    s = s.replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _clip(s, n=4000):
    """Like _short but preserves newlines — used for args/results the UI renders verbatim."""
    if not isinstance(s, str):
        s = str(s)
    s = s.strip()
    return s if len(s) <= n else s[: n - 1] + "…"


_TEXT_FIELD_RE = re.compile(r'"text":"((?:[^"\\]|\\.)*)"')


def _result_text(r, n=2000):
    """Tool results are usually a serialized VS Code node tree (nested {text:...} nodes);
    flatten those into readable text. Plain-text results (terminal output) pass through."""
    if not isinstance(r, str):
        r = str(r)
    r = r.strip()
    if not r:
        return ""
    if r[:1] in "{[":
        texts: list[str] = []
        try:
            obj = json.loads(r)

            def walk(x):
                if isinstance(x, dict):
                    t = x.get("text")
                    if isinstance(t, str) and t:
                        texts.append(t)
                    for v in x.values():
                        walk(v)
                elif isinstance(x, list):
                    for v in x:
                        walk(v)

            walk(obj)
        except Exception:
            pass
        # Results are truncated at ~5KB by the logger, so the node-tree JSON is often
        # incomplete and won't parse. Fall back to a regex sweep of "text":"…" fields,
        # which still reads correctly up to the truncation point.
        if not texts:
            for m in _TEXT_FIELD_RE.findall(r):
                try:
                    texts.append(json.loads('"' + m + '"'))
                except Exception:
                    texts.append(m)
        if texts:
            r = "\n".join(texts)
    return r if len(r) <= n else r[: n - 1] + "…"


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
        with open(DAILY_CACHE_PATH) as f:
            cache = json.load(f)
        if cache.get("version") != 2:  # v2: nanoAiu/token-price credits replaced multiplier counting
            raise ValueError
    except Exception:
        cache = {"version": 2, "dirs": {}}
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

def resolve_window(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
) -> tuple[float, float]:
    """Normalize the two ways a window can be expressed into absolute (start, end).

    Pass EITHER `since_seconds` (relative to now) OR `start_ts`/`end_ts` (absolute epoch
    seconds). If both are given, the absolute window wins.
    """
    if start_ts is None and end_ts is None and since_seconds is not None:
        start_ts = time.time() - since_seconds
        end_ts = time.time()
    return (start_ts if start_ts is not None else 0,
            end_ts if end_ts is not None else time.time())


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
    pat = f"{BASE}/*/GitHub.copilot-chat/debug-logs/*/main.jsonl"
    out = []
    for fp in glob.glob(pat):
        try:
            if os.path.getmtime(fp) >= start_ts and os.path.getsize(fp) >= 200:
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
    # epoch ms of the LAST real conversation event. Unlike mtime, this is immune to the
    # log file being rewritten/touched later (which Copilot does on reopen) — so it's the
    # honest "when did this chat actually happen" timestamp for display.
    last_event_ts: int
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
            "top_model": _top_model(flat_calls),
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
        return _aic_for_req(c, s.models_info)

    return {
        "sid": s.sid,
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
        "total_aic": s.total_aic,
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
            "aic": _aic_for_req(c, s.models_info), "reasoning": c.get("reasoning", ""),
            "cum": c.get("cum"), "cum_offset": c.get("cum_offset"),
            "tools": [{"n": t["name"], "a": t["args"], "res": t.get("result", ""),
                       "d": t["dur"], "s": t["status"], "t": t["t_rel"]}
                      for t in c["tools_before"]],
        }

    return {
        "sid": s.sid,
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
        "total_aic": s.total_aic,
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
