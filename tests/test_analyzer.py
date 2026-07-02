import json
import os
import sqlite3
import tempfile
import unittest

import analyzer
import app


def rec(ts, typ, payload):
    return {"timestamp": f"2026-06-14T22:{ts:02d}:00.000Z", "type": typ, "payload": payload}


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


def rollout_rows(thread_id, first_user="do thing", source="vscode", model="gpt-5.5", effort="medium"):
    return [
        rec(0, "session_meta", {"id": thread_id, "cwd": "/tmp/project", "source": source, "model_provider": "openai"}),
        rec(1, "event_msg", {"type": "task_started", "turn_id": f"{thread_id}-turn", "started_at": 1781474400}),
        rec(2, "event_msg", {"type": "user_message", "message": first_user}),
        rec(3, "turn_context", {"turn_id": f"{thread_id}-turn", "model": model, "effort": effort}),
        rec(4, "response_item", {"type": "reasoning", "summary": []}),
        rec(5, "response_item", {"type": "function_call", "name": "exec_command", "call_id": "call_1", "arguments": {"cmd": "ls"}}),
        rec(6, "response_item", {"type": "function_call_output", "call_id": "call_1", "output": "listed"}),
        rec(7, "event_msg", {"type": "token_count", "info": {"last_token_usage": {
            "input_tokens": 100, "cached_input_tokens": 20, "output_tokens": 10,
            "reasoning_output_tokens": 3, "total_tokens": 110}}}),
        rec(8, "response_item", {"type": "reasoning", "summary": []}),
        rec(9, "event_msg", {"type": "token_count", "info": {"last_token_usage": {
            "input_tokens": 150, "cached_input_tokens": 100, "output_tokens": 20,
            "reasoning_output_tokens": 4, "total_tokens": 170}}}),
    ]


def make_state_db(codex_home, threads, edges=()):
    db = os.path.join(codex_home, "state_5.sqlite")
    os.makedirs(codex_home, exist_ok=True)
    con = sqlite3.connect(db)
    try:
        con.execute("""
            create table threads (
                id text primary key, rollout_path text not null, created_at_ms integer not null,
                updated_at_ms integer not null, source text not null, model_provider text not null,
                cwd text not null, title text not null, sandbox_policy text not null,
                approval_mode text not null, tokens_used integer not null default 0,
                has_user_event integer not null default 1, archived integer not null default 0,
                archived_at integer, git_sha text, git_branch text, git_origin_url text,
                cli_version text not null default '', first_user_message text not null default '',
                agent_nickname text, agent_role text, memory_mode text not null default 'enabled',
                model text, reasoning_effort text, agent_path text, created_at_ms_extra integer,
                updated_at_ms_extra integer, thread_source text, preview text not null default ''
            )
        """)
        con.execute("create table thread_spawn_edges (parent_thread_id text not null, child_thread_id text primary key, status text not null)")
        for t in threads:
            con.execute("""
                insert into threads (
                    id, rollout_path, created_at_ms, updated_at_ms, source, model_provider, cwd, title,
                    sandbox_policy, approval_mode, tokens_used, first_user_message, agent_nickname,
                    agent_role, model, reasoning_effort, thread_source
                ) values (?, ?, ?, ?, ?, 'openai', '/tmp/project', ?, 'workspace-write', 'on-request', ?, ?, ?, ?, ?, ?, ?)
            """, (
                t["id"], t["path"], t.get("created_at_ms", 1781474400000),
                t.get("updated_at_ms", 1781475000000), t.get("source", "vscode"),
                t.get("title", t.get("first_user", "")), t.get("tokens", 0), t.get("first_user", ""),
                t.get("agent_nickname"), t.get("agent_role"), t.get("model", "gpt-5.5"),
                t.get("effort", "medium"), t.get("thread_source"),
            ))
        for parent, child in edges:
            con.execute("insert into thread_spawn_edges values (?, ?, 'closed')", (parent, child))
        con.commit()
    finally:
        con.close()


class AnalyzerCodexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_codex = analyzer.CODEX_BASE
        self.old_base = analyzer.BASE
        self.old_cache = analyzer.DAILY_CODEX_CACHE_PATH
        analyzer.CODEX_BASE = os.path.join(self.tmp.name, "codex")
        analyzer.BASE = os.path.join(self.tmp.name, "copilot")
        analyzer.DAILY_CODEX_CACHE_PATH = os.path.join(self.tmp.name, "daily_codex.json")
        analyzer._CODEX_SESSION_CACHE.clear()
        self.addCleanup(self.restore_globals)
        os.makedirs(analyzer.CODEX_BASE, exist_ok=True)

    def restore_globals(self):
        analyzer.CODEX_BASE = self.old_codex
        analyzer.BASE = self.old_base
        analyzer.DAILY_CODEX_CACHE_PATH = self.old_cache
        analyzer._CODEX_SESSION_CACHE.clear()

    def add_thread(self, thread_id, rows=None, **meta):
        path = os.path.join(analyzer.CODEX_BASE, "sessions", "2026", "06", "14", f"rollout-{thread_id}.jsonl")
        write_jsonl(path, rows or rollout_rows(thread_id, meta.get("first_user", "do thing"), meta.get("source", "vscode")))
        return {"id": thread_id, "path": path, "first_user": meta.get("first_user", "do thing"), **meta}

    def test_codex_token_counts_and_tool_output_attach_to_next_request(self):
        thread = self.add_thread("parent")
        make_state_db(analyzer.CODEX_BASE, [thread])

        session = analyzer.query_codex_sessions(start_ts=0, limit=10)[0]
        detail = analyzer.session_detail(session)

        self.assertEqual(detail["sid"], "codex:parent")
        self.assertEqual(detail["total_input"], 250)
        self.assertEqual(detail["total_cached"], 120)
        self.assertEqual(detail["main"][0]["tools"][0]["n"], "user_message")
        self.assertEqual([t["n"] for t in detail["main"][1]["tools"]], ["exec_command"])
        self.assertEqual(detail["main"][1]["reasoning_output"], 4)
        self.assertIsNone(detail["total_aic"])

    def test_codex_query_folds_spawned_children_and_excludes_guardian(self):
        parent = self.add_thread("parent", first_user="parent work")
        child_source = json.dumps({"subagent": {"thread_spawn": {
            "parent_thread_id": "parent", "agent_nickname": "Curie", "agent_role": "worker"}}})
        child = self.add_thread("child", first_user="child work", source=child_source, thread_source="subagent", agent_nickname="Curie", agent_role="worker")
        guardian_source = json.dumps({"subagent": {"other": "guardian"}})
        guardian = self.add_thread("guardian", first_user="guard", source=guardian_source, model="codex-auto-review", thread_source="subagent")
        make_state_db(analyzer.CODEX_BASE, [parent, child, guardian], [("parent", "child")])

        sessions = analyzer.query_codex_sessions(start_ts=0, limit=10)
        self.assertEqual([s.sid for s in sessions], ["parent"])
        summary = analyzer.session_summary(sessions[0])
        self.assertEqual(summary["total_input"], 500)
        self.assertEqual(len(summary["kids"]), 1)
        self.assertIn("Curie", summary["kids"][0]["label"])

    def test_daily_usage_uses_codex_input_tokens(self):
        thread = self.add_thread("parent")
        make_state_db(analyzer.CODEX_BASE, [thread])

        payload = analyzer.daily_usage("codex")
        self.assertEqual(payload["metric"], "input_tokens")
        self.assertFalse(payload["cost"])
        self.assertEqual(sum(payload["days"].values()), 250)

    def test_daily_usage_uses_codex_api_usd_when_selected(self):
        thread = self.add_thread("parent")
        make_state_db(analyzer.CODEX_BASE, [thread])

        payload = analyzer.daily_usage("codex", "usd")
        self.assertEqual(payload["metric"], "usd")
        self.assertEqual(payload["unit"], "$")
        self.assertFalse(payload["cost"])
        self.assertAlmostEqual(sum(payload["days"].values()), 0.00161)

    def test_flask_source_filter_and_detail_endpoint(self):
        thread = self.add_thread("parent")
        make_state_db(analyzer.CODEX_BASE, [thread])
        client = app.app.test_client()

        list_resp = client.get("/api/sessions?source=codex&start_ts=0&limit=5")
        self.assertEqual(list_resp.status_code, 200)
        sid = list_resp.json["sessions"][0]["sid"]
        self.assertEqual(sid, "codex:parent")

        detail_resp = client.get(f"/api/session/{sid}")
        self.assertEqual(detail_resp.status_code, 200)
        self.assertEqual(detail_resp.json["source"], "codex")

        daily_resp = client.get("/api/daily_usage?source=codex&unit=usd")
        self.assertEqual(daily_resp.status_code, 200)
        self.assertEqual(daily_resp.json["metric"], "usd")
        self.assertAlmostEqual(sum(daily_resp.json["days"].values()), 0.00161)

    def test_codex_uses_fresh_sqlite_state_db_when_root_db_is_stale(self):
        old_thread = self.add_thread("old", first_user="old work", updated_at_ms=1780721421582)
        make_state_db(analyzer.CODEX_BASE, [old_thread])

        current_thread = self.add_thread("current", first_user="current work", updated_at_ms=1781491734479)
        make_state_db(os.path.join(analyzer.CODEX_BASE, "sqlite"), [current_thread])

        self.assertTrue(analyzer._codex_state_db().endswith(os.path.join("sqlite", "state_5.sqlite")))
        sessions = analyzer.query_codex_sessions(start_ts=0, limit=10, sort="recent")
        self.assertEqual([s.sid for s in sessions], ["current"])


def crec(minute, **kw):
    base = {"timestamp": f"2026-06-14T22:{minute:02d}:00.000Z", "isSidechain": False}
    base.update(kw)
    return base


def claude_rows(first_user="do the thing"):
    """A two-request transcript. req1 is split across two assistant lines sharing a
    requestId (must dedupe), emits a Read tool_use whose output feeds req2."""
    usage1 = {"input_tokens": 100, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5, "output_tokens": 10}
    usage2 = {"input_tokens": 200, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0, "output_tokens": 20}
    return [
        crec(0, type="user", cwd="/tmp/project", message={"role": "user", "content": first_user}),
        crec(1, type="assistant", requestId="req1", cwd="/tmp/project",
             message={"model": "claude-opus-4-8", "content": [{"type": "thinking", "thinking": "hmm"}], "usage": usage1}),
        crec(1, type="assistant", requestId="req1", cwd="/tmp/project",
             message={"model": "claude-opus-4-8", "content": [{"type": "tool_use", "id": "tu1", "name": "Read", "input": {"file_path": "/a"}}], "usage": usage1}),
        crec(2, type="user", message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "file body"}]}),
        crec(3, type="assistant", requestId="req2",
             message={"model": "claude-opus-4-8", "content": [{"type": "text", "text": "done"}], "usage": usage2}),
    ]


class AnalyzerClaudeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.olds = (analyzer.CLAUDE_BASE, analyzer.CLAUDE_DESKTOP_SESSIONS, analyzer.DAILY_CLAUDE_CACHE_PATH)
        analyzer.CLAUDE_BASE = os.path.join(self.tmp.name, "claude")
        analyzer.CLAUDE_DESKTOP_SESSIONS = os.path.join(self.tmp.name, "desktop")
        analyzer.DAILY_CLAUDE_CACHE_PATH = os.path.join(self.tmp.name, "daily_claude.json")
        analyzer._CLAUDE_SESSION_CACHE.clear()
        self.addCleanup(self.restore_globals)

    def restore_globals(self):
        analyzer.CLAUDE_BASE, analyzer.CLAUDE_DESKTOP_SESSIONS, analyzer.DAILY_CLAUDE_CACHE_PATH = self.olds
        analyzer._CLAUDE_SESSION_CACHE.clear()

    def add_session(self, sid, rows=None, project="proj", first_user="do the thing"):
        path = os.path.join(analyzer.CLAUDE_BASE, "projects", project, f"{sid}.jsonl")
        write_jsonl(path, rows or claude_rows(first_user))
        return path

    def add_desktop_meta(self, cli_session_id, title="", effort="", model=""):
        path = os.path.join(analyzer.CLAUDE_DESKTOP_SESSIONS, "d1", "a1", f"local_{cli_session_id}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump({"cliSessionId": cli_session_id, "title": title, "effort": effort, "model": model}, f)

    def test_token_dedupe_and_tool_attaches_to_next_request(self):
        self.add_session("sess1")
        session = analyzer.query_claude_sessions(start_ts=0, limit=10)[0]
        detail = analyzer.session_detail(session)

        self.assertEqual(detail["sid"], "claude:sess1")
        # total prompt = input + cache_read + cache_creation, deduped by requestId
        self.assertEqual(detail["total_input"], 425)
        self.assertEqual(detail["total_cached"], 120)
        self.assertEqual(detail["total_output"], 30)
        self.assertEqual(detail["n_requests"], 2)
        self.assertEqual(detail["top_model"], "claude-opus-4-8")
        self.assertEqual(detail["main"][0]["tools"][0]["n"], "user_message")
        self.assertEqual([t["n"] for t in detail["main"][1]["tools"]], ["Read"])
        # Claude cost is estimated from per-tier Anthropic token pricing (stored as
        # AIC credits, 100 AIC = $1). Opus 4.x: $5/$25/$6.25/$0.50 per 1M
        # input/output/cache-write/cache-read.
        self.assertTrue(detail["cost_available"])
        # req1: 100 fresh*5e-4 + 20 read*5e-5 + 5 write*6.25e-4 + 10 out*2.5e-3 = 0.079125
        # req2: 200 fresh*5e-4 + 100 read*5e-5 + 20 out*2.5e-3            = 0.155
        self.assertAlmostEqual(detail["total_aic"], 0.234125, places=6)

    def test_daily_usage_uses_claude_input_tokens(self):
        self.add_session("sess1")
        payload = analyzer.daily_usage("claude")
        self.assertEqual(payload["metric"], "input_tokens")
        self.assertFalse(payload["cost"])
        self.assertEqual(sum(payload["days"].values()), 425)

    def test_daily_usage_uses_claude_usd_when_selected(self):
        self.add_session("sess1")
        payload = analyzer.daily_usage("claude", "usd")
        self.assertEqual(payload["metric"], "usd")
        self.assertEqual(payload["unit"], "$")
        self.assertFalse(payload["cost"])
        self.assertAlmostEqual(sum(payload["days"].values()), 0.00234125)

    def test_sidechain_requests_fold_into_child_group(self):
        rows = claude_rows()
        rows.append(crec(4, type="assistant", requestId="sub1", isSidechain=True,
                         message={"model": "claude-opus-4-8", "content": [{"type": "text", "text": "sub"}],
                                  "usage": {"input_tokens": 50, "output_tokens": 5}}))
        self.add_session("sess1", rows=rows)
        summary = analyzer.session_summary(analyzer.query_claude_sessions(start_ts=0, limit=10)[0])
        self.assertEqual(summary["total_input"], 475)  # 425 main + 50 sidechain
        self.assertEqual(len(summary["kids"]), 1)
        self.assertIn("sub-agent", summary["kids"][0]["label"])

    def test_subagent_transcript_loads_as_child_with_cost(self):
        # Modern Claude Code writes each Agent-tool sub-agent to its own transcript at
        # <sid>/subagents/agent-<id>.jsonl. The parent's Agent tool_result carries the
        # agentId back-reference used to label the child with its subagent_type.
        agent_id = "abc123def456"
        rows = claude_rows()
        rows.append(crec(4, type="assistant", requestId="req3",
                         message={"model": "claude-opus-4-8", "usage": {"input_tokens": 10, "output_tokens": 2},
                                  "content": [{"type": "tool_use", "id": "ag1", "name": "Agent",
                                               "input": {"subagent_type": "Explore", "description": "look", "prompt": "p"}}]}))
        rows.append(crec(5, type="user", message={"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "ag1",
             "content": f"found it\nagentId: {agent_id} (use SendMessage ...)"}]}))
        path = self.add_session("sess1", rows=rows)

        sub_dir = os.path.join(os.path.splitext(path)[0], "subagents")
        # Sonnet sub-agent: $3/$15/$3.75/$0.30 per 1M. 60 fresh*3e-4 + 10 out*1.5e-3 = 0.033 AIC
        write_jsonl(os.path.join(sub_dir, f"agent-{agent_id}.jsonl"), [
            crec(4, type="user", agentId=agent_id, isSidechain=True,
                 message={"role": "user", "content": "go"}),
            crec(5, type="assistant", requestId="sreq1", agentId=agent_id, isSidechain=True,
                 message={"model": "claude-sonnet-4-6", "usage": {"input_tokens": 60, "output_tokens": 10},
                          "content": [{"type": "text", "text": "done"}]}),
        ])

        detail = analyzer.session_detail(analyzer.query_claude_sessions(start_ts=0, limit=10)[0])
        self.assertEqual(len(detail["kids"]), 1)
        self.assertEqual(detail["kids"][0]["label"], "sub-agent Explore")
        self.assertEqual(detail["kids"][0]["top_model"], "claude-sonnet-4-6")
        # 425 main + (parent Agent req 10) + 60 sub = 495
        self.assertEqual(detail["total_input"], 495)
        # sub-agent priced at Sonnet tier; per-call aic populated
        self.assertAlmostEqual(detail["kids"][0]["calls"][0]["aic"], 0.033, places=6)

    def test_compaction_record_counts_as_compaction(self):
        rows = claude_rows()
        rows.append(crec(4, type="system", subtype="compact_boundary", message={}))
        self.add_session("sess1", rows=rows)
        session = analyzer.query_claude_sessions(start_ts=0, limit=10)[0]
        self.assertEqual(session.n_compactions, 1)

    def test_desktop_metadata_enriches_reasoning_effort(self):
        self.add_session("sess1")
        self.add_desktop_meta("sess1", title="Nice Title", effort="high")
        detail = analyzer.session_detail(analyzer.query_claude_sessions(start_ts=0, limit=10)[0])
        self.assertEqual(detail["main"][0]["reasoning"], "high")

    def test_flask_source_filter_and_detail_endpoint(self):
        self.add_session("sess1")
        client = app.app.test_client()

        list_resp = client.get("/api/sessions?source=claude&start_ts=0&limit=5")
        self.assertEqual(list_resp.status_code, 200)
        sid = list_resp.json["sessions"][0]["sid"]
        self.assertEqual(sid, "claude:sess1")

        detail_resp = client.get(f"/api/session/{sid}")
        self.assertEqual(detail_resp.status_code, 200)
        self.assertEqual(detail_resp.json["source"], "claude")


if __name__ == "__main__":
    unittest.main()
