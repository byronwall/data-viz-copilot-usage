"""Claude Code / Claude Desktop session support.

Claude layout on disk (under CLAUDE_CONFIG_DIR / ~/.claude):
  projects/<encoded-cwd>/<sessionId>.jsonl  -- one transcript per session

Both the Claude Code CLI and the Claude Desktop app write transcripts to this same
projects/ tree (Desktop runs Claude Code under the hood). Desktop additionally keeps
small per-session metadata files (title, model, effort) keyed by `cliSessionId` under
its application-support dir; we use those only to enrich titles/effort when present.

Both surfaces write the same transcript format to <CLAUDE_BASE>/projects/<dir>/<sid>.jsonl.
Records are line-delimited JSON. The records we care about:
  {"type":"assistant","requestId":..,"message":{"model":..,"usage":{...},"content":[..]}}
  {"type":"user","message":{"content":<str | [text|tool_result blocks]>}}
  {"isCompactSummary":true,...} / {"subtype":"compact_boundary",...}  -> context compaction
One logical model request is split across several assistant lines (thinking / text /
tool_use) that all repeat the SAME cumulative usage, so we dedupe by requestId.
"""
from __future__ import annotations
import os, json, glob, re, time, copy
from typing import Optional

import analyzer
from .constants import COMPACT_NAMES
from .codex import _codex_file_signature
from .models import Session
from .pricing import _claude_req_aic
from .text import _short, _short_json, _result_text, _parse_iso_ms
from .window import resolve_window, _query_sort_key

# ---------- Cache ----------

_CLAUDE_SESSION_CACHE: dict[str, tuple[tuple, Optional[Session]]] = {}  # path -> (signature, Session)


def _claude_transcript_glob() -> list[str]:
    return sorted(glob.glob(os.path.join(analyzer.CLAUDE_BASE, "projects", "*", "*.jsonl")))


def _claude_desktop_meta() -> dict[str, dict]:
    """Map cliSessionId -> {title, effort, model} from Claude Desktop session metadata.

    Used only to enrich transcripts (titles, reasoning effort); transcripts remain the
    source of truth. Returns {} when Desktop is not installed.
    """
    base = analyzer.CLAUDE_DESKTOP_SESSIONS
    out: dict[str, dict] = {}
    if not os.path.isdir(base):
        return out
    for fp in glob.glob(os.path.join(base, "**", "local_*.json"), recursive=True):
        try:
            with open(fp) as f:
                o = json.load(f)
        except Exception:
            continue
        cli = o.get("cliSessionId")
        if not cli:
            continue
        out[cli] = {
            "title": o.get("title") or "",
            "effort": o.get("effort") or "",
            "model": o.get("model") or "",
        }
    return out


# Synthetic user turns Claude Code injects around slash commands and `!`-bash runs.
# They precede the real typed prompt (often 3+ of them), so the session label/title
# must skip them to land on the actual user input (the "4th message" problem).
_CMD_NOISE_PREFIXES = (
    "<local-command-caveat>", "<command-name>", "<command-message>", "<command-args>",
    "<local-command-stdout>", "<local-command-stderr>",
    "<command-stdout>", "<command-stderr>",
    "<bash-input>", "<bash-stdout>", "<bash-stderr>",
)


def _is_command_noise(text: str) -> bool:
    """True for the slash-command / local-command wrapper turns (not real user input)."""
    return text.lstrip().startswith(_CMD_NOISE_PREFIXES)


def _claude_content_text(content) -> str:
    """Flatten an assistant/user content value to plain text (text blocks only)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text") or "")
        return "\n".join(p for p in parts if p)
    return ""


def _claude_tool_result_text(block: dict) -> str:
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict):
                parts.append(b.get("text") or "" if b.get("type") == "text" else _short_json(b, 2000))
        return "\n".join(p for p in parts if p)
    return _short_json(c, 2000)


def _claude_request_tokens(usage: dict) -> tuple[int, int, int]:
    """Return (total_input, cached, output) from an Anthropic usage block.

    input_tokens is the fresh (uncached) prompt only, so total prompt =
    input_tokens + cache_read + cache_creation. `cached` is the cache-read subset, so
    the viewer's uncached = input - cached = input_tokens + cache_creation, matching the
    Copilot/Codex convention where `input` is the whole prompt and `cached` a part of it.
    """
    fresh = int(usage.get("input_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
    out = int(usage.get("output_tokens", 0) or 0)
    return fresh + cache_read + cache_creation, cache_read, out


def _parse_claude_stream(path: str, effort: str = "", model_hint: str = "?"):
    """Parse one Claude transcript file (main OR sub-agent — identical line format).

    Returns a dict with:
      main_events   - non-sidechain events (req/user/tool) in file order
      side_events   - isSidechain events (legacy inline sub-agents)
      t0            - earliest timestamp ms (or None)
      last_ts       - latest timestamp ms
      first_user    - first non-empty MAIN user message (truncated 240ch)
      model_counts  - {model_id: req-count} for non-compaction reqs
      cwd           - first cwd seen
      tool_use_map  - {tool_use_id: {name, args}}
      agent_spawns  - {agentId: {subagent_type, description}} resolved from Agent
                      tool_use calls + their tool_results' "agentId: <hex>" text
    """
    main_events: list[dict] = []
    side_events: list[dict] = []
    first_user = ""
    t0 = None
    last_ts = 0
    cwd = ""
    model_counts: dict[str, int] = {}
    seen_reqs: set[str] = set()
    tool_use_map: dict[str, dict] = {}  # tool_use_id -> {name, args}
    agent_calls: dict[str, dict] = {}   # Agent tool_use_id -> input dict
    agent_spawns: dict[str, dict] = {}  # agentId -> {subagent_type, description}
    current_model = model_hint or "?"

    with open(path) as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            ts = _parse_iso_ms(d.get("timestamp"))
            if ts:
                t0 = min(t0 or ts, ts)
                last_ts = max(last_ts, ts)
            if not cwd and d.get("cwd"):
                cwd = d.get("cwd")
            sink = side_events if d.get("isSidechain") else main_events
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}

            if d.get("isCompactSummary") is True or d.get("subtype") == "compact_boundary":
                sink.append({
                    "kind": "req", "ts": ts or last_ts, "input": 0, "cached": 0,
                    "cache_creation": 0, "output": 0,
                    "reasoning_output": 0, "debugName": "compacted", "ttft": 0,
                    "model": current_model or "?", "reasoning": effort,
                    "nano_aiu": None, "is_error": False, "error": "",
                })
                continue

            if d.get("type") == "assistant":
                content = msg.get("content")
                model = msg.get("model")
                if model:
                    current_model = model
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            tool_use_map[b.get("id")] = {
                                "name": b.get("name") or "?",
                                "args": _short_json(b.get("input"), 4000),
                            }
                            if b.get("name") == "Agent" and isinstance(b.get("input"), dict):
                                agent_calls[b.get("id")] = b.get("input")
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
                rid = d.get("requestId") or msg.get("id")
                if usage and rid and rid not in seen_reqs:
                    total_in, cache_read, out = _claude_request_tokens(usage)
                    if total_in or out:
                        seen_reqs.add(rid)
                        cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
                        mdl = model or current_model or "?"
                        model_counts[mdl] = model_counts.get(mdl, 0) + 1
                        sink.append({
                            "kind": "req", "ts": ts or last_ts,
                            "input": total_in, "cached": cache_read,
                            "cache_creation": cache_creation, "output": out,
                            "reasoning_output": 0, "debugName": "claude", "ttft": 0,
                            "model": mdl, "reasoning": effort, "nano_aiu": None,
                            "is_error": msg.get("stop_reason") == "error",
                            "error": "",
                        })
                continue

            if d.get("type") == "user":
                content = msg.get("content")
                if isinstance(content, str):
                    if content.strip():
                        sink.append({"kind": "user", "ts": ts or last_ts, "text": _short(content, 600)})
                        if sink is main_events and not first_user and not _is_command_noise(content):
                            first_user = content[:240]
                elif isinstance(content, list):
                    had_tool = False
                    for b in content:
                        if not isinstance(b, dict) or b.get("type") != "tool_result":
                            continue
                        had_tool = True
                        tuid = b.get("tool_use_id")
                        # Resolve Agent-spawn linkage: the tool_result for an Agent
                        # tool_use carries "agentId: <hex>" identifying the sub-agent file.
                        if tuid in agent_calls:
                            m = re.search(r"agentId: ([a-f0-9]+)", _short_json(b.get("content"), 4000))
                            if m:
                                inp = agent_calls[tuid]
                                agent_spawns[m.group(1)] = {
                                    "subagent_type": inp.get("subagent_type") or "",
                                    "description": inp.get("description") or "",
                                }
                        call = tool_use_map.get(tuid) or {}
                        sink.append({
                            "kind": "tool", "ts": ts or last_ts,
                            "name": call.get("name") or "tool",
                            "args": call.get("args") or "",
                            "result": _result_text(_claude_tool_result_text(b), 2000),
                            "dur": 0,
                            "status": "error" if b.get("is_error") else "ok",
                        })
                    if not had_tool:
                        txt = _claude_content_text(content)
                        if txt.strip():
                            sink.append({"kind": "user", "ts": ts or last_ts, "text": _short(txt, 600)})
                            if sink is main_events and not first_user and not _is_command_noise(txt):
                                first_user = txt[:240]
                continue

    return {
        "main_events": main_events, "side_events": side_events,
        "t0": t0, "last_ts": last_ts, "first_user": first_user,
        "model_counts": model_counts, "cwd": cwd,
        "tool_use_map": tool_use_map, "agent_spawns": agent_spawns,
    }


def _claude_session_signature(path: str) -> Optional[tuple]:
    """Cache signature for a Claude session: main-file mtime plus each sub-agent
    file's (name, mtime). Sub-agent files can change independently of the main file.
    """
    try:
        main_mtime = os.path.getmtime(path)
    except OSError:
        return None
    sub: list[tuple] = []
    sub_dir = os.path.join(os.path.splitext(path)[0], "subagents")
    try:
        for sp in glob.glob(os.path.join(sub_dir, "agent-*.jsonl")):
            try:
                sub.append((os.path.basename(sp), os.path.getmtime(sp)))
            except OSError:
                continue
    except OSError:
        pass
    return (main_mtime, tuple(sorted(sub)))


def _assemble_claude_session(path: str, desktop_meta: dict[str, dict] | None = None) -> Optional[Session]:
    sig = _claude_session_signature(path)
    if sig is None:
        return None
    cached = _CLAUDE_SESSION_CACHE.get(path)
    if cached and cached[0] == sig:
        return copy.deepcopy(cached[1]) if cached[1] else None
    mtime = sig[0]

    sid = os.path.basename(path)[:-6] if path.endswith(".jsonl") else os.path.basename(path)
    meta = (desktop_meta or {}).get(sid) or {}
    effort = meta.get("effort") or ""
    title = meta.get("title") or ""

    try:
        parsed = _parse_claude_stream(path, effort=effort, model_hint=meta.get("model") or "?")
    except OSError:
        _CLAUDE_SESSION_CACHE[path] = (sig, None)
        return None

    main_events = parsed["main_events"]
    side_events = parsed["side_events"]
    first_user = parsed["first_user"]
    t0 = parsed["t0"]
    last_ts = parsed["last_ts"]
    cwd = parsed["cwd"]
    model_counts = parsed["model_counts"]
    agent_spawns = parsed["agent_spawns"]
    current_model = max(model_counts.items(), key=lambda x: x[1])[0] if model_counts else (meta.get("model") or "?")

    reqs = [e for e in main_events if e["kind"] == "req"]
    side_reqs = [e for e in side_events if e["kind"] == "req"]

    children: list[dict] = []
    child_reqs: list[dict] = []
    # Modern Claude Code writes each Agent-tool sub-agent to its OWN transcript at
    # <main-without-.jsonl>/subagents/agent-<agentId>.jsonl. The directory itself
    # establishes parentage, so every agent-*.jsonl under it belongs to THIS session
    # (these files are not picked up by the top-level session glob, so no double count).
    # The main transcript's Agent-spawn map is used only to LABEL each child with its
    # subagent_type when available — it's not reliable for inclusion (some completed
    # agents' tool results don't carry the agentId back-reference).
    new_children: list[dict] = []  # (first_req_ts, child_dict)
    sub_dir = os.path.join(os.path.splitext(path)[0], "subagents")
    for sp in sorted(glob.glob(os.path.join(sub_dir, "agent-*.jsonl"))):
        m = re.match(r"agent-([a-f0-9]+)\.jsonl$", os.path.basename(sp))
        agent_id = m.group(1) if m else os.path.basename(sp)
        spawn = agent_spawns.get(agent_id) or {}
        try:
            cp = _parse_claude_stream(sp, effort=effort)
        except OSError:
            continue
        cevents = sorted(cp["main_events"] + cp["side_events"], key=lambda e: e["ts"])
        creqs = [e for e in cevents if e["kind"] == "req"]
        if not creqs:
            continue
        subagent_type = spawn.get("subagent_type") or ""
        slug = ""  # slug lives on each line; read it cheaply if needed
        if subagent_type:
            label = f"sub-agent {subagent_type}"
        else:
            try:
                with open(sp) as sf:
                    first_line = json.loads(sf.readline())
                slug = first_line.get("slug") or ""
            except Exception:
                slug = ""
            label = f"sub-agent {slug}" if slug else f"agent {agent_id[:8]}"
        new_children.append((creqs[0]["ts"], {"events": cevents, "label": label}))
        child_reqs.extend(creqs)
        if cp["last_ts"]:
            last_ts = max(last_ts, cp["last_ts"])

    new_children.sort(key=lambda x: x[0])
    children.extend(c for _, c in new_children)

    # Backward-compat: legacy inline sidechains in the MAIN file.
    if side_reqs:
        children.append({"events": side_events, "label": "sub-agents"})
        child_reqs.extend(side_reqs)

    # Keep a started-but-not-yet-answered session visible (e.g. the one you're in
    # right now): as long as it has a real start timestamp it gets a row, even with
    # zero billable requests. Only drop truly empty / metadata-only files (no ts).
    if t0 is None:
        _CLAUDE_SESSION_CACHE[path] = (sig, None)
        return None

    main = {"events": main_events, "t0": t0, "first_user": first_user, "path": path}

    all_reqs = reqs + child_reqs
    total_aic = sum(_claude_req_aic(r) for r in all_reqs)
    total_input = sum(r["input"] for r in all_reqs)
    total_cached = sum(r["cached"] for r in all_reqs)
    total_output = sum(r["output"] for r in all_reqs)
    n_compact = sum(1 for r in all_reqs if r["debugName"] in COMPACT_NAMES)
    top_model = max(model_counts.items(), key=lambda x: x[1])[0] if model_counts else (current_model or "?")
    last_ts = last_ts or t0
    if not first_user:
        first_user = title or sid

    sess = Session(
        sid=sid,
        workspace=cwd or "Claude",
        mtime=mtime,
        last_event_ts=last_ts,
        main=main,
        source="claude",
        source_label="Claude",
        path=path,
        cost_available=True,
        children=children,
        total_input=total_input,
        total_cached=total_cached,
        total_output=total_output,
        n_requests=len(all_reqs),
        n_compactions=n_compact,
        duration_ms=max(0, last_ts - t0),
        top_model=top_model,
        first_user=first_user,
        total_aic=total_aic,
        models_info={},
    )
    _CLAUDE_SESSION_CACHE[path] = (sig, sess)
    return copy.deepcopy(sess)


def query_claude_sessions(
    since_seconds: float | None = None,
    start_ts: float | None = None,
    end_ts: float | None = None,
    min_tokens: int = 0,
    limit: int = 50,
    sort: str = "total_input",
) -> list[Session]:
    win_start, win_end = resolve_window(since_seconds, start_ts, end_ts)
    desktop_meta = _claude_desktop_meta()
    sessions: list[Session] = []
    for path in _claude_transcript_glob():
        try:
            if os.path.getmtime(path) < win_start or os.path.getsize(path) < 200:
                continue
        except OSError:
            continue
        s = _assemble_claude_session(path, desktop_meta)
        if not s:
            continue
        started = (s.main["t0"] / 1000) if s.main.get("t0") else s.mtime
        ended = max(s.last_event_ts / 1000, started)
        if started > win_end or ended < win_start:
            continue
        if s.total_input < min_tokens:
            continue
        sessions.append(s)
    sessions.sort(key=_query_sort_key(sort))
    return sessions[:limit]


def _daily_claude_for_file(path: str) -> dict[str, dict[str, float]]:
    """Lightweight daily input-token and USD totals for one transcript; deduped by requestId."""
    days: dict[str, dict[str, float]] = {"input_tokens": {}, "usd": {}}
    seen: set[str] = set()
    try:
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") if isinstance(d.get("message"), dict) else {}
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
                if not usage:
                    continue
                rid = d.get("requestId") or msg.get("id")
                if not rid or rid in seen:
                    continue
                total_in, cache_read, out = _claude_request_tokens(usage)
                if not total_in:
                    continue
                ts = _parse_iso_ms(d.get("timestamp"))
                if not ts:
                    continue
                seen.add(rid)
                day = time.strftime("%Y-%m-%d", time.localtime(ts / 1000))
                days["input_tokens"][day] = days["input_tokens"].get(day, 0.0) + total_in
                aic = _claude_req_aic({
                    "model": msg.get("model"),
                    "input": total_in,
                    "cached": cache_read,
                    "cache_creation": int(usage.get("cache_creation_input_tokens", 0) or 0),
                    "output": out,
                })
                if aic:
                    days["usd"][day] = days["usd"].get(day, 0.0) + (aic / 100)
    except OSError:
        pass
    return days


def _daily_claude_metric(metric: str) -> dict[str, float]:
    """Total selected metric per local calendar day across Claude transcripts (disk-cached)."""
    try:
        with open(analyzer.DAILY_CLAUDE_CACHE_PATH) as f:
            cache = json.load(f)
        if cache.get("version") != 2:
            raise ValueError
    except Exception:
        cache = {"version": 2, "files": {}}
    files_cache = cache["files"]
    seen = set()
    dirty = False
    totals: dict[str, float] = {}
    # Include Agent-tool sub-agent transcripts (siblings under <sid>/subagents/),
    # which _claude_transcript_glob() does not pick up.
    sub_glob = sorted(glob.glob(os.path.join(analyzer.CLAUDE_BASE, "projects", "*", "*", "subagents", "agent-*.jsonl")))
    for path in _claude_transcript_glob() + sub_glob:
        seen.add(path)
        sig = _codex_file_signature(path)
        if not sig:
            continue
        cached = files_cache.get(path)
        if not cached or cached.get("sig") != sig:
            metrics = _daily_claude_for_file(path)
            files_cache[path] = {"sig": sig, "metrics": metrics}
            dirty = True
        else:
            metrics = cached.get("metrics", {})
        days = metrics.get(metric, {}) if isinstance(metrics, dict) else {}
        for d, v in days.items():
            totals[d] = totals.get(d, 0.0) + v
    for path in [p for p in files_cache if p not in seen]:
        del files_cache[path]
        dirty = True
    if dirty:
        try:
            tmp = analyzer.DAILY_CLAUDE_CACHE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, analyzer.DAILY_CLAUDE_CACHE_PATH)
        except OSError:
            pass
    return totals


def daily_claude_tokens() -> dict[str, float]:
    return _daily_claude_metric("input_tokens")


def daily_claude_usd() -> dict[str, float]:
    return _daily_claude_metric("usd")
