#!/usr/bin/env python3
"""UserPromptSubmit hook: hand the agent the pending audit feedback once, then delete it."""

import json
import sys

import state


def count_violations(feedback: str) -> int:
    """Number of bullet lines in the feedback text."""
    return sum(1 for line in feedback.splitlines() if line.startswith("- "))


def main() -> int:
    """Print the hook output for this session's pending feedback."""
    data = state.read_hook_input()
    path = state.pending_path(data.get("session_id"))
    try:
        feedback = path.read_text(encoding="utf-8").strip()
    except OSError:
        return 0
    state.remove(path)
    if not feedback:
        return 0
    print(json.dumps({
        "systemMessage": f"supervisor: {count_violations(feedback)} rule violation(s) from your last turn",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": f"<system-reminder>\n{feedback}\n</system-reminder>",
        },
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        sys.exit(0)
