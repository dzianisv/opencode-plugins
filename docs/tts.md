# TTS Plugin

## Overview

The TTS (Text-to-Speech) plugin reads agent responses aloud when sessions complete. It supports three engines: Coqui TTS (neural, recommended), Chatterbox (neural with voice cloning), and OS TTS (macOS `say` command, instant fallback).

Multiple concurrent OpenCode sessions are coordinated via a file-based speech queue so only one session speaks at a time.

## Architecture

```
OpenCode Sessions (multiple)
  ├── Session 1 (tts.ts plugin)
  ├── Session 2 (tts.ts plugin)
  └── Session 3 (tts.ts plugin)
          │
          ▼
  Speech Queue (FS-based FIFO)
  ~/.config/opencode/speech-queue/*.ticket
  ~/.config/opencode/speech.lock
          │
          ▼
  Unix Socket IPC
  ~/.config/opencode/opencode-helpers/coqui/tts.sock
          │
          ▼
  Python TTS Server (single process, model stays loaded)
  tts_server.py → Coqui TTS (VCTK VITS, 109 speakers)
          │
          ▼
  .wav file → afplay (macOS)
```

## Components

### 1. TypeScript Plugin (`tts.ts`)

Runs inside each OpenCode session:
- Listens for `session.idle` events
- Extracts and cleans the final assistant response (strips markdown, code blocks, URLs)
- Queues speech requests via file-based FIFO
- Communicates with Python server via Unix socket
- Plays generated audio via `afplay`
- Falls back to OS TTS if Coqui is unavailable or synthesis fails

### 2. Speech Queue

File-based FIFO ensures only one session speaks at a time.

**Location:** `~/.config/opencode/speech-queue/`

**Flow:**
1. Speech request creates a ticket file with timestamp
2. Process polls until its ticket is oldest (first in queue)
3. Process acquires `speech.lock`, speaks, then releases lock and removes ticket
4. Stale tickets (>2 minutes) are auto-cleaned

### 3. Python TTS Server (`tts_server.py`)

Single persistent process that keeps the TTS model loaded for fast inference.

**Location:** `~/.config/opencode/opencode-helpers/coqui/`

**Files:**
- `tts_server.py` — Server script
- `tts.py` — One-shot synthesis script
- `tts.sock` — Unix socket for IPC
- `server.pid` — Running server PID
- `server.lock` — Startup lock (prevents duplicate servers)
- `venv/` — Python virtualenv with Coqui TTS + PyTorch

**Protocol (JSON over Unix socket):**
```json
// Request
{"text": "Hello world", "output": "/tmp/tts_12345.wav", "speaker": "p226"}

// Response
{"success": true, "output": "/tmp/tts_12345.wav"}
```

### 4. Coqui TTS (VCTK VITS)

**Model:** `tts_models/en/vctk/vits` (multi-speaker VITS)

- 109 speakers available (default: `p226`)
- Fast inference on MPS (Apple Silicon) and CPU
- Requires Python 3.10-3.12
- Requires `transformers<4.50` (pinned for API compatibility)

**Model location:** `~/Library/Application Support/tts/tts_models--en--vctk--vits/`

## Setup

```bash
# Full install: deploys plugin + installs Coqui Python deps
npm run install:tts

# Or manually:
cp tts.ts ~/.config/opencode/plugin/
bash scripts/setup-coqui.sh        # creates venv, installs TTS, verifies
bash scripts/setup-coqui.sh --force # recreates venv from scratch
```

The `setup-coqui.sh` script:
1. Finds Python 3.10-3.12 in PATH
2. Creates venv at `~/.config/opencode/opencode-helpers/coqui/venv/`
3. Installs `TTS`, `torch`, `transformers<4.50`
4. Verifies `from TTS.api import TTS` imports successfully
5. Runs a synthesis test with audio playback

## Configuration

**File:** `~/.config/opencode/tts.json`

```json
{
  "enabled": true,
  "engine": "coqui",
  "os": {
    "voice": "Samantha",
    "rate": 200
  },
  "coqui": {
    "model": "vctk_vits",
    "device": "mps",
    "speaker": "p226",
    "serverMode": true
  }
}
```

## Supported Engines

| Engine | Model | Speed | Quality | Notes |
|--------|-------|-------|---------|-------|
| `coqui` | `vctk_vits` | Fast | Good | 109 speakers, recommended |
| `coqui` | `vits` | Fast | Good | LJSpeech, single speaker |
| `coqui` | `jenny` | Medium | Good | Single speaker |
| `coqui` | `xtts_v2` | Slow | Excellent | Voice cloning support |
| `coqui` | `bark` | Slow | Good | Multilingual |
| `coqui` | `tortoise` | Very slow | Excellent | Highest quality |
| `chatterbox` | — | Medium | Excellent | Voice cloning |
| `os` | — | Instant | Robotic | macOS `say`, no setup |

## Fallback Behavior

When engine is set to `coqui`:
1. Checks if Coqui venv exists and TTS imports successfully
2. If not, attempts auto-install (once per session)
3. If install fails, logs `[TTS] Coqui setup failed: ...` with recovery instructions
4. Falls back to OS TTS (`say` command) so the user still hears something

Error messages always include: `Run: npm run install:tts`

## Data Flow

1. `session.idle` fires → plugin extracts final assistant response
2. Text cleaned (markdown, code blocks, URLs stripped)
3. Queue ticket created → waits for turn (FIFO)
4. Lock acquired → sends text to Coqui server via Unix socket
5. Server generates `.wav` → plugin plays via `afplay`
6. Lock released, ticket removed, `.wav` cleaned up
7. If Coqui fails at any step → falls back to OS TTS

## Server Management

```bash
# Check if server is running
cat ~/.config/opencode/opencode-helpers/coqui/server.pid

# Stop server (auto-restarts on next TTS request)
kill $(cat ~/.config/opencode/opencode-helpers/coqui/server.pid)

# Test server directly
echo '{"text": "Hello", "output": "/tmp/test.wav", "speaker": "p226"}' | \
  nc -U ~/.config/opencode/opencode-helpers/coqui/tts.sock && \
  afplay /tmp/test.wav
```

## Debugging

**Debug log:** `{project}/.tts-debug.log` — session events, speech timing, skip reasons

**Startup errors:** `[TTS]` prefixed messages in stderr — Coqui setup failures, missing Python, import errors

**Common issues:**

| Problem | Check |
|---------|-------|
| No sound at all | Is `enabled: true` in tts.json? Is engine set? |
| Coqui not working | `[TTS]` errors in stderr; run `npm run install:tts` |
| Overlapping speech | Check `~/.config/opencode/speech-queue/` for stuck tickets |
| Server won't start | Remove stale `server.lock`; check `server.pid` |
| Wrong voice | Change `speaker` in config (e.g., `p226`, `p256`, `p270`) |
