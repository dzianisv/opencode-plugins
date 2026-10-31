"""State directory and hook-input helpers used by the session-distill scripts."""

import itertools
import json
import os
import re
import sys
import time
from pathlib import Path


def state_dir() -> Path:
    """Where queues and markers live; SESSION_DISTILL_HOME moves it (used by the tests)."""
    return Path(os.environ.get("SESSION_DISTILL_HOME", "~/.claude/session-distill")).expanduser()


def safe_session_id(raw: str) -> str:
    """Keep only characters that are safe in a file name."""
    return re.sub(r"[^A-Za-z0-9_-]", "", raw or "") or "unknown"


def queue_path(session_id: str) -> Path:
    """File holding the cue records of one session."""
    return state_dir() / "queue" / f"{safe_session_id(session_id)}.jsonl"


def queue_depth(session_id: str) -> int:
    """Number of cue records queued for a session, 0 if there is no readable queue."""
    try:
        text = queue_path(session_id).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    return len([line for line in text.splitlines() if line.strip()])


def read_hook_input() -> dict:
    """The JSON object Claude Code sends on stdin, or {} when it is absent or not an object."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def prune(directory: Path, patterns: tuple[str, ...], ttl_days: int) -> None:
    """Delete files in directory that match any pattern and have not changed for ttl_days."""
    oldest_kept = time.time() - ttl_days * 86400
    matches = itertools.chain.from_iterable(directory.glob(p) for p in patterns)
    for path in matches:
        try:
            expired = path.stat().st_mtime < oldest_kept
            if expired:
                path.unlink()
        except OSError:
            continue
