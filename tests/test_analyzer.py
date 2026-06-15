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

    def test_codex_uses_fresh_sqlite_state_db_when_root_db_is_stale(self):
        old_thread = self.add_thread("old", first_user="old work", updated_at_ms=1780721421582)
        make_state_db(analyzer.CODEX_BASE, [old_thread])

        current_thread = self.add_thread("current", first_user="current work", updated_at_ms=1781491734479)
        make_state_db(os.path.join(analyzer.CODEX_BASE, "sqlite"), [current_thread])

        self.assertTrue(analyzer._codex_state_db().endswith(os.path.join("sqlite", "state_5.sqlite")))
        sessions = analyzer.query_codex_sessions(start_ts=0, limit=10, sort="recent")
        self.assertEqual([s.sid for s in sessions], ["current"])


if __name__ == "__main__":
    unittest.main()
