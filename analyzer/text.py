"""Source-agnostic text/JSON normalization helpers shared by every backend.

Truncation, tool-result flattening, ISO timestamp parsing, and the reasoning-level
rollup all live here so the per-source modules can stay focused on their log formats.
"""
from __future__ import annotations
import json, re
from datetime import datetime

from .constants import _REASONING_RANK


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
