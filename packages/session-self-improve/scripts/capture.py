#!/usr/bin/env python3
"""UserPromptSubmit hook: note when a prompt reads like a correction or a standing rule."""

import json
import os
import sys
from datetime import datetime, timezone

import reflect_state

CUES = {
    "correction": (
        "not what i asked", "not like that", "you should have", "should have used", "instead of",
        "stop using", "stop doing", "don't use", "do not use", "no, use", "no, do",
        "that's not right", "that is not right", "wrong approach",
    ),
    "rule": (
        "from now on", "going forward", "next time", "every time", "always use", "always run",
        "never use", "never run", "make sure you always",
    ),
    "failure": (
        "didn't work", "did not work", "doesn't work", "still failing", "still broken",
        "still wrong", "same error", "you broke",
    ),
    "approval": ("that works", "looks good", "nice, now", "this is what i wanted"),
}
STRENGTH = {"correction": 0.8, "rule": 0.8, "failure": 0.6, "approval": 0.4}
RECORD_FROM = 0.6


def normalise(prompt: str) -> str:
    """Lowercase, straighten curly apostrophes and collapse whitespace."""
    return " ".join(prompt.lower().replace("’", "'").split())


def find_cues(prompt: str) -> dict[str, float]:
    """Return each cue kind present in the prompt with its strength."""
    text = normalise(prompt)
    return {kind: STRENGTH[kind] for kind, phrases in CUES.items() if any(p in text for p in phrases)}


def confidence(found: dict[str, float]) -> float:
    """Strongest cue; two different kinds together add 0.1, capped at 0.9."""
    if not found:
        return 0.0
    return round(min(0.9, max(found.values()) + (0.1 if len(found) > 1 else 0.0)), 2)


def enqueue(session_id: str, record: dict, limit: int) -> None:
    """Add a record to the session queue unless it already holds `limit` records."""
    if reflect_state.queue_depth(session_id) >= limit:
        return
    path = reflect_state.queue_path(session_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except OSError:
        pass


def main() -> int:
    """Queue a pointer record when the prompt carries a cue."""
    if os.environ.get("SESSION_SELF_IMPROVE_CAPTURE", "1") != "1":
        return 0
    data = reflect_state.read_hook_input()
    prompt = data.get("prompt", "")
    if not isinstance(prompt, str) or not prompt.strip() or prompt.lstrip().startswith("/"):
        return 0
    found = find_cues(prompt)
    score = confidence(found)
    if score < RECORD_FROM:
        return 0
    session_id = reflect_state.safe_session_id(data.get("session_id", ""))
    enqueue(
        session_id,
        {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "session_id": session_id,
            "cwd": data.get("cwd", ""),
            "transcript_path": data.get("transcript_path", ""),
            "kinds": sorted(found, key=found.get, reverse=True),
            "confidence": score,
        },
        int(os.environ.get("SESSION_SELF_IMPROVE_QUEUE_MAX", "200")),
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"session-self-improve capture error: {exc}", file=sys.stderr)
        sys.exit(0)
