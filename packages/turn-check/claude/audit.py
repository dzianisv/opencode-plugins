#!/usr/bin/env python3
"""Detached audit child started by the Stop hook: judge the transcript with `opencode run --pure`."""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import core
import state

AGENT = "claude-code"
JUDGE_CONFIG = '{"permission":{"*":"deny"}}'
AUDIT_TITLE = "supervisor audit"
DEFAULT_JUDGE_TIMEOUT = 240
CLEANUP_TIMEOUT = 20


class JudgeError(Exception):
    """The judge call failed in a way that should be logged and retried on the next Stop."""


def model_name() -> str:
    """The judge model spec, provider/model."""
    return os.environ.get("SUPERVISOR_MODEL") or core.DEFAULT_MODEL


def load_entries(transcript_path: str) -> list:
    """Parse the transcript JSONL, skipping lines that are not JSON objects."""
    entries = []
    with open(transcript_path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                entries.append(entry)
    return entries


def reply_from_events(stdout: str) -> str:
    """Join the assistant text events of an `opencode run --format json` stream; fall back to the raw output."""
    texts = []
    errors = []
    parsed = False
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        parsed = True
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        if event.get("type") == "text" and isinstance(part.get("text"), str):
            texts.append(part["text"])
        elif event.get("type") == "error":
            errors.append(json.dumps(event.get("error") if event.get("error") is not None else event)[:300])
    if texts:
        return "".join(texts)
    if errors:
        raise JudgeError(f"judge error: {errors[0]}")
    return "" if parsed else stdout


def kill_group(pgid: int) -> None:
    """Kill every process in the group, ignoring ones that are already gone."""
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def session_id_from_events(stdout: str) -> str:
    """The opencode session id carried by the first JSON event that has one, or an empty string."""
    for line in (stdout or "").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and isinstance(event.get("sessionID"), str) and event["sessionID"]:
            return event["sessionID"]
    return ""


def run_cli(args: list, env: dict, cwd: str, timeout: float) -> str:
    """Run an opencode CLI command in its own process group and return stdout; empty on any failure. Never raises."""
    try:
        proc = subprocess.Popen(
            ["opencode", *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, cwd=cwd, start_new_session=True, text=True, errors="replace",
        )
    except OSError:
        return ""
    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(proc.pid)
        proc.communicate()
        return ""
    finally:
        kill_group(proc.pid)
    return stdout if proc.returncode == 0 else ""


def delete_session(session_id: str, env: dict, cwd: str) -> None:
    """Delete one opencode session, ignoring failure."""
    run_cli(["session", "delete", session_id, "--pure"], env, cwd, CLEANUP_TIMEOUT)


def find_audit_sessions(workdir: str, started_ms: int, env: dict) -> list:
    """Ids of sessions titled exactly AUDIT_TITLE, created after started_ms in this run's directory, newest first."""
    try:
        sessions = json.loads(run_cli(["session", "list", "--format", "json", "-n", "50", "--pure"], env, workdir, CLEANUP_TIMEOUT) or "[]")
    except ValueError:
        return []
    wanted = os.path.realpath(workdir)
    found = [
        s for s in sessions
        if isinstance(s, dict) and s.get("title") == AUDIT_TITLE and isinstance(s.get("id"), str)
        and isinstance(s.get("created"), (int, float)) and s["created"] >= started_ms
        and isinstance(s.get("directory"), str) and os.path.realpath(s["directory"]) == wanted
    ]
    return [s["id"] for s in sorted(found, key=lambda s: s["created"], reverse=True)]


def run_judge(prompt: str, model: str, timeout: float) -> str:
    """Run opencode as the judge in its own process group, send the prompt on stdin, return its reply text and delete its saved session."""
    workdir = tempfile.mkdtemp(prefix="supervisor-")
    env = {**os.environ, "OPENCODE_CONFIG_CONTENT": JUDGE_CONFIG, "SUPERVISOR_ENABLED": "0", "SUPERVISOR_CHILD": "1"}
    cmd = ["opencode", "run", "--pure", "--format", "json", "--title", AUDIT_TITLE, "--dir", workdir, "--model", model]
    started_ms = int(time.time() * 1000)
    stdout = ""
    try:
        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=env, start_new_session=True, text=True, errors="replace",
            )
        except OSError as exc:
            raise JudgeError(f"could not start opencode: {exc}")
        try:
            stdout, _ = proc.communicate(input=prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_group(proc.pid)
            stdout, _ = proc.communicate()
            raise JudgeError(f"judge timed out after {timeout:g}s")
        finally:
            kill_group(proc.pid)
        return reply_from_events(stdout)
    finally:
        try:
            session_id = session_id_from_events(stdout)
            for found in [session_id] if session_id else find_audit_sessions(workdir, started_ms, env):
                delete_session(found, env, workdir)
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(workdir, ignore_errors=True)


def audit_once(session_id: str, transcript_path: str) -> str:
    """Audit the newest state of the transcript once. Returns skipped, pass, fail or error."""
    try:
        entries = load_entries(transcript_path)
    except OSError:
        return "skipped"
    msgs = core.build_messages(entries)
    message_id = core.last_entry_uuid(entries)
    if not message_id or not core.has_agent_work(msgs) or state.last_audited(session_id) == message_id:
        return "skipped"

    model = model_name()
    base = {"model": model, "agent": AGENT, "sessionID": session_id, "messageID": message_id}
    started = time.time()
    rules_path = Path(os.environ.get("SUPERVISOR_RULES") or "~/.agents/AGENTS.md").expanduser()
    try:
        rules = rules_path.read_text(encoding="utf-8")
    except OSError as exc:
        state.record({**base, "error": f"rules unreadable: {exc.strerror or exc}"})
        return "error"

    max_chars = int(os.environ.get("SUPERVISOR_MAX_CHARS") or 60000)
    prompt = core.build_prompt(rules, msgs, max_chars)
    try:
        reply = run_judge(prompt, model, float(os.environ.get("SUPERVISOR_JUDGE_TIMEOUT") or DEFAULT_JUDGE_TIMEOUT))
    except JudgeError as exc:
        state.record({**base, "ms": int((time.time() - started) * 1000), "error": str(exc)})
        return "error"

    verdict = core.parse_verdict(reply)
    if verdict is None:
        state.record({**base, "ms": int((time.time() - started) * 1000), "error": "unparseable verdict", "reply": reply[:300]})
        return "error"

    state.mark_audited(session_id, message_id)
    state.record({**base, "ms": int((time.time() - started) * 1000), **verdict})
    if verdict["verdict"] == "PASS":
        state.remove(state.pending_path(session_id))
        return "pass"
    state.write_atomic(state.pending_path(session_id), core.format_feedback(verdict["violations"]))
    return "fail"


def run(session_id: str, transcript_path: str) -> None:
    """Audit under the session lock; a Stop that arrives mid-audit sets a flag and the audit goes again."""
    if not state.acquire_lock(session_id):
        state.set_rerun(session_id)
        if not state.acquire_lock(session_id):
            return
        state.take_rerun(session_id)
    while True:
        try:
            audit_once(session_id, transcript_path)
        except Exception as exc:  # noqa: BLE001
            state.record({"agent": AGENT, "sessionID": session_id, "error": f"audit crashed: {exc}"[:300]})
        state.release_lock(session_id)
        if not state.take_rerun(session_id) or not state.acquire_lock(session_id):
            return


def main(argv: list) -> int:
    """Entry point: audit.py <session_id> <transcript_path>."""
    if len(argv) != 3:
        return 0
    time.sleep(float(os.environ.get("SUPERVISOR_SETTLE_SECONDS") or 2))
    run(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:  # noqa: BLE001
        sys.exit(0)
