# OpenCode Plugins

[![Tests](https://github.com/dzianisv/opencode-reflection-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/dzianisv/opencode-reflection-plugin/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenCode](https://img.shields.io/badge/OpenCode-v1.0+-blue.svg)](https://github.com/sst/opencode)

**Make your AI coding assistant actually finish the job.** Self-reflection and task verification for [OpenCode](https://github.com/sst/opencode) - the open-source AI coding agent.

## The Problem

AI coding assistants often:
- Stop before the task is truly complete
- Miss edge cases or skip steps
- Say "done" when tests are failing
- Require constant human supervision

## The Solution

This plugin adds a **judge layer** that automatically evaluates task completion and forces the agent to continue until the work is actually done. Plus, get notified on Telegram when long-running tasks finish - and reply back via text or voice.

| Plugin | Description |
|--------|-------------|
| **reflection.ts** | Judge layer that verifies task completion and forces agent to continue if incomplete |
| **tts.ts** | Text-to-speech + Telegram notifications with two-way communication |

### Key Features

- **Automatic task verification** - Judge evaluates completion after each agent response
- **Self-healing workflow** - Agent receives feedback and continues if work is incomplete
- **Telegram notifications** - Get notified when tasks finish, reply via text or voice
- **Local TTS** - Hear responses read aloud (Coqui XTTS, Chatterbox, macOS)
- **Voice-to-text** - Reply to Telegram with voice messages, transcribed by local Whisper

## Quick Install

```bash
# Install plugins
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts

# Install required dependencies
cat > ~/.config/opencode/package.json << 'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.36",
    "@supabase/supabase-js": "^2.49.0"
  }
}
EOF
cd ~/.config/opencode && bun install
```

Then restart OpenCode.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OpenCode Plugins                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐   │
│  │  reflection.ts   │    │     tts.ts       │    │   Supabase Backend   │   │
│  │                  │    │                  │    │                      │   │
│  │ • Judge layer    │    │ • Local TTS      │◄──►│ • Edge Functions     │   │
│  │ • Task verify    │    │ • Telegram notif │    │ • PostgreSQL + RLS   │   │
│  │ • Auto-continue  │    │ • Voice replies  │    │ • Realtime subscr.   │   │
│  └──────────────────┘    │ • Whisper STT    │    └──────────────────────┘   │
│                          └──────────────────┘                                │
│                                   │                                          │
│                    ┌──────────────┴──────────────┐                          │
│                    ▼                              ▼                          │
│           ┌──────────────┐              ┌──────────────┐                    │
│           │ TTS Engines  │              │ Telegram Bot │                    │
│           │              │              │              │                    │
│           │ • Coqui XTTS │              │ • Outbound   │                    │
│           │ • Chatterbox │              │ • Text reply │                    │
│           │ • macOS say  │              │ • Voice msg  │                    │
│           └──────────────┘              └──────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Reflection Plugin

Evaluates task completion after each agent response and provides feedback if work is incomplete.

### How It Works

1. **Trigger**: `session.idle` event fires when agent finishes responding
2. **Context Collection**: Extracts task, AGENTS.md, tool calls, agent output
3. **Judge Session**: Creates separate hidden session for unbiased evaluation
4. **Verdict**: PASS → toast notification | FAIL → feedback injected into chat
5. **Continuation**: Agent receives feedback and continues working

### Features

- Automatic trigger on session idle
- Rich context (task, AGENTS.md, last 10 tool calls, response)
- Non-blocking async evaluation with polling (supports slow models like Opus 4.5)
- Max 3 attempts per task to prevent loops
- Infinite loop prevention (skips judge sessions)

### Configuration

Constants in `reflection.ts`:
```typescript
const MAX_ATTEMPTS = 3           // Max reflection attempts per task
const JUDGE_RESPONSE_TIMEOUT = 180_000  // 3 min timeout for judge
const POLL_INTERVAL = 2_000      // Poll every 2s
```

---

## TTS Plugin

Text-to-speech with Telegram integration for remote notifications and two-way communication.

### TTS Engines

| Engine | Quality | Speed | Setup |
|--------|---------|-------|-------|
| **Coqui XTTS v2** | Excellent | 2-5s | Auto-installed, Python 3.9+ |
| **Chatterbox** | Excellent | 2-5s | Auto-installed, Python 3.11 |
| **macOS say** | Good | Instant | None |

### Configuration

`~/.config/opencode/tts.json`:

```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "xtts_v2",
    "device": "mps",
    "serverMode": true
  },
  "telegram": {
    "enabled": true,
    "uuid": "<your-uuid>",
    "sendText": true,
    "sendVoice": true,
    "receiveReplies": true
  }
}
```

### Toggle Commands

```
/tts        Toggle on/off
/tts on     Enable
/tts off    Disable
```

---

## Telegram Integration

Two-way communication: receive notifications when tasks complete, reply via text or voice.

### Message Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OUTBOUND (Task Complete)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OpenCode ──► TTS Plugin ──► Supabase Edge ──► Telegram API ──► User        │
│     │              │         (send-notify)                                   │
│     │              │                                                         │
│     │         ┌────┴────┐                                                    │
│     │         │ Convert │  WAV → OGG (ffmpeg)                               │
│     │         │ audio   │                                                    │
│     │         └─────────┘                                                    │
│     │                                                                        │
│  Stores reply context (session_id, uuid) in telegram_reply_contexts table   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         INBOUND (User Reply)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TEXT REPLY:                                                                 │
│  User ──► Telegram ──► Webhook ──► telegram_replies table                   │
│                        (Edge Fn)           │                                 │
│                                            │ Supabase Realtime              │
│                                            ▼                                 │
│                                      TTS Plugin ──► OpenCode Session        │
│                                                     (promptAsync)            │
│                                                                              │
│  VOICE REPLY:                                                                │
│  User ──► Telegram ──► Webhook ──► Download audio ──► telegram_replies      │
│           (voice)     (Edge Fn)    (base64)                │                 │
│                                                            │ Realtime       │
│                                                            ▼                 │
│                                    TTS Plugin ──► Whisper STT ──► OpenCode  │
│                                    (local)        (transcribe)               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Setup

1. **Generate UUID:**
   ```bash
   uuidgen | tr '[:upper:]' '[:lower:]'
   ```

2. **Subscribe via Telegram:**
   - Open [@OpenCodeMgrBot](https://t.me/OpenCodeMgrBot)
   - Send: `/start <your-uuid>`

3. **Configure plugin** (`~/.config/opencode/tts.json`):
   ```json
   {
     "telegram": {
       "enabled": true,
       "uuid": "<your-uuid>",
       "receiveReplies": true
     }
   }
   ```

4. **Install ffmpeg** (for voice messages):
   ```bash
   brew install ffmpeg
   ```

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start <uuid>` | Subscribe with your UUID |
| `/stop` | Unsubscribe |
| `/status` | Check subscription |

---

## Supabase Backend

All backend code is in `supabase/` - self-hostable.

### Database Schema

```sql
-- Maps UUID → Telegram chat_id
telegram_subscribers (
  uuid UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  notifications_sent INTEGER DEFAULT 0
)

-- Stores reply context for two-way communication
telegram_reply_contexts (
  id UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  is_active BOOLEAN DEFAULT TRUE
)

-- Incoming replies (text and voice)
telegram_replies (
  id UUID PRIMARY KEY,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,
  reply_text TEXT,           -- NULL for voice before transcription
  is_voice BOOLEAN DEFAULT FALSE,
  audio_base64 TEXT,         -- Base64 audio for voice messages
  voice_file_type TEXT,      -- 'voice', 'video_note', 'video'
  voice_duration_seconds INTEGER,
  processed BOOLEAN DEFAULT FALSE
)
```

### Edge Functions

| Function | Purpose | Auth |
|----------|---------|------|
| `telegram-webhook` | Handles Telegram updates, stores replies | No JWT (Telegram calls it) |
| `send-notify` | Receives notifications from plugin | JWT optional |

### RLS Policies

```sql
-- Service role: full access (Edge Functions)
-- Anon role: SELECT for realtime, UPDATE via RPC

-- Secure function for marking replies processed
CREATE FUNCTION mark_reply_processed(p_reply_id UUID)
RETURNS BOOLEAN
SECURITY DEFINER  -- Bypasses RLS
```

### Realtime

Plugin subscribes to `telegram_replies` table changes:
```typescript
supabase.channel('telegram_replies')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public', 
    table: 'telegram_replies',
    filter: `uuid=eq.${uuid}`
  }, handler)
```

### Self-Hosting

```bash
# 1. Link to your Supabase project
supabase link --project-ref <your-project>

# 2. Push migrations
supabase db push

# 3. Deploy functions
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy send-notify

# 4. Set secrets
supabase secrets set TELEGRAM_BOT_TOKEN=<token>

# 5. Configure webhook
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.supabase.co/functions/v1/telegram-webhook"

# 6. Update tts.json with your serviceUrl
```

---

## Whisper STT

Local speech-to-text for voice message transcription.

### How It Works

1. Telegram voice message received by webhook
2. Audio downloaded and stored as base64 in `telegram_replies`
3. Plugin receives via Supabase Realtime
4. Local Whisper server transcribes audio
5. Transcribed text forwarded to OpenCode session

### Server

Auto-started on first voice message:
- Location: `~/.config/opencode/opencode-helpers/whisper/`
- Port: 8787 (configurable)
- Model: `base` by default (configurable)

### Configuration

```json
{
  "whisper": {
    "enabled": true,
    "model": "base",
    "device": "auto",
    "port": 8787
  }
}
```

---

## File Locations

```
~/.config/opencode/
├── package.json              # Plugin dependencies (bun install)
├── opencode.json             # OpenCode config
├── tts.json                  # TTS + Telegram config
├── plugin/
│   ├── reflection.ts         # Reflection plugin
│   └── tts.ts                # TTS plugin
├── node_modules/             # Dependencies (@supabase/supabase-js)
└── opencode-helpers/
    ├── coqui/                # Coqui TTS server
    │   ├── venv/
    │   ├── tts.sock
    │   └── server.pid
    ├── chatterbox/           # Chatterbox TTS server
    │   ├── venv/
    │   ├── tts.sock
    │   └── server.pid
    └── whisper/              # Whisper STT server
        ├── venv/
        ├── whisper_server.py
        └── server.pid
```

---

## Development

```bash
# Clone
git clone https://github.com/dzianisv/opencode-reflection-plugin
cd opencode-reflection-plugin

# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Deploy to local OpenCode
npm run install:global
```

### Testing

```bash
# Unit tests
npm test

# E2E tests (requires OpenCode server)
OPENCODE_E2E=1 npm run test:e2e

# Manual TTS test
npm run test:tts:manual
```

---

## Requirements

- OpenCode v1.0+
- **TTS**: macOS (for `say`), Python 3.9+ (Coqui), Python 3.11 (Chatterbox)
- **Telegram voice**: ffmpeg (`brew install ffmpeg`)
- **Dependencies**: `bun` (OpenCode installs deps from package.json)

## Why Use This?

| Without Reflection Plugin | With Reflection Plugin |
|--------------------------|------------------------|
| Agent says "done" but tests fail | Agent runs tests, sees failures, fixes them |
| You manually check every response | Automatic verification after each response |
| Context switching interrupts your flow | Get notified on Telegram, reply hands-free |
| Agent stops at first attempt | Up to 3 self-correction attempts |
| Hope it worked | Know it worked |

## Related Projects

- [OpenCode](https://github.com/sst/opencode) - Open-source AI coding agent (required)
- [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code) - Anthropic's AI coding assistant
- [Cursor](https://cursor.sh/) - AI-powered code editor

## Keywords

`opencode` `ai-coding-assistant` `llm-agent` `task-verification` `self-reflection` `autonomous-coding` `telegram-bot` `text-to-speech` `whisper` `developer-tools` `productivity` `ai-automation`

## Contributing

Contributions welcome! Please read the [AGENTS.md](AGENTS.md) for development guidelines.

## License

MIT

---

<p align="center">
  <sub>Built for developers who want their AI to finish the job.</sub>
</p>
