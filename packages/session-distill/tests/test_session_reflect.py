"""Tests for the session-distill hooks. Run: python3 -m unittest discover -s tests"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import capture  # noqa: E402
import reminder  # noqa: E402


def run_hook(script: str, payload: dict, home: str, **env) -> subprocess.CompletedProcess:
    """Run a hook script the way Claude Code does: JSON on stdin."""
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env={**os.environ, "SESSION_DISTILL_HOME": home, **env},
        check=False,
    )


def write_transcript(path: Path, blocks: list[dict]) -> None:
    """Write one message per block in transcript JSONL form."""
    path.write_text("\n".join(json.dumps({"message": {"content": [b]}}) for b in blocks), encoding="utf-8")


class CaptureTest(unittest.TestCase):
    def test_cue_kinds(self):
        cases = {
            "no, use ripgrep instead of grep": "correction",
            "from now on run make lint first": "rule",
            "that didn’t work, still failing": "failure",
            "looks good, ship it": "approval",
        }
        for prompt, kind in cases.items():
            with self.subTest(prompt=prompt):
                self.assertIn(kind, capture.find_cues(prompt))

    def test_plain_question_has_no_cue(self):
        self.assertEqual(capture.find_cues("what does this function return?"), {})

    def test_confidence_adds_for_a_second_kind_and_is_capped(self):
        self.assertEqual(capture.confidence({"correction": 0.8}), 0.8)
        self.assertEqual(capture.confidence({"correction": 0.8, "failure": 0.6}), 0.9)
        self.assertEqual(capture.confidence({}), 0.0)

    def test_approval_alone_is_not_recorded(self):
        with tempfile.TemporaryDirectory() as home:
            run_hook("capture.py", {"session_id": "s", "prompt": "looks good"}, home)
            self.assertFalse((Path(home) / "queue").exists())

    def test_record_holds_no_prompt_text(self):
        secret = "abcdef1234567890"
        prompt = f'always use Authorization: Bearer {secret} and {{"password": "two word secret"}}'
        with tempfile.TemporaryDirectory() as home:
            res = run_hook("capture.py", {"session_id": "s1", "prompt": prompt, "transcript_path": "/t.jsonl"}, home)
            self.assertEqual((res.returncode, res.stdout), (0, ""))
            raw = (Path(home) / "queue" / "s1.jsonl").read_text()
            for fragment in (secret, "two word secret", "Authorization", "password"):
                self.assertNotIn(fragment, raw)
            record = json.loads(raw.splitlines()[0])
            self.assertEqual(record["kinds"], ["rule"])
            self.assertEqual(record["transcript_path"], "/t.jsonl")

    def test_slash_commands_are_skipped(self):
        with tempfile.TemporaryDirectory() as home:
            run_hook("capture.py", {"session_id": "s", "prompt": "/model foo, don't use it"}, home)
            self.assertFalse((Path(home) / "queue").exists())

    def test_queue_cap_and_session_id_sanitised(self):
        with tempfile.TemporaryDirectory() as home:
            for _ in range(3):
                run_hook(
                    "capture.py",
                    {"session_id": "../../evil", "prompt": "don't use sed"},
                    home,
                    SESSION_DISTILL_QUEUE_MAX="2",
                )
            files = list((Path(home) / "queue").glob("*.jsonl"))
            self.assertEqual([f.name for f in files], ["evil.jsonl"])
            self.assertEqual(len(files[0].read_text().splitlines()), 2)

    def test_disabled(self):
        with tempfile.TemporaryDirectory() as home:
            run_hook("capture.py", {"session_id": "s", "prompt": "don't use sed"}, home, SESSION_DISTILL_CAPTURE="0")
            self.assertFalse((Path(home) / "queue").exists())


class ReminderTest(unittest.TestCase):
    def edits(self, n: int) -> list[dict]:
        return [{"type": "tool_use", "name": "Edit", "input": {"file_path": f"a{i}.go"}} for i in range(n)]

    def write_pair(self, tool_id: str, path: str, result: str, is_error: bool = False) -> list[dict]:
        return [
            {"type": "tool_use", "id": tool_id, "name": "Write", "input": {"file_path": path}},
            {"type": "tool_result", "tool_use_id": tool_id, "content": result, "is_error": is_error},
        ]

    def tally(self, blocks: list[dict]) -> reminder.Tally:
        with tempfile.TemporaryDirectory() as tmp:
            tr = Path(tmp) / "t.jsonl"
            write_transcript(tr, blocks)
            return reminder.tally(str(tr))

    def test_is_work(self):
        commit = {"type": "tool_use", "name": "Bash", "input": {"command": "git commit -m x"}}
        self.assertTrue(reminder.is_work(commit))
        self.assertFalse(reminder.is_work({"type": "tool_use", "name": "Read", "input": {}}))
        self.assertFalse(reminder.is_work({"type": "text"}))

    def test_new_files_count_only_created_scripts(self):
        created = self.write_pair("1", "/x/scripts/gq.sh", "File created successfully at: /x/scripts/gq.sh")
        overwritten = self.write_pair("2", "/x/scripts/old.sh", "The file /x/scripts/old.sh has been updated successfully.")
        failed = self.write_pair("3", "/x/scripts/bad.sh", "File created successfully", is_error=True)
        duplicate = self.write_pair("4", "/x/scripts/gq.sh", "File created successfully at: /x/scripts/gq.sh")
        notes = self.write_pair("5", "/x/notes.md", "File created successfully at: /x/notes.md")
        self.assertEqual(self.tally(created + overwritten + failed + duplicate + notes).new_files, 1)

    def test_tool_result_content_list(self):
        blocks = self.write_pair("1", "/x/run.sh", "")
        blocks[1]["content"] = [{"type": "text", "text": "File created successfully at: /x/run.sh"}]
        self.assertEqual(self.tally(blocks).new_files, 1)

    def test_reminds_once_after_enough_work(self):
        with tempfile.TemporaryDirectory() as home:
            tr = Path(home) / "t.jsonl"
            write_transcript(tr, self.edits(3))
            payload = {"hook_event_name": "Stop", "session_id": "s", "transcript_path": str(tr)}
            first = run_hook("reminder.py", payload, home)
            self.assertIn("/session-distill:session-distill", json.loads(first.stdout)["systemMessage"])
            self.assertEqual(run_hook("reminder.py", payload, home).stdout, "")

    def test_quiet_session_stays_silent(self):
        with tempfile.TemporaryDirectory() as home:
            tr = Path(home) / "t.jsonl"
            write_transcript(tr, self.edits(1))
            payload = {"hook_event_name": "Stop", "session_id": "s", "transcript_path": str(tr)}
            self.assertEqual(run_hook("reminder.py", payload, home).stdout, "")

    def test_new_script_or_queued_cue_triggers(self):
        with tempfile.TemporaryDirectory() as home:
            tr = Path(home) / "t.jsonl"
            write_transcript(tr, self.write_pair("1", "t/run.sh", "File created successfully at: t/run.sh"))
            out = run_hook("reminder.py", {"hook_event_name": "Stop", "session_id": "a", "transcript_path": str(tr)}, home)
            self.assertIn("new script", json.loads(out.stdout)["systemMessage"])
            run_hook("capture.py", {"session_id": "b", "prompt": "don't use sed"}, home)
            out = run_hook("reminder.py", {"hook_event_name": "Stop", "session_id": "b"}, home)
            self.assertIn("correction cue", json.loads(out.stdout)["systemMessage"])

    def test_stop_hook_active_and_session_end(self):
        with tempfile.TemporaryDirectory() as home:
            tr = Path(home) / "t.jsonl"
            write_transcript(tr, self.edits(5))
            base = {"session_id": "s", "transcript_path": str(tr)}
            active = run_hook("reminder.py", {**base, "hook_event_name": "Stop", "stop_hook_active": True}, home)
            self.assertEqual(active.stdout, "")
            run_hook("reminder.py", {**base, "hook_event_name": "Stop"}, home)
            self.assertTrue((Path(home) / "markers" / "s.mark").exists())
            run_hook("reminder.py", {**base, "hook_event_name": "SessionEnd"}, home)
            self.assertFalse((Path(home) / "markers" / "s.mark").exists())

    def test_bad_input_never_fails(self):
        with tempfile.TemporaryDirectory() as home:
            res = subprocess.run(
                [sys.executable, str(SCRIPTS / "reminder.py")], input="not json",
                capture_output=True, text=True, env={**os.environ, "SESSION_DISTILL_HOME": home}, check=False,
            )
            self.assertEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
