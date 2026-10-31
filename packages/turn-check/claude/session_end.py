#!/usr/bin/env python3
"""SessionEnd hook: delete this session's files, keeping a live audit's lock, and prune week-old leftovers."""

import sys

import state


def main() -> int:
    """Clean up after the session that just ended."""
    data = state.read_hook_input()
    session_id = data.get("session_id")
    lock = state.lock_path(session_id)
    if state.lock_is_stale(lock):
        for path in (lock, state.rerun_path(session_id), state.audited_path(session_id)):
            state.remove(path)
    root = state.state_dir()
    state.prune(root / "pending", "*.txt", state.PRUNE_DAYS)
    state.prune(root / "state", "*.json", state.PRUNE_DAYS)
    state.prune(root / "locks", "*.guard", state.PRUNE_DAYS)
    state.prune_log(root / "audits.jsonl", state.LOG_PRUNE_DAYS)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        sys.exit(0)
