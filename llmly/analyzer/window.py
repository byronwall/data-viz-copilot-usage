"""Time-window normalization and the shared session sort key."""
from __future__ import annotations
import time


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
