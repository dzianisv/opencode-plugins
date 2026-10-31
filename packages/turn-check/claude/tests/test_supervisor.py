"""Tests for the supervisor Claude Code hooks. Run: python3 -m unittest discover -s claude/tests"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

CLAUDE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CLAUDE))

import audit  # noqa: E402
import core  # noqa: E402
import prompt  # noqa: E402
import session_end  # noqa: E402
import state  # noqa: E402
import stop  # noqa: E402

FAKE_OPENCODE = """#!__PYTHON__
import json, os, subprocess, sys, time
args = sys.argv[1:]
mode = os.environ.get("FAKE_MODE", "reply")
log = os.environ.get("FAKE_LOG")
store = os.environ["FAKE_SESSIONS"]


def load():
    with open(store) as fh:
        return json.load(fh)


def save(sessions):
    with open(store, "w") as fh:
        json.dump(sessions, fh)


def record(extra):
    if log:
        with open(log, "a") as fh:
            fh.write(json.dumps({"argv": args, **extra}) + "\\n")


if args[:1] == ["session"]:
    record({"cwd": os.getcwd()})
    delete_mode = os.environ.get("FAKE_DELETE_MODE")
    if args[1] == "list":
        print(json.dumps(load()))
    elif args[1] == "delete":
        if delete_mode == "hang":
            time.sleep(60)
        if delete_mode == "fail":
            sys.exit(1)
        save([s for s in load() if s["id"] != args[2]])
    sys.exit(0)

record({
    "stdin": sys.stdin.read(),
    "config": os.environ.get("OPENCODE_CONFIG_CONTENT"),
    "enabled": os.environ.get("SUPERVISOR_ENABLED"),
    "child": os.environ.get("SUPERVISOR_CHILD"),
    "dir_exists": os.path.isdir(args[args.index("--dir") + 1]),
})
sid = "ses_fake_%d" % time.time_ns()
save(load() + [{
    "id": sid,
    "title": args[args.index("--title") + 1] if "--title" in args else "auto generated title",
    "created": int(time.time() * 1000),
    "directory": os.path.realpath(args[args.index("--dir") + 1]),
}])
ids = {} if os.environ.get("FAKE_NO_SESSION_ID") else {"sessionID": sid}
if mode == "hang":
    child = subprocess.Popen(["sleep", "60"])
    with open(os.environ["FAKE_PIDS"], "w") as fh:
        fh.write(str(child.pid))
    time.sleep(60)
elif mode == "garbage":
    print("this is not json at all " * 30)
elif mode == "error":
    print(json.dumps({"type": "error", **ids, "error": {"name": "APIError", "data": {"message": "boom"}}}))
else:
    reply = os.environ.get("FAKE_REPLY", "")
    print(json.dumps({"type": "step_start", **ids, "part": {"type": "step-start"}}))
    print(json.dumps({"type": "text", **ids, "part": {"type": "text", "text": reply}}))
    print(json.dumps({"type": "step_finish", **ids, "part": {"type": "step-finish", "reason": "stop"}}))
"""

PASS_REPLY = '{"verdict":"PASS","violations":[]}'
FAIL_REPLY = '{"verdict":"FAIL","violations":[{"rule":"Max 6 lines","evidence":"#1 12 lines","fix":"shorten"},{"rule":"No emoji","evidence":"#1 x","fix":"remove"}]}'


def user(text, uuid="u1", **extra):
    """A transcript entry for a user message."""
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}, **extra}


def assistant(blocks, uuid="a1", api_id=None):
    """A transcript entry for one assistant content block list."""
    return {"type": "assistant", "uuid": uuid, "message": {"role": "assistant", "id": api_id or uuid, "content": blocks}}


def text(value):
    """A text content block."""
    return {"type": "text", "text": value}


def tool_use(tool_id, name, tool_input):
    """A tool_use content block."""
    return {"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}


def tool_result(uuid, tool_id, content):
    """A user entry that carries a tool result."""
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": content}]}}


def write_transcript(path, entries):
    """Write entries as JSONL."""
    Path(path).write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")


def msg(role, *parts):
    """A built message for the render tests."""
    return {"role": role, "id": "x", "parts": list(parts)}


def t(value):
    """A text part."""
    return {"type": "text", "text": value}


def tl(name, tool_input, output=""):
    """A tool part."""
    return {"type": "tool", "tool": name, "input": tool_input, "output": output}


class RenderTest(unittest.TestCase):
    def test_renders_user_text_assistant_text_and_tool_lines(self):
        entries = [
            user("fix the bug"),
            assistant([text("on it"), tool_use("t1", "Bash", {"command": "go test ./..."})], "a1"),
            tool_result("r1", "t1", "ok pkg 0.1s"),
            assistant([text("done")], "a2"),
        ]
        out = core.render_transcript(core.build_messages(entries), 10000)
        self.assertIn("[#0 USER]\nfix the bug", out)
        self.assertIn("[#1 ASSISTANT]\non it\n  tool Bash: go test ./... -> ok pkg 0.1s", out)
        self.assertIn("[#2 ASSISTANT]\ndone", out)

    def test_assistant_blocks_with_one_api_id_are_one_message(self):
        entries = [
            user("hi"),
            assistant([text("part one")], "a1", api_id="m1"),
            assistant([tool_use("t1", "Read", {"file_path": "/a/b.go"})], "a2", api_id="m1"),
        ]
        msgs = core.build_messages(entries)
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[1]["id"], "a2")
        self.assertIn("tool Read: /a/b.go", core.render_transcript(msgs, 1000))

    def test_skips_tool_results_meta_reminders_commands_and_sidechains(self):
        entries = [
            user("real ask", "u1"),
            user("meta text", "u2", isMeta=True),
            user("<system-reminder>x</system-reminder>", "u3"),
            user("<command-name>/clear</command-name>", "u4"),
            user("<local-command-stdout>ok</local-command-stdout>", "u5"),
            user("Caveat: generated by tools", "u6"),
            user("sidechain ask", "u7", isSidechain=True),
            user("summary of old chat", "u8", isCompactSummary=True),
            tool_result("r1", "unknown", "result"),
        ]
        out = core.render_transcript(core.build_messages(entries), 10000)
        self.assertEqual(out, "[#0 USER]\nreal ask")

    def test_user_blocks_keep_real_text_and_drop_reminder_blocks(self):
        entry = user([text("<system-reminder>ctx</system-reminder>"), text("do the thing")])
        out = core.render_transcript(core.build_messages([entry]), 1000)
        self.assertEqual(out, "[#0 USER]\ndo the thing")

    def test_tool_line_picks_known_key_else_json_and_clips(self):
        self.assertEqual(core.summarise_tool(tl("Grep", {"pattern": "foo", "path": "."})), "  tool Grep: foo")
        self.assertEqual(core.summarise_tool(tl("X", {"n": 1})), '  tool X: {"n": 1}')
        line = core.summarise_tool(tl("Bash", {"command": "a " * 300}, "o" * 1000))
        self.assertLess(len(line), 520)
        self.assertEqual(core.summarise_tool(tl("Bash", {"command": "a\n\nb"}, "x\n y")), "  tool Bash: a b -> x y")

    def test_tool_result_blocks_as_list_are_joined(self):
        entries = [assistant([tool_use("t1", "Bash", {"command": "ls"})]), tool_result("r1", "t1", [text("one"), text("two")])]
        self.assertIn("-> one two", core.render_transcript(core.build_messages(entries), 1000))

    def test_over_limit_keeps_every_user_message_and_drops_oldest_agent_output(self):
        msgs = [msg("user", t("first ask")), msg("assistant", t("old " * 900)), msg("user", t("second ask")), msg("assistant", t("new " * 900))]
        out = core.render_transcript(msgs, 4000)
        self.assertIn("first ask", out)
        self.assertIn("second ask", out)
        self.assertIn("[1 earlier agent message(s) omitted]", out)
        self.assertIn("new new", out)
        self.assertNotIn("old old", out)

    def test_agent_output_is_one_contiguous_run_ending_at_the_newest(self):
        msgs = [msg("assistant", t("OLD")), msg("assistant", t("MIDDLE" * 400)), msg("assistant", t("NEW" * 200))]
        out = core.render_transcript(msgs, 2500)
        self.assertIn("NEWNEW", out)
        self.assertNotIn("MIDDLE", out)
        self.assertNotIn("OLD", out)
        self.assertIn("[2 earlier agent message(s) omitted]", out)

    def test_newest_agent_message_is_kept_even_when_it_alone_exceeds_the_limit(self):
        out = core.render_transcript([msg("user", t("ask")), msg("assistant", t("z" * 9000))], 3000)
        self.assertIn("zzz", out)

    def test_user_messages_are_capped_at_2000_chars(self):
        out = core.render_transcript([msg("user", t("u" * 5000))], 100000)
        self.assertLess(len(out), 2100)
        self.assertTrue(out.endswith("…"))

    def test_has_agent_work(self):
        self.assertFalse(core.has_agent_work([msg("user", t("hi"))]))
        self.assertTrue(core.has_agent_work([msg("user", t("hi")), msg("assistant", t("hello"))]))
        self.assertTrue(core.has_agent_work([msg("user", t("hi")), msg("assistant", tl("Bash", {}))]))
        self.assertFalse(core.has_agent_work([msg("assistant", t("old")), msg("user", t("new"))]))

    def test_last_entry_uuid_ignores_sidechains_and_other_types(self):
        entries = [user("a", "u1"), assistant([text("b")], "a1"), {"type": "last-prompt", "uuid": "zz"}, user("c", "u9", isSidechain=True)]
        self.assertEqual(core.last_entry_uuid(entries), "a1")


class VerdictTest(unittest.TestCase):
    def test_fenced_json_is_parsed_and_capped_at_five(self):
        violations = [{"rule": f"rule {i}", "evidence": "#1 q", "fix": "do x"} for i in range(8)]
        verdict = core.parse_verdict("```json\n" + json.dumps({"verdict": "FAIL", "violations": violations}) + "\n```")
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertEqual(len(verdict["violations"]), 5)

    def test_pass_with_no_violations(self):
        self.assertEqual(core.parse_verdict(PASS_REPLY), {"verdict": "PASS", "violations": []})

    def test_fail_without_usable_violations_is_rejected(self):
        self.assertIsNone(core.parse_verdict('{"verdict":"FAIL","violations":[{"rule":" "}]}'))
        self.assertIsNone(core.parse_verdict('{"verdict":"FAIL"}'))

    def test_pass_ignores_listed_violations(self):
        self.assertEqual(core.parse_verdict('{"verdict":"PASS","violations":[{"rule":"x"}]}'), {"verdict": "PASS", "violations": []})

    def test_garbage_and_unknown_verdicts_are_rejected(self):
        for reply in ("I think it is fine", '{"verdict":"MAYBE"}', "{not json}", "", "[1,2]"):
            self.assertIsNone(core.parse_verdict(reply), reply)

    def test_fields_are_clipped_and_missing_ones_default_to_empty(self):
        verdict = core.parse_verdict(json.dumps({"verdict": "FAIL", "violations": [{"rule": "r" * 300, "evidence": "e" * 400}]}))
        v = verdict["violations"][0]
        self.assertEqual(len(v["rule"]), 201)
        self.assertEqual(len(v["evidence"]), 301)
        self.assertEqual(v["fix"], "")

    def test_prose_around_the_json_is_tolerated(self):
        self.assertEqual(core.parse_verdict("Sure! " + PASS_REPLY + " Done."), {"verdict": "PASS", "violations": []})


class FeedbackTest(unittest.TestCase):
    def test_lists_each_violation_with_evidence_and_fix(self):
        out = core.format_feedback([{"rule": "Max 6 lines", "evidence": "#4 12 lines", "fix": "shorten"}, {"rule": "No emoji", "evidence": "", "fix": ""}])
        self.assertTrue(out.startswith("Supervisor audit of your previous work found rule violations from ~/.agents/AGENTS.md:\n"))
        self.assertIn("- Max 6 lines (#4 12 lines) Fix: shorten\n- No emoji\n", out)
        self.assertTrue(out.endswith("Correct these first if they still apply. Do not repeat them."))

    def test_auditor_system_embeds_rules_and_instructions(self):
        out = core.auditor_system("NO FLUFF")
        self.assertIn("You are a strict compliance auditor, not the coding agent.", out)
        self.assertIn("At most 5 violations", out)
        self.assertIn('{"verdict":"PASS"|"FAIL","violations":[{"rule":"short rule text","evidence":"#N quote","fix":"one sentence"}]}', out)
        self.assertTrue(out.endswith("RULES:\nNO FLUFF"))


class EventStreamTest(unittest.TestCase):
    def test_joins_text_events(self):
        stream = "\n".join(json.dumps(e) for e in [
            {"type": "step_start", "part": {"type": "step-start"}},
            {"type": "text", "part": {"type": "text", "text": '{"verdict":'}},
            {"type": "text", "part": {"type": "text", "text": '"PASS"}'}},
            {"type": "step_finish", "part": {"type": "step-finish"}},
        ])
        self.assertEqual(audit.reply_from_events(stream), '{"verdict":"PASS"}')

    def test_error_event_without_text_raises(self):
        with self.assertRaises(audit.JudgeError):
            audit.reply_from_events(json.dumps({"type": "error", "error": {"name": "APIError"}}))

    def test_non_json_output_is_returned_raw(self):
        self.assertEqual(audit.reply_from_events("plain words"), "plain words")

    def test_events_without_text_give_an_empty_reply(self):
        self.assertEqual(audit.reply_from_events(json.dumps({"type": "step_start"})), "")


class Env(unittest.TestCase):
    """Isolated state dir, rules file, fake opencode on PATH."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.bin = root / "bin"
        self.bin.mkdir()
        fake = self.bin / "opencode"
        fake.write_text(FAKE_OPENCODE.replace("__PYTHON__", sys.executable), encoding="utf-8")
        fake.chmod(0o755)
        self.rules = root / "AGENTS.md"
        self.rules.write_text("RULE: reply in 6 lines max", encoding="utf-8")
        self.transcript = root / "t.jsonl"
        self.log = root / "fake.jsonl"
        self.pids = root / "pids.txt"
        self.store = root / "sessions.json"
        self.store.write_text("[]", encoding="utf-8")
        write_transcript(self.transcript, [user("fix it", "u1"), assistant([text("done, here is a long answer")], "a1")])
        patcher = mock.patch.dict(os.environ, {
            "SUPERVISOR_HOME": str(self.home),
            "SUPERVISOR_RULES": str(self.rules),
            "SUPERVISOR_SETTLE_SECONDS": "0",
            "SUPERVISOR_JUDGE_TIMEOUT": "20",
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "FAKE_LOG": str(self.log),
            "FAKE_PIDS": str(self.pids),
            "FAKE_SESSIONS": str(self.store),
            "FAKE_REPLY": PASS_REPLY,
            "FAKE_MODE": "reply",
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("SUPERVISOR_ENABLED", "SUPERVISOR_CHILD", "SUPERVISOR_MODEL", "SUPERVISOR_MAX_CHARS", "FAKE_NO_SESSION_ID", "FAKE_DELETE_MODE"):
            os.environ.pop(name, None)

    def all_calls(self):
        """Every recorded fake opencode invocation, run and session."""
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def calls(self):
        """The recorded `opencode run` invocations."""
        return [c for c in self.all_calls() if c["argv"][0] == "run"]

    def session_calls(self):
        """The recorded `opencode session ...` invocations."""
        return [c for c in self.all_calls() if c["argv"][0] == "session"]

    def sessions(self):
        """The sessions the fake opencode still holds."""
        return json.loads(self.store.read_text())

    def seed_sessions(self, sessions):
        """Pre-populate the fake session store."""
        self.store.write_text(json.dumps(sessions), encoding="utf-8")

    def audits(self):
        """Every line of audits.jsonl."""
        path = self.home / "audits.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_hook(self, script, payload, **env):
        """Run a hook script as Claude Code does, with the payload on stdin."""
        return subprocess.run(
            [sys.executable, str(CLAUDE / script)], input=json.dumps(payload), capture_output=True, text=True,
            env={**os.environ, **env}, check=False, timeout=30,
        )

    def wait_for(self, predicate, seconds=15):
        """Poll until predicate is true."""
        end = time.time() + seconds
        while time.time() < end:
            if predicate():
                return True
            time.sleep(0.1)
        return False


class AuditOnceTest(Env):
    def test_fail_writes_pending_marks_audited_and_logs(self):
        os.environ["FAKE_REPLY"] = FAIL_REPLY
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "fail")
        pending = state.pending_path("s1").read_text()
        self.assertIn("- Max 6 lines (#1 12 lines) Fix: shorten", pending)
        self.assertEqual(state.last_audited("s1"), "a1")
        (entry,) = self.audits()
        self.assertEqual(entry["agent"], "claude-code")
        self.assertEqual(entry["verdict"], "FAIL")
        self.assertEqual(entry["sessionID"], "s1")
        self.assertEqual(entry["messageID"], "a1")
        self.assertEqual(entry["model"], core.DEFAULT_MODEL)
        self.assertEqual(len(entry["violations"]), 2)
        self.assertIn("ms", entry)
        self.assertIn("time", entry)

    def test_judge_command_env_and_prompt(self):
        os.environ["SUPERVISOR_MODEL"] = "prov/some/model"
        audit.audit_once("s1", str(self.transcript))
        (call,) = self.calls()
        argv = call["argv"]
        self.assertEqual(argv[:3], ["run", "--pure", "--format"])
        self.assertEqual(argv[argv.index("--format") + 1], "json")
        self.assertEqual(argv[argv.index("--model") + 1], "prov/some/model")
        workdir = argv[argv.index("--dir") + 1]
        self.assertTrue(call["dir_exists"])
        self.assertFalse(os.path.exists(workdir))
        self.assertEqual(json.loads(call["config"]), {"permission": {"*": "deny"}})
        self.assertEqual((call["enabled"], call["child"]), ("0", "1"))
        sent = call["stdin"]
        self.assertEqual(argv[-2:], ["--model", "prov/some/model"])
        self.assertFalse(any("RULES:" in a or "TRANSCRIPT:" in a for a in argv))
        self.assertTrue(sent.startswith("You are a strict compliance auditor"))
        self.assertIn("RULES:\nRULE: reply in 6 lines max", sent)
        self.assertIn("TRANSCRIPT:\n\n[#0 USER]\nfix it\n\n[#1 ASSISTANT]\ndone, here is a long answer", sent)

    def test_pass_clears_pending(self):
        state.write_atomic(state.pending_path("s1"), "old feedback")
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        self.assertFalse(state.pending_path("s1").exists())
        self.assertEqual(self.audits()[0]["verdict"], "PASS")

    def test_unchanged_transcript_is_not_audited_twice(self):
        audit.audit_once("s1", str(self.transcript))
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "skipped")
        self.assertEqual(len(self.calls()), 1)
        write_transcript(self.transcript, [user("fix it", "u1"), assistant([text("done")], "a1"), user("more", "u2"), assistant([text("ok")], "a2")])
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        self.assertEqual(len(self.calls()), 2)

    def test_garbage_reply_is_not_marked_and_retries_next_time(self):
        os.environ["FAKE_MODE"] = "garbage"
        state.write_atomic(state.pending_path("s1"), "keep me")
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertEqual(state.last_audited("s1"), "")
        self.assertEqual(state.pending_path("s1").read_text(), "keep me")
        (entry,) = self.audits()
        self.assertEqual(entry["error"], "unparseable verdict")
        self.assertLessEqual(len(entry["reply"]), 300)
        self.assertNotIn("verdict", entry)
        os.environ["FAKE_MODE"] = "reply"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")

    def test_fail_verdict_without_violations_is_rejected(self):
        os.environ["FAKE_REPLY"] = '{"verdict":"FAIL","violations":[]}'
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertEqual(state.last_audited("s1"), "")
        self.assertFalse(state.pending_path("s1").exists())

    def test_error_event_is_logged_and_not_marked(self):
        os.environ["FAKE_MODE"] = "error"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertIn("judge error", self.audits()[0]["error"])
        self.assertEqual(state.last_audited("s1"), "")

    def test_missing_opencode_is_logged(self):
        os.environ["PATH"] = str(self.home)
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertIn("could not start opencode", self.audits()[0]["error"])

    def test_hang_is_killed_with_its_whole_process_group(self):
        os.environ["FAKE_MODE"] = "hang"
        os.environ["SUPERVISOR_JUDGE_TIMEOUT"] = "1"
        started = time.time()
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertLess(time.time() - started, 10)
        self.assertIn("timed out", self.audits()[0]["error"])
        self.assertEqual(state.last_audited("s1"), "")
        grandchild = int(self.pids.read_text())
        self.assertTrue(self.wait_for(lambda: not state.pid_alive(grandchild), 5), "grandchild still running")

    def test_no_agent_work_skips_the_judge(self):
        write_transcript(self.transcript, [user("hello", "u1")])
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "skipped")
        self.assertEqual(self.calls(), [])

    def test_missing_transcript_and_missing_rules(self):
        self.assertEqual(audit.audit_once("s1", str(self.home / "nope.jsonl")), "skipped")
        os.environ["SUPERVISOR_RULES"] = str(self.home / "nope.md")
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertIn("rules unreadable", self.audits()[0]["error"])
        self.assertEqual(self.calls(), [])

    def test_prompt_text_is_not_logged_beyond_the_reply_clip(self):
        os.environ["FAKE_MODE"] = "garbage"
        audit.audit_once("s1", str(self.transcript))
        logged = (self.home / "audits.jsonl").read_text()
        self.assertNotIn("RULE: reply in 6 lines max", logged)
        self.assertNotIn("done, here is a long answer", logged)


class RunLockTest(Env):
    def test_running_audit_makes_a_second_stop_set_the_rerun_flag(self):
        self.assertTrue(state.acquire_lock("s1"))
        with mock.patch.object(audit, "audit_once") as once:
            audit.run("s1", str(self.transcript))
        once.assert_not_called()
        self.assertTrue(state.rerun_path("s1").exists())
        self.assertTrue(state.lock_path("s1").exists())

    def test_rerun_flag_makes_the_running_audit_go_again(self):
        calls = []

        def once(session_id, transcript_path):
            calls.append(1)
            if len(calls) == 1:
                audit.run(session_id, transcript_path)
            return "pass"

        with mock.patch.object(audit, "audit_once", side_effect=once):
            audit.run("s1", str(self.transcript))
        self.assertEqual(len(calls), 2)
        self.assertFalse(state.lock_path("s1").exists())
        self.assertFalse(state.rerun_path("s1").exists())

    def test_stale_lock_from_a_dead_process_is_taken_over(self):
        lock = state.lock_path("s1")
        lock.parent.mkdir(parents=True)
        lock.write_text("999999")
        audit.run("s1", str(self.transcript))
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse(lock.exists())

    def test_lock_is_released_when_the_audit_crashes(self):
        with mock.patch.object(audit, "audit_once", side_effect=RuntimeError("boom")):
            audit.run("s1", str(self.transcript))
        self.assertFalse(state.lock_path("s1").exists())
        self.assertIn("audit crashed", self.audits()[0]["error"])


class StopHookTest(Env):
    def call_main(self, payload):
        """Run stop.main in process with a mocked Popen; return (exit code, stdout, Popen mock)."""
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), mock.patch.object(stop.subprocess, "Popen") as popen, contextlib.redirect_stdout(out):
            code = stop.main()
        return code, out.getvalue(), popen

    def payload(self, **extra):
        """A Stop hook payload for the fixture transcript."""
        return {"session_id": "s1", "transcript_path": str(self.transcript), "stop_hook_active": False, "hook_event_name": "Stop", **extra}

    def test_spawns_a_detached_child_and_prints_nothing(self):
        code, out, popen = self.call_main(self.payload())
        self.assertEqual((code, out), (0, ""))
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0][1:], [str(CLAUDE / "audit.py"), "s1", str(self.transcript)])
        self.assertTrue(kwargs["start_new_session"])
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(kwargs[stream], subprocess.DEVNULL)

    def test_guards_skip_the_audit(self):
        cases = [
            ("disabled", {"SUPERVISOR_ENABLED": "0"}, self.payload()),
            ("child env", {"SUPERVISOR_CHILD": "1"}, self.payload()),
            ("stop_hook_active", {}, self.payload(stop_hook_active=True)),
            ("missing transcript", {}, self.payload(transcript_path=str(self.home / "none.jsonl"))),
            ("no transcript path", {}, {"session_id": "s1"}),
        ]
        for name, env, payload in cases:
            with self.subTest(name), mock.patch.dict(os.environ, env):
                code, out, popen = self.call_main(payload)
                self.assertEqual((code, out), (0, ""))
                popen.assert_not_called()

    def test_bad_stdin_exits_zero(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO("not json")), mock.patch.object(stop.subprocess, "Popen") as popen, contextlib.redirect_stdout(out):
            self.assertEqual(stop.main(), 0)
        popen.assert_not_called()
        self.assertEqual(out.getvalue(), "")

    def test_script_returns_at_once_and_the_child_finishes_the_audit(self):
        os.environ["FAKE_REPLY"] = FAIL_REPLY
        started = time.time()
        result = self.run_hook("stop.py", self.payload())
        self.assertLess(time.time() - started, 5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertTrue(self.wait_for(lambda: state.pending_path("s1").exists()), "child never wrote the pending file")
        self.assertTrue(self.wait_for(lambda: not state.lock_path("s1").exists()))
        self.assertEqual(self.audits()[0]["verdict"], "FAIL")

    def test_script_with_disabled_env_does_nothing(self):
        result = self.run_hook("stop.py", self.payload(), SUPERVISOR_ENABLED="0")
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        time.sleep(0.5)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.home / "audits.jsonl").exists())

    def test_whole_flow_stop_then_next_prompt_delivers_once(self):
        os.environ["FAKE_REPLY"] = FAIL_REPLY
        self.run_hook("stop.py", self.payload())
        self.assertTrue(self.wait_for(lambda: state.pending_path("s1").exists()))
        first = self.run_hook("prompt.py", {"session_id": "s1", "prompt": "next", "hook_event_name": "UserPromptSubmit"})
        second = self.run_hook("prompt.py", {"session_id": "s1", "prompt": "next", "hook_event_name": "UserPromptSubmit"})
        self.assertEqual(first.returncode, 0)
        self.assertIn("Max 6 lines", json.loads(first.stdout)["hookSpecificOutput"]["additionalContext"])
        self.assertEqual((second.returncode, second.stdout), (0, ""))


class PromptHookTest(Env):
    def test_delivers_feedback_as_one_json_object_and_deletes_the_file(self):
        feedback = core.format_feedback([{"rule": "A", "evidence": "#1", "fix": "f"}, {"rule": "B", "evidence": "", "fix": ""}])
        state.write_atomic(state.pending_path("s1"), feedback)
        result = self.run_hook("prompt.py", {"session_id": "s1", "prompt": "go", "hook_event_name": "UserPromptSubmit"})
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(result.stdout.count("\n"), 1)
        data = json.loads(result.stdout)
        self.assertEqual(data["systemMessage"], "supervisor: 2 rule violation(s) from your last turn")
        self.assertEqual(data["hookSpecificOutput"], {"hookEventName": "UserPromptSubmit", "additionalContext": f"<system-reminder>\n{feedback}\n</system-reminder>"})
        self.assertEqual(set(data), {"systemMessage", "hookSpecificOutput"})
        self.assertFalse(state.pending_path("s1").exists())

    def test_prints_nothing_without_pending_feedback(self):
        result = self.run_hook("prompt.py", {"session_id": "s1", "prompt": "go"})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_other_sessions_are_untouched(self):
        state.write_atomic(state.pending_path("other"), "- x")
        result = self.run_hook("prompt.py", {"session_id": "s1"})
        self.assertEqual(result.stdout, "")
        self.assertTrue(state.pending_path("other").exists())

    def test_session_id_is_sanitised_for_file_names(self):
        self.assertEqual(state.safe_session_id("../../etc/x y"), "etcxy")
        self.assertEqual(state.safe_session_id(None), "unknown")
        self.assertEqual(state.safe_session_id(""), "unknown")
        self.assertEqual(state.pending_path("../../evil").parent, self.home / "pending")
        state.write_atomic(state.pending_path("../a"), "- hit")
        result = self.run_hook("prompt.py", {"session_id": "../a"})
        self.assertIn("hit", result.stdout)

    def test_garbage_stdin_exits_zero_silently(self):
        result = subprocess.run([sys.executable, str(CLAUDE / "prompt.py")], input="{{{", capture_output=True, text=True, env=os.environ.copy(), check=False)
        self.assertEqual((result.returncode, result.stdout), (0, ""))


class SessionEndHookTest(Env):
    def test_deletes_session_files_and_prunes_old_ones(self):
        for path in (state.lock_path("s1"), state.rerun_path("s1")):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("999999")
        state.mark_audited("s1", "a1")
        state.mark_audited("other", "a9")
        state.write_atomic(state.pending_path("old"), "- x")
        state.write_atomic(state.pending_path("fresh"), "- y")
        old = time.time() - 8 * 86400
        os.utime(state.pending_path("old"), (old, old))
        os.utime(state.audited_path("other"), (old, old))
        result = self.run_hook("session_end.py", {"session_id": "s1", "hook_event_name": "SessionEnd", "reason": "other"})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertFalse(state.lock_path("s1").exists())
        self.assertFalse(state.rerun_path("s1").exists())
        self.assertFalse(state.audited_path("s1").exists())
        self.assertFalse(state.pending_path("old").exists())
        self.assertFalse(state.audited_path("other").exists())
        self.assertTrue(state.pending_path("fresh").exists())

    def end(self):
        """Run the SessionEnd hook for s1."""
        return self.run_hook("session_end.py", {"session_id": "s1", "hook_event_name": "SessionEnd"})

    def make_session_files(self, owner_pid, age=0):
        """Create s1's lock (owned by owner_pid, age seconds old), rerun and state files."""
        lock = state.lock_path("s1")
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(str(owner_pid))
        state.rerun_path("s1").touch()
        state.mark_audited("s1", "a1")
        if age:
            old = time.time() - age
            os.utime(lock, (old, old))

    def test_a_live_audits_lock_is_kept(self):
        self.make_session_files(os.getpid())
        self.assertEqual(self.end().returncode, 0)
        self.assertTrue(state.lock_path("s1").exists())
        self.assertTrue(state.rerun_path("s1").exists())
        self.assertTrue(state.audited_path("s1").exists())

    def test_a_lock_of_a_dead_owner_is_removed(self):
        self.make_session_files(999999)
        self.end()
        self.assertFalse(state.lock_path("s1").exists())
        self.assertFalse(state.rerun_path("s1").exists())
        self.assertFalse(state.audited_path("s1").exists())

    def test_a_lock_with_a_stale_mtime_is_removed_even_if_the_pid_is_alive(self):
        self.make_session_files(os.getpid(), age=state.LOCK_STALE_SECONDS + 60)
        self.end()
        self.assertFalse(state.lock_path("s1").exists())

    def test_works_with_nothing_to_clean(self):
        result = self.run_hook("session_end.py", {"session_id": "s1"})
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        with mock.patch.object(sys, "stdin", io.StringIO("{}")):
            self.assertEqual(session_end.main(), 0)


class SessionCleanupTest(Env):
    def decoys(self):
        """Sessions that must never be deleted: a user session and another run's audit session."""
        return [
            {"id": "ses_user", "title": "my real work", "created": 1, "directory": "/work"},
            {"id": "ses_other_audit", "title": "supervisor audit", "created": int(time.time() * 1000) + 5000, "directory": "/elsewhere"},
        ]

    def test_run_is_titled_and_its_session_is_deleted_by_id(self):
        self.seed_sessions(self.decoys())
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        (call,) = self.calls()
        self.assertEqual(call["argv"][call["argv"].index("--title") + 1], "supervisor audit")
        (delete,) = [c for c in self.session_calls() if c["argv"][1] == "delete"]
        self.assertTrue(delete["argv"][2].startswith("ses_fake_"))
        self.assertEqual([x["id"] for x in self.sessions()], ["ses_user", "ses_other_audit"])
        self.assertEqual([c["argv"][1] for c in self.session_calls()], ["delete"])

    def test_session_commands_run_without_plugins(self):
        os.environ["FAKE_NO_SESSION_ID"] = "1"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        calls = self.session_calls()
        self.assertEqual([c["argv"][1] for c in calls], ["list", "delete"])
        self.assertTrue(all("--pure" in c["argv"] for c in calls))

    def test_long_prompt_goes_on_stdin_not_in_argv(self):
        long_text = "x" * 300000
        write_transcript(self.transcript, [user("fix it", "u1"), assistant([text(long_text)], "a1")])
        os.environ["SUPERVISOR_MAX_CHARS"] = "400000"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        (call,) = self.calls()
        self.assertGreater(len(call["stdin"]), 300000)
        self.assertLess(sum(len(a) for a in call["argv"]), 1000)

    def test_session_is_deleted_after_a_timeout_by_exact_title_and_directory(self):
        self.seed_sessions(self.decoys())
        os.environ["FAKE_MODE"] = "hang"
        os.environ["SUPERVISOR_JUDGE_TIMEOUT"] = "1"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertEqual([x["id"] for x in self.sessions()], ["ses_user", "ses_other_audit"])
        self.assertEqual([c["argv"][1] for c in self.session_calls()], ["list", "delete"])

    def test_session_is_deleted_when_no_event_carried_an_id(self):
        os.environ["FAKE_NO_SESSION_ID"] = "1"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        self.assertEqual(self.sessions(), [])
        os.environ["FAKE_MODE"] = "garbage"
        self.assertEqual(audit.audit_once("s2", str(self.transcript)), "error")
        self.assertEqual(self.sessions(), [])

    def test_error_run_still_deletes_its_session(self):
        os.environ["FAKE_MODE"] = "error"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "error")
        self.assertEqual(self.sessions(), [])

    def test_lookup_only_matches_exact_title_in_this_directory_created_after_start(self):
        workdir = str(Path(self.tmp.name) / "work")
        Path(workdir).mkdir()
        real = os.path.realpath(workdir)
        self.seed_sessions([
            {"id": "ses_old", "title": "supervisor audit", "created": 1000, "directory": real},
            {"id": "ses_new_a", "title": "supervisor audit", "created": 5000, "directory": real},
            {"id": "ses_new_b", "title": "supervisor audit", "created": 6000, "directory": workdir},
            {"id": "ses_titled", "title": "supervisor audit 2", "created": 7000, "directory": real},
            {"id": "ses_dir", "title": "supervisor audit", "created": 7000, "directory": "/elsewhere"},
        ])
        self.assertEqual(audit.find_audit_sessions(workdir, 2000, dict(os.environ)), ["ses_new_b", "ses_new_a"])

    def test_cleanup_failures_never_raise_or_change_the_verdict(self):
        os.environ["FAKE_DELETE_MODE"] = "fail"
        self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        self.assertEqual(len(self.sessions()), 1)

    def test_cleanup_hang_is_cut_off_at_the_timeout(self):
        os.environ["FAKE_DELETE_MODE"] = "hang"
        started = time.time()
        with mock.patch.object(audit, "CLEANUP_TIMEOUT", 1):
            self.assertEqual(audit.audit_once("s1", str(self.transcript)), "pass")
        self.assertLess(time.time() - started, 10)

    def test_session_id_is_read_from_the_first_event_that_has_one(self):
        stream = "\n".join(["junk", json.dumps({"type": "step_start"}), json.dumps({"type": "text", "sessionID": "ses_1"}), json.dumps({"sessionID": "ses_2"})])
        self.assertEqual(audit.session_id_from_events(stream), "ses_1")
        self.assertEqual(audit.session_id_from_events("nothing"), "")

    def test_judge_timeout_defaults_to_240_seconds(self):
        os.environ.pop("SUPERVISOR_JUDGE_TIMEOUT")
        with mock.patch.object(audit, "run_judge", return_value=PASS_REPLY) as judge:
            audit.audit_once("s1", str(self.transcript))
        self.assertEqual(judge.call_args[0][2], 240.0)
        self.assertEqual(audit.DEFAULT_JUDGE_TIMEOUT, 240)


class PromptCapTest(unittest.TestCase):
    def many_users(self, count, size=1900):
        """Alternating user and assistant messages with distinct user text."""
        msgs = []
        for i in range(count):
            msgs.append(msg("user", t(f"ask{i:04d} " + "u" * size)))
            msgs.append(msg("assistant", t(f"answer{i:04d}")))
        return msgs

    def test_under_the_cap_the_prompt_is_unchanged(self):
        msgs = [msg("user", t("fix it")), msg("assistant", t("done"))]
        out = core.build_prompt("RULES", msgs, 60000)
        self.assertEqual(out, f"{core.auditor_system('RULES')}\n\nTRANSCRIPT:\n\n{core.render_transcript(msgs, 60000)}")

    def test_over_the_cap_drops_the_oldest_user_messages_first(self):
        msgs = self.many_users(300)
        out = core.build_prompt("RULES", msgs, 60000, cap=100000)
        self.assertLessEqual(len(out), 100000)
        self.assertNotIn("ask0000", out)
        self.assertIn("ask0299", out)
        self.assertIn("answer0299", out)
        self.assertTrue(out.startswith(core.auditor_system("RULES")))

    def test_default_cap_is_400000_characters(self):
        self.assertEqual(core.MAX_PROMPT_CHARS, 400000)
        out = core.build_prompt("RULES", self.many_users(400), 60000)
        self.assertLessEqual(len(out), 400000)
        self.assertIn("ask0399", out)
        self.assertNotIn("ask0000", out)

    def test_a_huge_max_chars_cannot_push_the_prompt_over_the_cap(self):
        msgs = [msg("user", t("ask")), msg("assistant", t("z" * 600000))]
        out = core.build_prompt("RULES", msgs, 10000000, cap=100000)
        self.assertLessEqual(len(out), 100000 + core.USER_MESSAGE_CAP)
        self.assertIn("ask", out)

    def test_nothing_is_dropped_when_it_fits(self):
        out = core.build_prompt("RULES", self.many_users(20), 60000, cap=400000)
        self.assertIn("ask0000", out)
        self.assertIn("ask0019", out)


class LockTest(Env):
    def test_stale_lock_is_taken_by_exactly_one_of_many_threads(self):
        import threading

        lock = state.lock_path("race")
        lock.parent.mkdir(parents=True)
        lock.write_text("999999")
        barrier = threading.Barrier(16)
        results = []

        def attempt():
            barrier.wait()
            results.append(state.acquire_lock("race"))

        threads = [threading.Thread(target=attempt) for _ in range(16)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(results.count(True), 1)
        self.assertEqual(lock.read_text(), str(os.getpid()))

    def test_stale_lock_is_taken_by_exactly_one_of_many_processes(self):
        lock = state.lock_path("race")
        lock.parent.mkdir(parents=True)
        lock.write_text("999999")
        start = time.time() + 1.5
        script = (
            "import sys, time; sys.path.insert(0, sys.argv[1]); import state\n"
            "time.sleep(max(0, float(sys.argv[2]) - time.time()))\n"
            "print(state.acquire_lock('race'), flush=True)\n"
            "time.sleep(1.5)\n"
        )
        procs = [
            subprocess.Popen([sys.executable, "-c", script, str(CLAUDE), str(start)], stdout=subprocess.PIPE, text=True, env=os.environ.copy())
            for _ in range(6)
        ]
        results = [p.communicate(timeout=30)[0].strip() for p in procs]
        self.assertEqual(results.count("True"), 1, results)

    def test_a_live_lock_is_not_taken(self):
        self.assertTrue(state.acquire_lock("s1"))
        self.assertFalse(state.acquire_lock("s1"))

    def test_release_only_drops_a_lock_this_process_owns(self):
        lock = state.lock_path("s1")
        lock.parent.mkdir(parents=True)
        lock.write_text(str(os.getpid() + 1))
        state.release_lock("s1")
        self.assertTrue(lock.exists())
        lock.write_text(str(os.getpid()))
        state.release_lock("s1")
        self.assertFalse(lock.exists())


class HooksFileTest(unittest.TestCase):
    def test_hooks_json_wires_the_three_hooks(self):
        hooks = json.loads((CLAUDE.parent / "hooks" / "hooks.json").read_text())["hooks"]
        self.assertEqual(set(hooks), {"Stop", "UserPromptSubmit", "SessionEnd"})
        for event, script in (("Stop", "stop.py"), ("UserPromptSubmit", "prompt.py"), ("SessionEnd", "session_end.py")):
            command = hooks[event][0]["hooks"][0]["command"]
            self.assertEqual(command, f'python3 "${{CLAUDE_PLUGIN_ROOT}}/claude/{script}"')
            self.assertTrue((CLAUDE / script).exists())

    def test_plugin_manifest(self):
        manifest = json.loads((CLAUDE.parent / ".claude-plugin" / "plugin.json").read_text())
        self.assertEqual((manifest["name"], manifest["version"]), ("supervisor", "0.4.0"))
        self.assertEqual(manifest["author"], {"name": "Dzianis Vashchuk"})


class PrivateFilesTest(Env):
    def mode(self, path):
        """Permission bits of a path."""
        return os.stat(path).st_mode & 0o777

    def test_state_dir_and_files_are_private(self):
        os.environ["FAKE_REPLY"] = FAIL_REPLY
        self.home.mkdir(mode=0o755)
        os.chmod(self.home, 0o755)
        audit.audit_once("s1", str(self.transcript))
        state.set_rerun("s1")
        for directory in (self.home, self.home / "pending", self.home / "state", self.home / "locks"):
            self.assertEqual(self.mode(directory), 0o700, directory)
        for path in (self.home / "audits.jsonl", state.pending_path("s1"), state.audited_path("s1"), state.rerun_path("s1")):
            self.assertEqual(self.mode(path), 0o600, path)
        self.assertTrue(state.acquire_lock("s1"))
        self.assertEqual(self.mode(state.lock_path("s1")), 0o600)
        self.assertEqual(self.mode(state.lock_path("s1").with_suffix(".guard")), 0o600)

    def test_an_existing_world_readable_log_is_tightened(self):
        self.home.mkdir()
        log = self.home / "audits.jsonl"
        log.write_text("", encoding="utf-8")
        os.chmod(log, 0o644)
        state.record({"sessionID": "s1"})
        self.assertEqual(self.mode(log), 0o600)


class LogPruneTest(Env):
    def line(self, days_ago, session):
        """One audit log line with a time days_ago days back."""
        stamp = datetime.now(timezone.utc) - timedelta(days=days_ago)
        return json.dumps({"time": stamp.isoformat(timespec="milliseconds"), "sessionID": session})

    def test_prune_log_drops_old_and_corrupt_lines_and_keeps_recent_ones(self):
        self.home.mkdir()
        log = self.home / "audits.jsonl"
        log.write_text("\n".join([self.line(40, "old"), "garbage", '{"sessionID":"notime"}', self.line(29, "edge"), self.line(1, "new"), ""]), encoding="utf-8")
        state.prune_log(log)
        ids = [json.loads(x)["sessionID"] for x in log.read_text().splitlines()]
        self.assertEqual(ids, ["edge", "new"])
        self.assertEqual(os.stat(log).st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in self.home.iterdir()], ["audits.jsonl"])

    def test_prune_log_accepts_javascript_timestamps(self):
        self.home.mkdir()
        log = self.home / "audits.jsonl"
        recent = json.dumps({"time": (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.123Z")})
        old = json.dumps({"time": "2020-01-01T00:00:00.000Z"})
        log.write_text(old + "\n" + recent + "\n", encoding="utf-8")
        state.prune_log(log)
        self.assertEqual(log.read_text(), recent + "\n")

    def test_prune_log_without_a_file_or_changes_does_nothing(self):
        state.prune_log(self.home / "audits.jsonl")
        self.home.mkdir()
        log = self.home / "audits.jsonl"
        log.write_text(self.line(1, "a") + "\n", encoding="utf-8")
        before = os.stat(log).st_ino
        state.prune_log(log)
        self.assertEqual(os.stat(log).st_ino, before)

    def test_session_end_prunes_the_log(self):
        self.home.mkdir()
        log = self.home / "audits.jsonl"
        log.write_text(self.line(45, "old") + "\n" + self.line(0, "new") + "\n", encoding="utf-8")
        result = self.run_hook("session_end.py", {"session_id": "s1", "hook_event_name": "SessionEnd"})
        self.assertEqual(result.returncode, 0)
        self.assertEqual([e["sessionID"] for e in self.audits()], ["new"])


if __name__ == "__main__":
    unittest.main()
