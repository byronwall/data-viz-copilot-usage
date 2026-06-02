"""Flask web app for browsing VS Code Copilot chat token usage.

Run:
    uv run app.py              # defaults to port 5057
    uv run app.py --port 8000

Then open http://localhost:5057
"""
from __future__ import annotations
import argparse, os, time
from flask import Flask, jsonify, request, render_template, abort

import analyzer

app = Flask(__name__, static_folder="static", template_folder="templates")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/sessions")
def api_sessions():
    # Accept either explicit range (preferred) or legacy since_hours.
    start_ts = request.args.get("start_ts", type=float)
    end_ts = request.args.get("end_ts", type=float)
    since_hours = request.args.get("since_hours", type=float)
    if start_ts is None and end_ts is None and since_hours is None:
        since_hours = 24  # default
    min_tokens = int(request.args.get("min_tokens", 0) or 0)
    limit = int(request.args.get("limit", 50) or 50)
    sort = request.args.get("sort", "total_input")
    t0 = time.time()
    sessions = analyzer.query_sessions(
        since_seconds=since_hours * 3600 if since_hours is not None and start_ts is None and end_ts is None else None,
        start_ts=start_ts,
        end_ts=end_ts,
        min_tokens=min_tokens,
        limit=limit,
        sort=sort,
    )
    payload = [analyzer.session_summary(s) for s in sessions]
    def peak(s):
        if not s.get("main"):
            return 0
        m = max((c["cum"] for c in s["main"]), default=0)
        for k in s.get("kids", []):
            for c in k["calls"]:
                if c["cum_offset"] > m:
                    m = c["cum_offset"]
        return m
    max_tok = max((peak(s) for s in payload), default=0)
    # Resolve the effective window for the response so the client can show what was used
    if start_ts is None and end_ts is None:
        end_ts_eff = time.time()
        start_ts_eff = end_ts_eff - (since_hours or 24) * 3600
    else:
        start_ts_eff = start_ts if start_ts is not None else 0
        end_ts_eff = end_ts if end_ts is not None else time.time()
    return jsonify({
        "sessions": payload,
        "max_tok": max_tok,
        "took_ms": int((time.time() - t0) * 1000),
        "start_ts": start_ts_eff,
        "end_ts": end_ts_eff,
        "min_tokens": min_tokens,
        "limit": limit,
        "sort": sort,
    })


@app.route("/api/session/<sid>")
def api_session(sid):
    """Return detailed payload for one session. We scan recent main.jsonl files to find it."""
    # widest window since we don't know sid's age — 90 days
    paths = analyzer.discover_main_files(90 * 86400)
    for fp in paths:
        if os.path.basename(os.path.dirname(fp)) == sid:
            s = analyzer.assemble_session(fp)
            if s:
                analyzer.link_search_parents([s])
                return jsonify(analyzer.session_detail(s))
    abort(404)


@app.route("/api/stats")
def api_stats():
    """High-level rollup over the last N hours."""
    since_hours = float(request.args.get("since_hours", 24))
    sessions = analyzer.query_sessions(since_seconds=since_hours * 3600, limit=10000)
    total_in = sum(s.total_input for s in sessions)
    total_cached = sum(s.total_cached for s in sessions)
    total_out = sum(s.total_output for s in sessions)
    total_req = sum(s.n_requests for s in sessions)
    return jsonify({
        "since_hours": since_hours,
        "n_sessions": len(sessions),
        "total_requests": total_req,
        "total_input": total_in,
        "total_cached": total_cached,
        "total_output": total_out,
        "cached_pct": (100 * total_cached / total_in) if total_in else 0,
    })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5057)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    print(f"Serving Copilot usage viewer on http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
