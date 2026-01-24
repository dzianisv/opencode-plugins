# OpenCode Plugins

<img width="1250" height="1304" alt="image" src="https://github.com/user-attachments/assets/87485f92-2117-47bd-ace2-b6bf217be800" />
<img width="1276" height="1403" alt="image" src="https://github.com/user-attachments/assets/7a08c451-b7b3-46b8-b694-6b3f6f4071a5" />

A collection of plugins for [OpenCode](https://github.com/sst/opencode):

| Plugin | Description | Platform |
|--------|-------------|----------|
| **reflection.ts** | Judge layer that verifies task completion and forces agent to continue if incomplete | All |
| **tts.ts** | Text-to-speech that reads agent responses aloud (Samantha voice by default) | macOS |

## Quick Install

### Install All Plugins

```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

**Optional - create TTS config (recommended for Apple Silicon users):**
```bash
cat > ~/.config/opencode/tts.json << 'EOF'
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "xtts_v2",
    "device": "mps",
    "language": "en",
    "serverMode": true
  }
}
EOF
```

Then restart OpenCode.

### Install Individual Plugins

**Reflection only:**
```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

**TTS only (macOS):**
```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

### Project-Specific Installation

To install plugins for a specific project only:

```bash
mkdir -p .opencode/plugin && \
curl -fsSL -o .opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o .opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

---

## TTS Plugin

Reads the final agent response aloud when a session completes. Supports multiple TTS engines with automatic fallback.

### TTS Engines

| Engine | Quality | Speed | Requirements |
|--------|---------|-------|--------------|
| **OS** | Good - Samantha voice | Instant | macOS only |
| **Coqui** (default) | Excellent - multiple models | ~2-30s | Python 3.9+, GPU recommended |
| **Chatterbox** | Excellent - natural, expressive | ~2-15s | Python 3.11, GPU recommended |

**OS TTS** uses macOS's built-in Samantha voice (female) - instant, no setup required.

**Coqui TTS** is [Coqui's open-source TTS](https://github.com/coqui-ai/TTS) - supports multiple models including:
- **XTTS v2** (default) - Best speed/quality balance, voice cloning, 16 languages, streaming support
- **Bark** - Highly expressive with emotional speech, slower on CPU/MPS
- **Tortoise** - High quality but very slow
- **VITS** - Fast, good quality, single speaker

**Chatterbox** is [Resemble AI's open-source TTS](https://github.com/resemble-ai/chatterbox) - one of the best open-source TTS models, outperforming ElevenLabs in blind tests 63-75% of the time.

### Features
- **Default XTTS v2**: Best speed/quality balance for Apple Silicon
- **Voice cloning**: Clone any voice with a 5-10s audio sample (XTTS, Chatterbox)
- **Automatic setup**: Coqui/Chatterbox auto-installed in virtualenv on first use
- **Server mode**: Keeps model loaded for fast subsequent requests
- **Shared server**: Single instance shared across all OpenCode sessions
- **Device auto-detection**: Supports CUDA (NVIDIA), MPS (Apple Silicon), CPU
- **Speech locking**: Prevents multiple agents from speaking simultaneously
- **OS fallback**: Falls back to macOS `say` if other engines fail
- Cleans markdown, code blocks, URLs from text before speaking
- Truncates long messages (1000 char limit)
- Skips judge/reflection sessions

### Requirements

- **macOS** for OS TTS
- **Python 3.9+** for Coqui TTS
- **Python 3.11** for Chatterbox (install with `brew install python@3.11`)
- **GPU recommended** for neural TTS (NVIDIA CUDA or Apple Silicon MPS)

### Configuration

Create/edit `~/.config/opencode/tts.json`:

**Default (Coqui XTTS v2 - recommended for Apple Silicon):**
```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "xtts_v2",
    "device": "mps",
    "language": "en",
    "serverMode": true
  }
}
```

**OS TTS (instant, no dependencies):**
```json
{
  "enabled": true,
  "engine": "os",
  "os": {
    "voice": "Samantha",
    "rate": 200
  }
}
```

**Coqui with Bark (expressive, random speaker):**
```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "bark",
    "device": "mps",
    "serverMode": true
  }
}
```

**Coqui XTTS with voice cloning:**
```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "xtts_v2",
    "device": "mps",
    "voiceRef": "/path/to/voice-sample.wav",
    "language": "en",
    "serverMode": true
  }
}
```

**Chatterbox with optimizations:**
```json
{
  "enabled": true,
  "engine": "chatterbox",
  "chatterbox": {
    "device": "mps",
    "useTurbo": true,
    "serverMode": true,
    "exaggeration": 0.5,
    "voiceRef": "/path/to/voice-sample.wav"
  }
}
```

### Configuration Options

**General:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable TTS |
| `engine` | string | `"coqui"` | TTS engine: `"coqui"`, `"chatterbox"`, or `"os"` |

**OS options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `os.voice` | string | `"Samantha"` | macOS voice name (run `say -v ?` to list) |
| `os.rate` | number | `200` | Speaking rate in words per minute |

**Coqui options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `coqui.model` | string | `"xtts_v2"` | Model: `"xtts_v2"`, `"bark"`, `"tortoise"`, `"vits"` |
| `coqui.device` | string | auto | Device: `"cuda"`, `"mps"`, or `"cpu"` |
| `coqui.serverMode` | boolean | `true` | Keep model loaded between requests |
| `coqui.voiceRef` | string | - | Path to voice sample for cloning (XTTS only) |
| `coqui.language` | string | `"en"` | Language code for XTTS (en, es, fr, de, etc.) |
| `coqui.speaker` | string | `"Ana Florence"` | Built-in XTTS speaker (when no voiceRef) |

**Chatterbox options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chatterbox.device` | string | auto | Device: `"cuda"`, `"mps"`, or `"cpu"` |
| `chatterbox.useTurbo` | boolean | `false` | Use Turbo model (10x faster) |
| `chatterbox.serverMode` | boolean | `true` | Keep model loaded between requests |
| `chatterbox.exaggeration` | number | `0.5` | Emotion intensity (0.0-1.0) |
| `chatterbox.voiceRef` | string | - | Path to voice sample for cloning (5-10s WAV) |

**Environment variables** (override config):
- `TTS_DISABLED=1` - Disable TTS entirely
- `TTS_ENGINE=coqui` - Force Coqui TTS engine
- `TTS_ENGINE=chatterbox` - Force Chatterbox engine
- `TTS_ENGINE=os` - Force OS TTS engine

### Model Comparison

| Model | Quality | Speed (MPS) | Voice Cloning | Languages |
|-------|---------|-------------|---------------|-----------|
| **XTTS v2** | Excellent | Fast (2-5s) | Yes | 16 |
| **Bark** | Excellent | Slow (30-60s) | No | Multi |
| **Tortoise** | Excellent | Very slow | Yes | English |
| **VITS** | Good | Very fast | No | English |
| **Chatterbox** | Excellent | Fast (2-5s) | Yes | English |
| **OS (Samantha)** | Good | Instant | No | Multi |

**Recommendation for Apple Silicon (MPS):**
- **Best balance**: XTTS v2 - fast, high quality, voice cloning, multilingual
- **Instant speech**: OS TTS - no delay, good quality
- **Expressive speech**: Chatterbox with Turbo - natural sounding

### Speed Comparison

| Configuration | First Request | Subsequent |
|--------------|---------------|------------|
| OS TTS (Samantha) | Instant | Instant |
| XTTS v2 MPS + Server | 15-30s | 2-5s |
| Bark MPS + Server | 60-120s | 30-60s |
| VITS MPS + Server | 5-10s | <1s |
| Chatterbox MPS + Turbo + Server | 10-20s | 2-5s |
| Chatterbox CUDA + Turbo + Server | 5-10s | <1s |

> **Note**: With server mode enabled, the model stays loaded in memory and is shared across all OpenCode sessions. The first request downloads/loads the model (slow), subsequent requests are fast.

### Quick Toggle

```
/tts        Toggle TTS on/off
/tts on     Enable TTS
/tts off    Disable TTS
```

### Telegram Notifications

Get notified on Telegram when OpenCode tasks complete - includes text summaries and optional voice messages.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SUPABASE (Backend)                                             │
│  - PostgreSQL: telegram_subscribers table (uuid → chat_id)      │
│  - Edge Function: /telegram-webhook (handles /start, /stop)     │
│  - Edge Function: /send-notify (receives notifications)         │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ HTTPS POST
                              │
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode TTS Plugin (tts.ts)                                   │
│  - On task complete: generates TTS audio locally                │
│  - Converts WAV → OGG (ffmpeg)                                  │
│  - Sends text + voice_base64 to Supabase Edge Function          │
└─────────────────────────────────────────────────────────────────┘
```

**Design principles:**
- **Privacy-first**: Your UUID is never linked to your identity - only to your Telegram chat ID
- **Serverless**: Supabase Edge Functions scale automatically, no server to maintain
- **Self-hostable**: All backend code is in `supabase/` directory - deploy to your own Supabase project

#### Quick Setup (Using Existing Backend)

1. **Generate your UUID:**
   ```bash
   uuidgen | tr '[:upper:]' '[:lower:]'
   # Example output: a0dcb5d4-30c2-4dd0-bfbe-e569a42f47bb
   ```

2. **Subscribe via Telegram:**
   - Open [@OpenCodeMgrBot](https://t.me/OpenCodeMgrBot)
   - Send: `/start <your-uuid>`
   - You'll receive a confirmation message

3. **Configure TTS plugin** (`~/.config/opencode/tts.json`):
   ```json
   {
     "enabled": true,
     "engine": "coqui",
     "telegram": {
       "enabled": true,
       "uuid": "<your-uuid>",
       "sendText": true,
       "sendVoice": true
     }
   }
   ```

4. **Restart OpenCode** - you'll now receive Telegram notifications when tasks complete

#### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start <uuid>` | Subscribe with your UUID |
| `/stop` | Unsubscribe from notifications |
| `/status` | Check subscription status |
| `/help` | Show available commands |

#### Telegram Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `telegram.enabled` | boolean | `false` | Enable Telegram notifications |
| `telegram.uuid` | string | - | Your subscription UUID (required) |
| `telegram.sendText` | boolean | `true` | Send text message summaries |
| `telegram.sendVoice` | boolean | `true` | Send voice messages (requires ffmpeg) |
| `telegram.serviceUrl` | string | (default) | Custom backend URL (for self-hosted) |

**Environment variables** (override config):
- `TELEGRAM_DISABLED=1` - Disable Telegram notifications

#### Self-Hosting the Backend

To deploy your own Telegram notification backend:

**Prerequisites:**
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- A Supabase project (free tier works fine)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

**1. Link to your Supabase project:**
```bash
cd opencode-reflection-plugin
supabase link --project-ref <your-project-ref>
```

**2. Push the database migration:**
```bash
supabase db push
```

This creates the `telegram_subscribers` table:
```sql
CREATE TABLE telegram_subscribers (
  uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  is_active BOOLEAN DEFAULT true,
  notifications_sent INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**3. Deploy edge functions:**
```bash
supabase functions deploy telegram-webhook
supabase functions deploy send-notify
```

**4. Set secrets:**
```bash
supabase secrets set TELEGRAM_BOT_TOKEN=<your-bot-token>
```

**5. Configure Telegram webhook:**
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook"
```

**6. Update your TTS config to use your backend:**
```json
{
  "telegram": {
    "enabled": true,
    "uuid": "<your-uuid>",
    "serviceUrl": "https://<your-project-ref>.supabase.co/functions/v1/send-notify"
  }
}
```

#### Backend Files

```
supabase/
├── migrations/
│   └── 20240113000000_create_subscribers.sql  # Database schema
└── functions/
    ├── telegram-webhook/
    │   └── index.ts                            # Handles /start, /stop, /status
    └── send-notify/
        └── index.ts                            # Receives notifications from plugin
```

#### How UUID Subscription Works

```
┌──────────────────┐                    ┌──────────────────┐
│  User generates  │                    │  Telegram Bot    │
│  UUID locally    │                    │  @OpenCodeMgrBot │
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         │ 1. User sends                         │
         │    /start <uuid>                      │
         │ ─────────────────────────────────────▶│
         │                                       │
         │                              2. Bot stores mapping:
         │                                 uuid → chat_id
         │                                       │
         │ 3. User configures                    │
         │    tts.json with uuid                 │
         │                                       │
         ▼                                       ▼
┌──────────────────┐                    ┌──────────────────┐
│  OpenCode        │                    │  Supabase DB     │
│  sends notify    │───────────────────▶│  looks up        │
│  with uuid       │                    │  chat_id by uuid │
└──────────────────┘                    └────────┬─────────┘
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │  Telegram API    │
                                        │  sends message   │
                                        │  to chat_id      │
                                        └──────────────────┘
```

**Security model:**
- UUID is generated locally and never transmitted except when subscribing
- Backend only stores UUID → chat_id mapping (no personal data)
- Rate limiting: 10 requests/minute per UUID
- You can unsubscribe anytime with `/stop`

### Available macOS Voices

Run `say -v ?` to list all available voices. Popular choices:
- **Samantha** (default) - American English female
- **Alex** - American English male
- **Victoria** - American English female
- **Daniel** - British English male
- **Karen** - Australian English female

### Server Architecture

When using Coqui or Chatterbox with `serverMode: true` (default), the plugin runs a persistent TTS server:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ OpenCode        │     │ OpenCode        │     │ OpenCode        │
│ Session 1       │     │ Session 2       │     │ Session 3       │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   TTS Server           │
                    │   (Unix Socket)        │
                    │                        │
                    │ • Model loaded once    │
                    │ • Shared across all    │
                    │   sessions             │
                    │ • Lock prevents        │
                    │   duplicate starts     │
                    │ • Speech lock prevents │
                    │   simultaneous speech  │
                    └────────────────────────┘
```

**Server files:**
- Coqui: `~/.config/opencode/opencode-helpers/coqui/` (tts.sock, server.pid, server.lock, venv/)
- Chatterbox: `~/.config/opencode/opencode-helpers/chatterbox/` (tts.sock, server.pid, server.lock, venv/)
- Whisper: `~/.config/opencode/opencode-helpers/whisper/` (whisper_server.py, server.pid, venv/)
- Speech lock: `~/.config/opencode/speech.lock`

**Managing the server:**
```bash
# Check if Coqui server is running
ls -la ~/.config/opencode/opencode-helpers/coqui/tts.sock

# Stop the Coqui server manually
kill $(cat ~/.config/opencode/opencode-helpers/coqui/server.pid)

# Check if Chatterbox server is running
ls -la ~/.config/opencode/opencode-helpers/chatterbox/tts.sock

# Stop the Chatterbox server manually
kill $(cat ~/.config/opencode/opencode-helpers/chatterbox/server.pid)

# Server restarts automatically on next TTS request
```

---

## Reflection Plugin

A judge layer that evaluates task completion and provides feedback to continue if work is incomplete.

### How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Task      │────▶│  Agent Works     │────▶│ Session Idle    │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
                                                  ┌─────────────────┐
                                                  │  Judge Session  │
                                                  │  (Hidden)       │
                                                  │                 │
                                                  │ Evaluates:      │
                                                  │ • Initial task  │
                                                  │ • AGENTS.md     │
                                                  │ • Tool calls    │
                                                  │ • Agent output  │
                                                  └────────┬────────┘
                                                          │
                                   ┌──────────────────────┴──────────────────────┐
                                   ▼                                             ▼
                          ┌──────────────────┐                         ┌──────────────────┐
                          │ Task Incomplete  │                         │  Task Complete   │
                          │                  │                         │                  │
                          │ Toast: warning   │                         │ Toast: success   │
                          │ Chat: Feedback   │                         │                  │
                          └────────┬─────────┘                         └──────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ Agent Continues  │
                          │ with guidance    │
                          └──────────────────┘
```

### Features

- **Automatic trigger** on session idle
- **Rich context collection**: last user task, AGENTS.md (1500 chars), last 10 tool calls, last assistant response (2000 chars)
- **Separate judge session** for unbiased evaluation
- **Chat-integrated feedback**: Reflection messages appear naturally in the OpenCode chat UI
- **Toast notifications**: Non-intrusive status updates (success/warning/error)
- **Auto-continuation**: Agent automatically continues with feedback if task incomplete
- **Max 3 attempts** to prevent infinite loops
- **Infinite loop prevention**: Automatically skips judge sessions to prevent recursion

### Configuration

Edit `~/.config/opencode/plugin/reflection.ts`:
```typescript
const MAX_ATTEMPTS = 3  // Maximum reflection attempts per task
```

---

## Activating Plugins

After installation, restart OpenCode to load the plugins:

**Terminal/TUI mode:**
```bash
# Stop current session (Ctrl+C), then restart
opencode
```

**Background/Server mode:**
```bash
pkill opencode
opencode serve
```

**Force restart:**
```bash
pkill -9 opencode && sleep 2 && opencode
```

## Updating Plugins

```bash
# Update all plugins
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts

# Then restart OpenCode
```

## Verifying Installation

```bash
# Check plugin files exist
ls -lh ~/.config/opencode/plugin/

# Expected output:
# reflection.ts
# tts.ts
```

---

## Technical Details

### OpenCode Plugin APIs Used

| API | Purpose | Plugin |
|-----|---------|--------|
| `client.session.create()` | Create judge session | Reflection |
| `client.session.promptAsync()` | Send prompts (non-blocking) | Reflection |
| `client.session.messages()` | Get conversation context | Both |
| `client.tui.publish()` | Show toast notifications | Reflection |
| `event.type === "session.idle"` | Trigger on completion | Both |

### Known Limitations

- **Reflection**: May timeout with very slow models (>3 min response time)
- **TTS Coqui**: First run downloads models (~1-2GB depending on model)
- **TTS Coqui Bark**: Very slow on CPU/MPS - use XTTS v2 instead
- **TTS Chatterbox**: Requires Python 3.11+ and ~2GB VRAM for GPU mode
- **TTS OS**: macOS only (uses `say` command)

## Requirements

- OpenCode v1.0+
- **TTS with OS engine**: macOS (default, no extra dependencies)
- **TTS with Coqui**: Python 3.9+, `TTS` package, GPU recommended
- **TTS with Chatterbox**: Python 3.11+, `chatterbox-tts` package, GPU recommended

## License

MIT
