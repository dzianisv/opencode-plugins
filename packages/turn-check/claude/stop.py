#!/usr/bin/env python3
"""Stop hook: start a detached audit of the finished turn and return at once."""

import os
import subprocess
import sys
from pathlib import Path

import state

AUDIT = Path(__file__).resolve().parent / "audit.py"


def should_audit(data: dict) -> bool:
    """False when the hook is disabled, runs inside the judge, repeats a Stop, or has no transcript."""
    if os.environ.get("SUPERVISOR_ENABLED") == "0" or os.environ.get("SUPERVISOR_CHILD") == "1":
        return False
    if data.get("stop_hook_active"):
        return False
    transcript = data.get("transcript_path")
    return isinstance(transcript, str) and os.path.isfile(transcript)


def main() -> int:
    """Spawn the audit child in its own session so the hook does not wait for it."""
    data = state.read_hook_input()
    if not should_audit(data):
        return 0
    session_id = state.safe_session_id(data.get("session_id"))
    subprocess.Popen(
        [sys.executable, str(AUDIT), session_id, data["transcript_path"]],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        sys.exit(0)
