#!/usr/bin/env python3
"""Stop / SessionEnd hook: suggest the reflect command once a session did real work."""

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import reflect_state

WORK_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit", "Skill", "Task", "Agent"})
SCRIPT_PATH = re.compile(r"(\.(sh|py|js|ts|rb)$|/scripts/|/bin/|/skills/|/hooks/)")
CREATED = "created successfully"
COMMAND = "/session-self-improve:session-self-improve"


@dataclass
class Tally:
    """Work seen in a transcript: counted actions and script files that were newly created."""

    actions: int = 0
    new_files: int = 0


def is_work(block: dict) -> bool:
    """True for a tool call that changes something or delegates work."""
    if block.get("type") != "tool_use":
        return False
    name = block.get("name", "")
    if name in WORK_TOOLS or name.startswith("mcp__"):
        return True
    return name == "Bash" and "git commit" in str((block.get("input") or {}).get("command", ""))


def result_text(block: dict) -> str:
    """Text of a tool_result block, whether its content is a string or a list of parts."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def blocks(transcript: Path):
    """Yield every content block in a JSONL transcript, skipping unreadable lines."""
    with transcript.open(encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = record.get("message", record) if isinstance(record, dict) else {}
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, list):
                yield from (b for b in content if isinstance(b, dict))


def tally(transcript_path: str) -> Tally:
    """Count work in the transcript. A script file counts once, and only when its Write succeeded."""
    result = Tally()
    path = Path(transcript_path) if transcript_path else None
    if not path or not path.exists():
        return result
    writes: dict[str, str] = {}
    created: set[str] = set()
    try:
        for block in blocks(path):
            result.actions += is_work(block)
            if block.get("type") == "tool_use" and block.get("name") == "Write":
                target = str((block.get("input") or {}).get("file_path", ""))
                if SCRIPT_PATH.search(target):
                    writes[block.get("id", "")] = target
            elif block.get("type") == "tool_result" and not block.get("is_error"):
                target = writes.get(block.get("tool_use_id", ""))
                if target and CREATED in result_text(block):
                    created.add(target)
    except OSError:
        pass
    result.new_files = len(created)
    return result


def marker(session_id: str) -> Path:
    """The once-per-session marker file."""
    return reflect_state.state_dir() / "markers" / f"{reflect_state.safe_session_id(session_id)}.mark"


def prune_state(ttl_days: int) -> None:
    """Remove expired markers and queues."""
    root = reflect_state.state_dir()
    for folder, pattern in (("markers", "*.mark"), ("queue", "*.jsonl")):
        reflect_state.prune(root / folder, (pattern,), ttl_days)


def suggestion(seen: Tally, queued: int) -> str:
    """The message shown to the user."""
    parts = [f"{seen.actions} actions"]
    if seen.new_files:
        parts.append(f"{seen.new_files} new script file(s)")
    if queued:
        parts.append(f"{queued} correction cue(s)")
    return f"This session has work worth keeping ({', '.join(parts)}). Run {COMMAND} to turn it into skill, AGENTS.md or memory updates."


def main() -> int:
    """Handle one hook event."""
    data = reflect_state.read_hook_input()
    session_id = data.get("session_id", "")
    ttl_days = int(os.environ.get("SESSION_SELF_IMPROVE_TTL_DAYS", "7"))

    if data.get("hook_event_name") == "SessionEnd":
        try:
            marker(session_id).unlink(missing_ok=True)
        except OSError:
            pass
        prune_state(ttl_days)
        return 0
    if data.get("stop_hook_active"):
        return 0
    once = os.environ.get("SESSION_SELF_IMPROVE_REMIND_ONCE", "1") == "1"
    if once and marker(session_id).exists():
        return 0

    seen = tally(data.get("transcript_path", ""))
    queued = reflect_state.queue_depth(session_id)
    threshold = int(os.environ.get("SESSION_SELF_IMPROVE_MIN_ACTIONS", "3"))
    if seen.actions < threshold and not queued and not seen.new_files:
        return 0

    print(json.dumps({"systemMessage": suggestion(seen, queued), "suppressOutput": True}))
    if once:
        try:
            marker(session_id).parent.mkdir(parents=True, exist_ok=True)
            marker(session_id).write_text("shown\n", encoding="utf-8")
        except OSError:
            pass
    prune_state(ttl_days)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"session-self-improve reminder error: {exc}", file=sys.stderr)
        sys.exit(0)
