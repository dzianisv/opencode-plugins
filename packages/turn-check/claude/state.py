"""State directory, session files, lock and audit log used by the supervisor Claude Code hooks."""

import fcntl
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PRUNE_DAYS = 7
LOG_PRUNE_DAYS = 30
LOCK_STALE_SECONDS = 600


def state_dir() -> Path:
    """Where pending notes, locks and the audit log live; SUPERVISOR_HOME moves it (used by the tests)."""
    return Path(os.environ.get("SUPERVISOR_HOME", "~/.cache/supervisor")).expanduser()


def ensure_dir(path: Path) -> None:
    """Create a state directory and its root with mode 0700."""
    for directory in (state_dir(), path):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)


def write_private(path: Path, text: str, flags: int = os.O_WRONLY | os.O_CREAT | os.O_TRUNC) -> None:
    """Write text to a file that is created with mode 0600 and tightened to 0600 if it already exists."""
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        os.fchmod(fh.fileno(), 0o600)
        fh.write(text)


def safe_session_id(raw) -> str:
    """Keep only characters that are safe in a file name."""
    return re.sub(r"[^A-Za-z0-9_-]", "", raw if isinstance(raw, str) else "") or "unknown"


def session_file(kind: str, session_id: str, suffix: str) -> Path:
    """Path of one per-session file, for example pending/<id>.txt."""
    return state_dir() / kind / f"{safe_session_id(session_id)}{suffix}"


def pending_path(session_id: str) -> Path:
    """Feedback waiting to be delivered on the next prompt."""
    return session_file("pending", session_id, ".txt")


def lock_path(session_id: str) -> Path:
    """Marks a running audit."""
    return session_file("locks", session_id, ".lock")


def rerun_path(session_id: str) -> Path:
    """Marks that a Stop arrived while an audit was running."""
    return session_file("locks", session_id, ".rerun")


def audited_path(session_id: str) -> Path:
    """Holds the uuid of the last message with a valid verdict."""
    return session_file("state", session_id, ".json")


def read_hook_input() -> dict:
    """The JSON object Claude Code sends on stdin, or {} when it is absent or not an object."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def remove(path: Path) -> None:
    """Delete a file, ignoring a missing one."""
    try:
        path.unlink()
    except OSError:
        pass


def write_atomic(path: Path, text: str) -> None:
    """Write text so a reader never sees a half-written file."""
    ensure_dir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    write_private(tmp, text)
    os.replace(tmp, path)


def pid_alive(pid: int) -> bool:
    """True when a process with this pid exists."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def lock_is_stale(path: Path) -> bool:
    """A lock is stale when its owner is gone or it is older than LOCK_STALE_SECONDS."""
    try:
        age = time.time() - path.stat().st_mtime
        pid = int(path.read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        return True
    return age > LOCK_STALE_SECONDS or not pid_alive(pid)


def acquire_lock(session_id: str) -> bool:
    """Take the session lock; False when a live audit holds it. Check, stale removal and creation run under a flock guard."""
    path = lock_path(session_id)
    ensure_dir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    write_private(tmp, str(os.getpid()))
    try:
        with os.fdopen(os.open(path.with_suffix(".guard"), os.O_WRONLY | os.O_CREAT, 0o600), "w") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            if path.exists() and not lock_is_stale(path):
                return False
            remove(path)
            os.link(tmp, path)
            return True
    finally:
        remove(tmp)


def release_lock(session_id: str) -> None:
    """Drop the session lock if this process still owns it."""
    path = lock_path(session_id)
    try:
        owner = int(path.read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        return
    if owner == os.getpid():
        remove(path)


def set_rerun(session_id: str) -> None:
    """Ask the running audit to go again when it finishes."""
    path = rerun_path(session_id)
    ensure_dir(path.parent)
    write_private(path, "")


def take_rerun(session_id: str) -> bool:
    """True once if a rerun was requested; clears the flag."""
    path = rerun_path(session_id)
    if not path.exists():
        return False
    remove(path)
    return True


def last_audited(session_id: str) -> str:
    """Uuid of the last audited message, or an empty string."""
    try:
        data = json.loads(audited_path(session_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return data.get("messageID", "") if isinstance(data, dict) else ""


def mark_audited(session_id: str, message_id: str) -> None:
    """Remember the last message that got a valid verdict."""
    write_atomic(audited_path(session_id), json.dumps({"messageID": message_id}))


def record(entry: dict) -> None:
    """Append one line to the audit log. Never raises."""
    try:
        path = state_dir() / "audits.jsonl"
        ensure_dir(path.parent)
        line = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), **entry}
        write_private(path, json.dumps(line) + "\n", os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    except OSError:
        pass


def prune(directory: Path, pattern: str, ttl_days: int) -> None:
    """Delete files in directory that match pattern and have not changed for ttl_days."""
    oldest_kept = time.time() - ttl_days * 86400
    for path in directory.glob(pattern):
        try:
            if path.stat().st_mtime < oldest_kept:
                path.unlink()
        except OSError:
            continue


def log_entry_is_recent(line: str, oldest_kept: float) -> bool:
    """True when the JSONL line parses and its time is not older than oldest_kept (epoch seconds)."""
    try:
        stamp = json.loads(line)["time"]
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() >= oldest_kept
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def prune_log(path: Path, ttl_days: int = LOG_PRUNE_DAYS, now: float = None) -> None:
    """Rewrite the audit log without entries older than ttl_days and without corrupt lines; leaves it alone when nothing changes."""
    oldest_kept = (time.time() if now is None else now) - ttl_days * 86400
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        kept = [line for line in text.splitlines() if line.strip() and log_entry_is_recent(line, oldest_kept)]
        out = "".join(line + "\n" for line in kept)
        if out == text:
            return
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        write_private(tmp, out)
        os.replace(tmp, path)
    except OSError:
        pass
