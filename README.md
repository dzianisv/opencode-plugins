# OpenCode Plugins
<img width="1428" height="926" alt="Screenshot 2026-02-08 at 09 13 26" src="https://github.com/user-attachments/assets/1f507538-be9e-43a4-a1da-cb328e8e1878" />
<img width="1472" height="972" alt="image" src="https://github.com/user-attachments/assets/40f3a752-4b84-4151-93f4-2614330ac653" />
@reflection-3.ts - push opencode agent to reflect on the task, useful for continuous interrupted runs
<img width="1019" height="734" alt="image" src="https://github.com/user-attachments/assets/6f120c14-dba5-431b-a458-0f51f360f561" />
@telegram.ts - integrates with Telegram over [t.me/OpencodeMgrBot](@OpenCodeMgrBot) bot
@tts.ts - uses coqui TTS to read the opencode agent response. Useful to run a few agents on macOS and be notified when one finishes a task. 


[![Tests](https://github.com/dzianisv/opencode-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/dzianisv/opencode-plugins/actions/workflows/test.yml)
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
| **reflection-3.ts** | Judge layer that verifies task completion and forces agent to continue if incomplete |
| **tts.ts** | Text-to-speech + Telegram notifications with two-way communication |
| **worktree-status.ts** | Git worktree status tool for checking dirty state, branch, and active sessions |

### Key Features

- **Automatic task verification** - Judge evaluates completion after each agent response
- **Self-healing workflow** - Agent receives feedback and continues if work is incomplete
- **Telegram notifications** - Get notified when tasks finish, reply via text or voice
- **Local TTS** - Hear responses read aloud (Coqui VCTK/VITS, Chatterbox, macOS)
- **Voice-to-text** - Reply to Telegram with voice messages, transcribed by local Whisper

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/install.sh | bash
```

This downloads all plugins to `~/.config/opencode/plugin/`, installs dependencies, and you're ready to go. Restart OpenCode to activate.

**Prerequisites:** [bun](https://bun.sh) (install with `curl -fsSL https://bun.sh/install | bash`)

<details>
<summary>Manual install</summary>

```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection-3.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/reflection-3.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/tts.ts && \
curl -fsSL -o ~/.config/opencode/plugin/telegram.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/telegram.ts && \
curl -fsSL -o ~/.config/opencode/plugin/worktree.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/worktree.ts

# Install required dependencies
cd ~/.config/opencode && \
  bun add @supabase/supabase-js@^2.49.0 && \
  bun install
```
</details>

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OpenCode Plugins                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐   │
│  │  reflection-3.ts │    │     tts.ts       │    │  worktree-status.ts  │   │
│  │                  │    │                  │    │                      │   │
│  │ • Judge layer    │    │ • Local TTS      │    │ • Git dirty check    │   │
│  │ • Task verify    │    │ • Whisper STT    │    │ • Branch status      │   │
│  │ • Auto-continue  │    │ • Telegram notif │    │ • Active sessions    │   │
│  └──────────────────┘    └────────┬─────────┘    └──────────────────────┘   │
│                                   │                                          │
│                    ┌──────────────┼──────────────┐                          │
│                    ▼              ▼              ▼                          │
│           ┌──────────────┐ ┌────────────┐ ┌──────────────────────┐          │
│           │ TTS Engines  │ │telegram.ts │ │   Supabase Backend   │          │
│           │              │ │  (helper)  │ │                      │          │
│           │ • Coqui XTTS │ │            │ │ • Edge Functions     │          │
│           │ • Chatterbox │ │ • Notifier │ │ • PostgreSQL + RLS   │          │
│           │ • macOS say  │ │ • Supabase │ │ • Realtime subscr.   │          │
│           └──────────────┘ └────────────┘ └──────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Note:** `telegram.ts` is a helper module (not a standalone plugin) that provides Telegram notification functions used by `tts.ts`.

---

## Reflection Plugin

Evaluates task completion after each agent response and provides feedback if work is incomplete.

### How It Works

1. **Trigger**: `session.idle` event fires when agent finishes responding
2. **Context Collection**: Extracts task, AGENTS.md, tool calls, agent output
3. **Judge Session**: Creates separate hidden session via OpenCode Sessions API for unbiased evaluation
4. **Verdict**: PASS → toast notification | FAIL → feedback injected into chat
5. **Continuation**: Agent receives feedback and continues working

### State Graph

```
session.idle fires
    |
    v
+---------------------------+
| GUARD CHECKS              |
| - Is judge/classifier?    |--yes--> SKIP
| - Is plan mode?           |--yes--> SKIP
| - Was ESC-aborted?        |--yes--> SKIP (10s cooldown)
| - Same user msg already   |--yes--> SKIP
|   reflected?              |
+----------+----------------+
           | no
           v
+---------------------------+
| A) BUILD TASK CONTEXT     |
| - Collect user messages   |
| - Infer task type         |
|   (coding/docs/research/  |
|    ops/other)             |
| - Detect repo signals     |
|   (package.json scripts,  |
|    test/ dir)             |
| - Extract tool commands   |
| - Determine workflow      |
|   requirements            |
+----------+----------------+
           v
+---------------------------+
| B) SELF-ASSESSMENT        |
| Request agent to produce  |
| JSON with evidence:       |
| - Did you complete task?  |
| - Did you run tests?      |
| - Did you create PR?      |
| - Did CI pass?            |
| - Are you stuck?          |
| (runs in ephemeral        |
|  session, not main)       |
+----------+----------------+
           v
+---------------------------+
| C) PARSE & EVALUATE      |
| Parse JSON --success--> evaluateSelfAssessment()
|            +--fail---> Judge LLM fallback
|                        |
| Workflow gate checks:  |
| 1. Tests ran? Passed?  |
|    Ran AFTER changes?  |
|    Not skipped/flaky?  |
| 2. Build ran? Passed?  |
| 3. PR created? URL?    |
|    Evidence (gh pr)?   |
| 4. CI checked? Passed? |
|    Evidence (gh pr     |
|    checks)?            |
| 5. No push to main?   |
| 6. Planning loop check |
+----------+----------------+
           v
+---------------------------+
| D) VERDICT                |
| Write .reflection/        |
|   verdict_<session>.json  |
|                           |
| Three outcomes:           |
| COMPLETE      --> Toast success, done
| NEEDS USER    --> Toast warning, done
| INCOMPLETE    --> Continue below
+----------+----------------+
           | incomplete
           v
+---------------------------+
| E) FEEDBACK + ROUTING     |
| - Classify task category  |
|   (backend/arch/frontend) |
| - Build escalating        |
|   feedback (attempt N/5)  |
| - Inject feedback into    |
|   session (optionally     |
|   with model routing)     |
| - Agent continues work    |
+---------------------------+
           |
           v
     (session.idle fires again --> loop back to top,
      up to MAX_ATTEMPTS=5)
```

### Features

- **OpenCode Sessions API**: Uses OpenCode's session management to create isolated judge sessions
- **Project-aware evaluation**: Reads `AGENTS.md` and skills to understand project-specific policies, testing requirements, and deployment rules
- **Rich context**: Task description, last 10 tool calls, agent response, and project guidelines
- Automatic trigger on session idle
- Non-blocking async evaluation with polling (supports slow models like Opus 4.5)
- Max 16 attempts per task to prevent loops
- Infinite loop prevention (skips judge sessions)
- Auto-reset counter when user provides new feedback

### Configuration

Constants in `reflection-3.ts`:
```typescript
const MAX_ATTEMPTS = 16          // Max reflection attempts per task (auto-resets on new user feedback)
const JUDGE_RESPONSE_TIMEOUT = 180_000  // 3 min timeout for judge
const POLL_INTERVAL = 2_000      // Poll every 2s
const STUCK_CHECK_DELAY = 30_000 // Check if agent stuck 30s after reflection feedback
const STUCK_NUDGE_DELAY = 15_000 // Nudge agent 15s after compression
```

### Judge Context

The judge session receives:
- **User's original task** - What was requested
- **AGENTS.md content** (first 1500 chars) - Project-specific policies, testing requirements, deployment checklist, and development workflows
- **Last 10 tool calls** - What actions the agent took
- **Agent's final response** (first 2000 chars) - What the agent reported

This allows the judge to verify compliance with project-specific rules defined in `AGENTS.md` and related skills, such as:
- Required testing procedures
- Build/deployment steps
- Code quality standards
- Security policies
- Documentation requirements

---

## TTS Plugin

Text-to-speech with Telegram integration for remote notifications and two-way communication.

### TTS Engines

| Engine | Quality | Speed | Setup |
|--------|---------|-------|-------|
| **Coqui TTS** | Excellent | Fast-Medium | Auto-installed, Python 3.9-3.11 |
| **Chatterbox** | Excellent | 2-5s | Auto-installed, Python 3.11 |
| **macOS say** | Good | Instant | None |

### Coqui TTS Models

| Model | Description | Multi-Speaker | Speed |
|-------|-------------|---------------|-------|
| `vctk_vits` | VCTK VITS (109 speakers, **recommended**) | Yes (p226 default) | Fast |
| `vits` | LJSpeech single speaker | No | Fast |
| `jenny` | Jenny voice | No | Medium |
| `xtts_v2` | XTTS v2 with voice cloning | Yes (via voiceRef) | Slower |
| `bark` | Multilingual neural TTS | No | Slower |
| `tortoise` | Very high quality | No | Very slow |

**Recommended**: `vctk_vits` with speaker `p226` (clear, professional British male voice)

### VCTK Speakers (vctk_vits model)

The VCTK corpus contains 109 speakers with various English accents. Speaker IDs are in format `pXXX`.

**Popular speaker choices:**

| Speaker | Gender | Accent | Description |
|---------|--------|--------|-------------|
| `p226` | Male | English | Clear, professional (recommended) |
| `p225` | Female | English | Clear, neutral |
| `p227` | Male | English | Deep voice |
| `p228` | Female | English | Warm tone |
| `p229` | Female | English | Higher pitch |
| `p230` | Female | English | Soft voice |
| `p231` | Male | English | Standard |
| `p232` | Male | English | Casual |
| `p233` | Female | Scottish | Scottish accent |
| `p234` | Female | Scottish | Scottish accent |
| `p236` | Female | English | Professional |
| `p237` | Male | Scottish | Scottish accent |
| `p238` | Female | N. Irish | Northern Irish |
| `p239` | Female | English | Young voice |
| `p240` | Female | English | Mature voice |
| `p241` | Male | Scottish | Scottish accent |
| `p243` | Male | English | Deep, authoritative |
| `p244` | Female | English | Bright voice |
| `p245` | Male | Irish | Irish accent |
| `p246` | Male | Scottish | Scottish accent |
| `p247` | Male | Scottish | Scottish accent |
| `p248` | Female | Indian | Indian English |
| `p249` | Female | Scottish | Scottish accent |
| `p250` | Female | English | Standard |
| `p251` | Male | Indian | Indian English |

<details>
<summary>All 109 VCTK speakers</summary>

```
p225, p226, p227, p228, p229, p230, p231, p232, p233, p234,
p236, p237, p238, p239, p240, p241, p243, p244, p245, p246,
p247, p248, p249, p250, p251, p252, p253, p254, p255, p256,
p257, p258, p259, p260, p261, p262, p263, p264, p265, p266,
p267, p268, p269, p270, p271, p272, p273, p274, p275, p276,
p277, p278, p279, p280, p281, p282, p283, p284, p285, p286,
p287, p288, p292, p293, p294, p295, p297, p298, p299, p300,
p301, p302, p303, p304, p305, p306, p307, p308, p310, p311,
p312, p313, p314, p316, p317, p318, p323, p326, p329, p330,
p333, p334, p335, p336, p339, p340, p341, p343, p345, p347,
p351, p360, p361, p362, p363, p364, p374, p376, ED
```

</details>

### Tortoise TTS Voices

Tortoise is a high-quality multi-speaker model. Specify the voice name in the `speaker` field.

**Available voices:**
`angie`, `applejack`, `daniel`, `deniro`, `emma`, `freeman`, `geralt`, `halle`, `jlaw`, `lj`, `mol`, `myself`, `pat`, `pat2`, `rainbow`, `snakes`, `tim_reynolds`, `tom`, `train_docks`, `weaver`, `william`

### Bark TTS Speakers

Bark is a multilingual model. Specify the speaker ID in the `speaker` field.

**English speakers:**
`v2/en_speaker_0` through `v2/en_speaker_9`

**Other languages:**
Replace `en` with language code (e.g., `v2/de_speaker_0`, `v2/fr_speaker_0`).
Supported: `en`, `de`, `es`, `fr`, `hi`, `it`, `ja`, `ko`, `pl`, `pt`, `ru`, `tr`, `zh`

### XTTS v2 Speakers

XTTS v2 is primarily a voice cloning model. Use the `voiceRef` option to clone any voice:

```json
{
  "coqui": {
    "model": "xtts_v2",
    "voiceRef": "/path/to/reference-voice.wav",
    "language": "en"
  }
}
```

Supported languages: `en`, `es`, `fr`, `de`, `it`, `pt`, `pl`, `tr`, `ru`, `nl`, `cs`, `ar`, `zh-cn`, `ja`, `hu`, `ko`

### Configuration

`~/.config/opencode/tts.json`:

```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "vctk_vits",
    "device": "mps",
    "speaker": "p226",
    "serverMode": true
  },
  "os": {
    "voice": "Samantha",
    "rate": 200
  },
  "chatterbox": {
    "device": "mps",
    "useTurbo": true,
    "serverMode": true,
    "exaggeration": 0.5
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

### Configuration Options

#### Engine Selection

| Option | Description |
|--------|-------------|
| `engine` | `"coqui"` (default), `"chatterbox"`, or `"os"` |

#### Coqui Options (`coqui`)

| Option | Description | Default |
|--------|-------------|---------|
| `model` | TTS model (see table above) | `"vctk_vits"` |
| `device` | `"cuda"`, `"mps"`, or `"cpu"` | auto-detect |
| `speaker` | Speaker ID for multi-speaker models | `"p226"` |
| `serverMode` | Keep model loaded for fast requests | `true` |
| `voiceRef` | Path to voice clip for cloning (XTTS) | - |
| `language` | Language code for XTTS | `"en"` |

#### Chatterbox Options (`chatterbox`)

| Option | Description | Default |
|--------|-------------|---------|
| `device` | `"cuda"`, `"mps"`, or `"cpu"` | auto-detect |
| `useTurbo` | Use Turbo model (10x faster) | `true` |
| `serverMode` | Keep model loaded | `true` |
| `exaggeration` | Emotion level (0.0-1.0) | `0.5` |
| `voiceRef` | Path to voice clip for cloning | - |

#### OS TTS Options (`os`)

| Option | Description | Default |
|--------|-------------|---------|
| `voice` | macOS voice name (run `say -v ?` to list) | `"Samantha"` |
| `rate` | Words per minute | `200` |

### Toggle Commands

```
/tts        Toggle on/off
/tts on     Enable
/tts off    Disable
/tts status Check current state
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
- Location: `~/.local/lib/whisper/`
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

### OpenCode Config (`~/.config/opencode/`)

```
~/.config/opencode/
├── package.json              # Plugin dependencies (bun install)
├── opencode.json             # OpenCode config
├── tts.json                  # TTS + Telegram config
├── plugin/
│   ├── reflection-3.ts       # Reflection plugin (judge layer)
│   ├── tts.ts                # TTS plugin (speech + Telegram)
│   ├── lib/
│   │   └── telegram.ts       # Telegram helper module (used by tts.ts)
│   └── worktree-status.ts    # Git worktree status tool
└── node_modules/             # Dependencies (@supabase/supabase-js)
```

### Unified TTS & STT Storage (`~/.local/lib/`)

TTS and Whisper venvs are shared across multiple projects (opencode-plugins, opencode-manager, personal scripts) to save disk space (~4GB per duplicate venv avoided).

```
~/.local/lib/
├── tts/                      # ~1.8GB total
│   ├── coqui/
│   │   ├── venv/             # Shared Python venv with TTS package
│   │   ├── tts.py            # One-shot TTS script
│   │   ├── tts_server.py     # Persistent server script
│   │   ├── tts.sock          # Unix socket for IPC
│   │   └── server.pid        # Running server PID
│   └── chatterbox/
│       ├── venv/             # Chatterbox Python venv
│       ├── tts.py
│       ├── tts_server.py
│       ├── tts.sock
│       └── voices/           # Voice reference files
└── whisper/                  # ~316MB
    ├── venv/                 # Shared Python venv with faster-whisper
    ├── whisper_server.py     # STT server script
    └── server.pid
```

### Model Caches (NOT venvs)

Models are cached separately from venvs and managed by the respective libraries:

| Library | Cache Location | Size | Env Override |
|---------|---------------|------|--------------|
| **Coqui TTS** | `~/Library/Application Support/tts/` (macOS) | ~10GB | `TTS_HOME` |
| **Coqui TTS** | `~/.local/share/tts/` (Linux) | ~10GB | `TTS_HOME` or `XDG_DATA_HOME` |
| **Whisper** | `~/.cache/huggingface/hub/` | ~1-3GB | `HF_HOME` |

**Environment Variables:**
```bash
# Override TTS model location (applies to Coqui TTS)
export TTS_HOME=/custom/path/tts

# Override Whisper/HuggingFace cache
export HF_HOME=/custom/path/huggingface
```

---

## Development

```bash
# Clone
git clone https://github.com/dzianisv/opencode-plugins
cd opencode-plugins

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
- **TTS**: macOS (for `say`), Python 3.9-3.11 (Coqui), Python 3.11 (Chatterbox)
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
