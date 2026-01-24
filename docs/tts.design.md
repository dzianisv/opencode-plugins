# TTS Plugin Architecture

## Overview

The TTS (Text-to-Speech) plugin reads agent responses aloud when sessions complete. It uses a client-server architecture with file-based queuing to handle multiple concurrent OpenCode sessions.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenCode Sessions (multiple)                  │
├─────────────────────────────────────────────────────────────────┤
│  Session 1          Session 2          Session 3                │
│  ┌─────────┐        ┌─────────┐        ┌─────────┐              │
│  │ tts.ts  │        │ tts.ts  │        │ tts.ts  │              │
│  │ plugin  │        │ plugin  │        │ plugin  │              │
│  └────┬────┘        └────┬────┘        └────┬────┘              │
│       │                  │                  │                    │
│       └──────────────────┼──────────────────┘                    │
│                          │                                       │
│              ┌───────────▼───────────┐                          │
│              │   Speech Queue (FS)    │  ~/.config/opencode/    │
│              │   speech-queue/*.ticket│  speech.lock            │
│              └───────────┬───────────┘                          │
│                          │                                       │
│              ┌───────────▼───────────┐                          │
│              │   Unix Socket IPC      │                          │
│              │   ~/.config/opencode/  │                          │
│              │   coqui/tts.sock       │                          │
│              └───────────┬───────────┘                          │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                 Python TTS Server (single process)               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  tts_server.py                                             │ │
│  │  - Loads Jenny/XTTS model once at startup                  │ │
│  │  - Listens on Unix socket                                  │ │
│  │  - Receives JSON: {"text": "...", "output": "/tmp/x.wav"}  │ │
│  │  - Generates audio, writes to file                         │ │
│  │  - Returns JSON: {"success": true, "output": "/tmp/x.wav"} │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                    ┌─────────▼─────────┐                        │
│                    │   Coqui TTS       │                        │
│                    │   Jenny Model     │                        │
│                    │   (VITS)          │                        │
│                    └─────────┬─────────┘                        │
│                              │                                   │
│                    ┌─────────▼─────────┐                        │
│                    │   .wav file       │                        │
│                    └─────────┬─────────┘                        │
└──────────────────────────────┼──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                      Audio Playback                              │
│                    afplay (macOS)                                │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. TypeScript Plugin (`tts.ts`)

Runs inside each OpenCode session. Responsibilities:
- Listen for `session.idle` events
- Extract and clean final assistant response
- Queue speech requests (file-based FIFO)
- Communicate with Python server via Unix socket
- Play generated audio via `afplay`

### 2. Speech Queue (File-based)

Ensures multiple OpenCode sessions speak one at a time in FIFO order.

**Location:** `~/.config/opencode/speech-queue/`

**How it works:**
1. Each speech request creates a ticket file with timestamp
2. Process waits until its ticket is the oldest (first in queue)
3. Process acquires the lock, speaks, then releases lock and removes ticket
4. Stale tickets (older than 2 minutes) are auto-cleaned

**Files:**
- `~/.config/opencode/speech-queue/*.ticket` - Queue tickets (JSON)
- `~/.config/opencode/speech.lock` - Current speaker lock

### 3. Python TTS Server (`tts_server.py`)

Single persistent process that keeps the TTS model loaded for fast inference.

**Location:** `~/.config/opencode/opencode-helpers/coqui/`

**Files:**
- `tts_server.py` - Server script
- `tts.sock` - Unix socket for IPC
- `server.pid` - Running server PID
- `server.lock` - Startup lock (prevents multiple server instances)
- `venv/` - Python virtualenv with Coqui TTS

**Protocol:**
```
Request (JSON):
{
  "text": "Hello world",
  "output": "/tmp/tts_12345.wav",
  "language": "en"
}

Response (JSON):
{
  "success": true,
  "output": "/tmp/tts_12345.wav"
}
```

### 4. Coqui TTS / Jenny Model

**Model:** `tts_models/en/jenny/jenny` (VITS-based)

**Why Jenny:**
- Natural-sounding female voice
- Fast inference (VITS architecture)
- No GPU required (CPU is fast enough)
- Single-speaker (no voice cloning needed)

**Model location:** `~/Library/Application Support/tts/tts_models--en--jenny--jenny/`

## Data Flow

1. **Session completes** → `session.idle` event fires
2. **Plugin extracts response** → Cleans markdown, code blocks, URLs
3. **Creates queue ticket** → `~/.config/opencode/speech-queue/{timestamp}.ticket`
4. **Waits for turn** → Polls until ticket is first in queue
5. **Acquires lock** → Creates `speech.lock` with ownership info
6. **Sends to server** → JSON over Unix socket
7. **Server generates audio** → Writes to `/tmp/opencode_coqui_{timestamp}.wav`
8. **Plays audio** → `afplay {wav_file}`
9. **Releases lock** → Removes `speech.lock` and ticket file

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
    "model": "jenny",
    "device": "cpu",
    "language": "en",
    "serverMode": true
  }
}
```

## Supported Engines

| Engine | Description | Speed | Quality |
|--------|-------------|-------|---------|
| `coqui` (jenny) | Coqui TTS with Jenny model | Fast | Good |
| `coqui` (xtts_v2) | Coqui TTS with XTTS v2 | Slow | Excellent |
| `chatterbox` | Chatterbox neural TTS | Medium | Excellent |
| `os` | macOS `say` command | Instant | Robotic |

## Server Management

```bash
# Check if server is running
ps aux | grep tts_server

# Check server PID
cat ~/.config/opencode/opencode-helpers/coqui/server.pid

# Stop server
kill $(cat ~/.config/opencode/opencode-helpers/coqui/server.pid)

# Server auto-restarts on next TTS request

# View server logs
tail -f /tmp/tts_server.log

# Test server directly
echo '{"text": "Hello", "output": "/tmp/test.wav"}' | \
  nc -U ~/.config/opencode/opencode-helpers/coqui/tts.sock && \
  afplay /tmp/test.wav
```

## Debugging

**Debug log:** `{project}/.tts-debug.log`

Contains:
- `session.idle` events
- Message counts
- Session completion status
- Speech timing

**Common issues:**

1. **No sound** - Check if server is running, check `tts.sock` exists
2. **Overlapping speech** - Check queue tickets in `speech-queue/`
3. **Server won't start** - Check for stale `server.lock`, remove if needed
4. **Model download failed** - Remove model dir and restart server
