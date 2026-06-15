"""Loads Copilot and Codex local session logs and aggregates per-session token usage.

Copilot layout on disk (under VS Code's workspaceStorage dir — see _default_workspace_storage):
  <workspaceStorage>/<wsid>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl
  ...                                                              .../<sid>/title-*.jsonl
  ...                                                              .../<sid>/runSubagent-*.jsonl

`main.jsonl` is the foreground panel/editAgent. Sibling jsonl files in the same dir are child sessions
(`title-*` = chat title generator, `runSubagent-*` = subagents). Sessions whose first user message starts
with "Find relevant code snippets for:" are standalone subagent-search sessions in their own session dir;
they appear in the main list as just another session (no parent linkage in the log files).

Codex layout on disk (under CODEX_HOME / ~/.codex):
  state_5.sqlite or sqlite/state_5.sqlite thread index + parent/child edges
  sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
"""
from __future__ import annotations
import os, sys, json, glob, time, math, re, sqlite3, copy
from dataclasses import dataclass, field
from datetime import datetime
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


def _default_codex_home() -> str:
    """Locate Codex's local state directory.

    CODEX_USAGE_HOME is viewer-specific; CODEX_HOME matches Codex itself.
    """
    env = os.environ.get("CODEX_USAGE_HOME") or os.environ.get("CODEX_HOME")
    return os.path.expanduser(env) if env else os.path.expanduser("~/.codex")


CODEX_BASE = _default_codex_home()
COMPACT_NAMES = {
    "summarizeConversationHistory",
    "summarizeConversationHistory-simple",
    "summarizeVirtualTools",
    "context_compacted",
    "compacted",
}
SOURCES = {"all", "copilot", "codex"}
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
_CODEX_SESSION_CACHE: dict[str, tuple[float, Optional["Session"]]] = {}


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
DAILY_CODEX_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".daily_codex_cache.json")


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


def daily_copilot_tokens() -> dict[str, float]:
    """Total input tokens per local calendar day across Copilot sessions."""
    totals: dict[str, float] = {}
    for fp in glob.glob(f"{BASE}/*/GitHub.copilot-chat/debug-logs/*/*.jsonl"):
        data = _load_jsonl(fp)
        for e in data["events"]:
            if e["kind"] != "req" or not e.get("ts"):
                continue
            day = time.strftime("%Y-%m-%d", time.localtime(e["ts"] / 1000))
            totals[day] = totals.get(day, 0.0) + (e.get("input", 0) or 0)
    return totals


def daily_usage(source: str = "copilot") -> dict:
    """Daily metric for the selected source.

    Copilot keeps its exact AIC calendar. Codex and mixed-source views use input
    tokens because Codex rollouts do not currently expose exact AIC/$ cost.
    """
    source = source if source in SOURCES else "copilot"
    if source == "copilot":
        return {"days": daily_aic(), "metric": "aic", "unit": "AIC", "cost": True}
    if source == "codex":
        return {"days": daily_codex_tokens(), "metric": "input_tokens", "unit": "input tokens", "cost": False}
    days = daily_copilot_tokens()
    for d, v in daily_codex_tokens().items():
        days[d] = days.get(d, 0.0) + v
    return {"days": days, "metric": "input_tokens", "unit": "input tokens", "cost": False}


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


# ---------- Codex local session support ----------

def _parse_iso_ms(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def _short_json(value, n=4000) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return _clip(value, n)
    try:
        return _clip(json.dumps(value, ensure_ascii=False), n)
    except Exception:
        return _clip(str(value), n)


def _candidate_codex_state_dbs() -> list[str]:
    """Possible Codex thread-index DB locations, newest layouts first.

    Recent Codex desktop builds write the live state DB under ~/.codex/sqlite while
    older installs kept it at ~/.codex/state_5.sqlite. Some machines can have both;
    the root DB may be stale but non-empty, so callers must pick the freshest valid
    index instead of using the first file that exists.
    """
    bases = [CODEX_BASE]
    if os.path.basename(os.path.normpath(CODEX_BASE)) == "sqlite":
        bases.append(os.path.dirname(os.path.normpath(CODEX_BASE)))
    out: list[str] = []
    for base in bases:
        for path in (os.path.join(base, "sqlite", "state_5.sqlite"),
                     os.path.join(base, "state_5.sqlite")):
            if path not in out:
                out.append(path)
    return out


def _codex_state_db() -> str:
    best_path = os.path.join(CODEX_BASE, "state_5.sqlite")
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
    paths = glob.glob(os.path.join(CODEX_BASE, "sessions", "**", "*.jsonl"), recursive=True)
    paths.extend(glob.glob(os.path.join(CODEX_BASE, "archived_sessions", "*.jsonl")))
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
        with open(DAILY_CODEX_CACHE_PATH) as f:
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
            tmp = DAILY_CODEX_CACHE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, DAILY_CODEX_CACHE_PATH)
        except OSError:
            pass
    return totals


# ---------- Query API ----------

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


def _query_sort_key(sort: str):
    return {
        "total_input": lambda s: -s.total_input,
        "recent": lambda s: -s.last_event_ts,
        "requests": lambda s: -s.n_requests,
        "duration": lambda s: -s.duration_ms,
        "uncached": lambda s: -(s.total_input - s.total_cached),
        # Codex has no exact AIC; in mixed views, keep it sortable by usage instead
        # of burying every Codex session under a null cost.
        "aic": lambda s: -(s.total_aic if s.cost_available else s.total_input),
    }.get(sort, lambda s: -s.total_input)


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
        return query_copilot_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    if source == "codex":
        return query_codex_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    sessions = query_copilot_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort)
    sessions.extend(query_codex_sessions(since_seconds, start_ts, end_ts, min_tokens, limit, sort))
    sessions.sort(key=_query_sort_key(sort))
    return sessions[:limit]


def split_public_sid(sid: str) -> tuple[Optional[str], str]:
    if ":" in sid:
        src, raw = sid.split(":", 1)
        if src in {"copilot", "codex"}:
            return src, raw
    return None, sid


def get_session(sid: str, source: str = "all") -> Optional[Session]:
    hinted_source, raw_sid = split_public_sid(sid)
    source = hinted_source or (source if source in {"copilot", "codex"} else "all")

    if source in {"all", "copilot"}:
        paths = discover_main_files(3650 * 86400)
        for fp in paths:
            if os.path.basename(os.path.dirname(fp)) == raw_sid:
                s = assemble_session(fp)
                if s:
                    link_search_parents([s])
                    absorb_search_children(s)
                    return s
        if source == "copilot":
            return None

    if source in {"all", "codex"}:
        entries, child_map = _load_codex_index()
        ent = entries.get(raw_sid)
        if ent:
            s = _assemble_codex_session(ent)
            if s:
                _absorb_codex_children(s, entries, child_map)
                return s
    return None


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


def public_sid(s: Session) -> str:
    """Stable public id for API/UI routing, namespaced by data source."""
    return s.sid if s.sid.startswith(f"{s.source}:") else f"{s.source}:{s.sid}"


def session_summary(s: Session) -> dict:
    """Lightweight dict for the card list (no per-turn details)."""
    main_calls, kids = build_series(s)

    def with_aic(c):
        return _aic_for_req(c, s.models_info) if s.cost_available else None

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
            "aic": _aic_for_req(c, s.models_info) if s.cost_available else None,
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
