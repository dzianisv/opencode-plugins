# Telegram Integration Architecture

## Overview

Two-way communication between OpenCode and Telegram:
- **Outbound**: Task completion notifications (text + TTS audio)
- **Inbound**: User replies via text, voice, or video messages

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         TELEGRAM INTEGRATION ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                          USER'S TELEGRAM APP                               │  │
│  │                                                                            │  │
│  │   📱 Receives notifications    🎤 Sends voice/text replies                │  │
│  └──────────────────┬─────────────────────────────────┬──────────────────────┘  │
│                     │                                 │                          │
│                     │ Bot sends                       │ User sends               │
│                     │ messages                        │ replies                  │
│                     ▼                                 ▼                          │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                          TELEGRAM BOT API                                  │  │
│  │                                                                            │  │
│  │   sendMessage/sendVoice ◄────────────────────► Webhook (incoming)         │  │
│  └──────────────────┬─────────────────────────────────┬──────────────────────┘  │
│                     │                                 │                          │
│                     │                                 │ POST to webhook URL      │
│                     │                                 ▼                          │
│  ┌──────────────────┼─────────────────────────────────────────────────────────┐ │
│  │                  │           SUPABASE (Cloud)                               │ │
│  │                  │                                                          │ │
│  │                  │    ┌─────────────────────────────────────────────────┐  │ │
│  │                  │    │           telegram-webhook                       │  │ │
│  │                  │    │           Edge Function                          │  │ │
│  │                  │    │                                                  │  │ │
│  │                  │    │  • Receives incoming messages                    │  │ │
│  │                  │    │  • Handles /start, /stop, /status commands      │  │ │
│  │                  │    │  • For voice: downloads audio via Bot API       │  │ │
│  │                  │    │  • Inserts into telegram_replies table          │  │ │
│  │                  │    │    (text or audio_base64 for voice)             │  │ │
│  │                  │    └──────────────────────┬──────────────────────────┘  │ │
│  │                  │                           │                              │ │
│  │                  │                           │ INSERT                       │ │
│  │                  │                           ▼                              │ │
│  │                  │    ┌─────────────────────────────────────────────────┐  │ │
│  │                  │    │              PostgreSQL                          │  │ │
│  │                  │    │                                                  │  │ │
│  │   ┌──────────────┴──┐ │  telegram_subscribers   (user subscriptions)    │  │ │
│  │   │  send-notify    │ │  telegram_reply_contexts (active sessions)      │  │ │
│  │   │  Edge Function  │ │  telegram_replies       (incoming messages)     │  │ │
│  │   │                 │ │                          ▲                       │  │ │
│  │   │ • Lookup UUID   │ │                          │ Realtime              │  │ │
│  │   │ • Send to TG    │ │                          │ (WebSocket)           │  │ │
│  │   │ • Store context │ │                          │                       │  │ │
│  │   └────────▲────────┘ └──────────────────────────┼───────────────────────┘  │ │
│  │            │                                     │                          │ │
│  └────────────┼─────────────────────────────────────┼──────────────────────────┘ │
│               │                                     │                            │
│               │ HTTPS POST                          │ WebSocket                  │
│               │ (notification)                      │ (replies + audio)          │
│               │                                     │                            │
│  ┌────────────┼─────────────────────────────────────┼──────────────────────────┐ │
│  │            │           LOCAL MACHINE             │                          │ │
│  │            │                                     │                          │ │
│  │            │                                     ▼                          │ │
│  │   ┌────────┴────────────────────────────────────────────────────────────┐  │ │
│  │   │                        TTS Plugin (tts.ts)                           │  │ │
│  │   │                                                                      │  │ │
│  │   │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │  │ │
│  │   │  │ Outbound        │  │ Inbound         │  │ Voice Processing    │  │  │ │
│  │   │  │                 │  │                 │  │                     │  │  │ │
│  │   │  │ session.idle    │  │ Supabase        │  │ Receives audio_b64  │  │  │ │
│  │   │  │ ───────────►    │  │ Realtime sub    │  │ via WebSocket       │  │  │ │
│  │   │  │ Generate TTS    │  │ ◄───────────    │  │ ─────────────────►  │  │  │ │
│  │   │  │ ───────────►    │  │ Forward to      │  │ Transcribe locally  │  │  │ │
│  │   │  │ Send to Supabase│  │ OpenCode session│  │ (Whisper STT)       │  │  │ │
│  │   │  └─────────────────┘  └─────────────────┘  └──────────┬──────────┘  │  │ │
│  │   │                                                       │             │  │ │
│  │   └───────────────────────────────────────────────────────┼─────────────┘  │ │
│  │                                                           │                 │ │
│  │                                                           ▼                 │ │
│  │   ┌───────────────────────────────────────────────────────────────────────┐│ │
│  │   │                    Whisper STT Server (localhost:8787)                 ││ │
│  │   │                                                                        ││ │
│  │   │  • FastAPI HTTP server                                                 ││ │
│  │   │  • faster-whisper library                                              ││ │
│  │   │  • Converts OGG → WAV (ffmpeg)                                         ││ │
│  │   │  • Returns transcribed text                                            ││ │
│  │   └───────────────────────────────────────────────────────────────────────┘│ │
│  │                                                                             │ │
│  │   ┌───────────────────────────────────────────────────────────────────────┐│ │
│  │   │                    OpenCode Sessions                                   ││ │
│  │   │                                                                        ││ │
│  │   │  ses_abc123     ses_def456     ses_ghi789                             ││ │
│  │   │  (working on    (working on    (idle)                                 ││ │
│  │   │   auth module)   API routes)                                          ││ │
│  │   └───────────────────────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Message Flows

### 1. Outbound: Task Completion Notification

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  OpenCode   │     │ TTS Plugin  │     │ send-notify │     │  Telegram   │
│  Session    │     │             │     │ Edge Func   │     │   User      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ session.idle      │                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │                   │ Generate TTS      │                   │
       │                   │ (Coqui/OS)        │                   │
       │                   │                   │                   │
       │                   │ POST /send-notify │                   │
       │                   │ {uuid, text,      │                   │
       │                   │  session_id,      │                   │
       │                   │  voice_base64}    │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │                   │ Store reply_context
       │                   │                   │ (session_id, uuid)│
       │                   │                   │                   │
       │                   │                   │ sendMessage()     │
       │                   │                   │ sendVoice()       │
       │                   │                   │──────────────────>│
       │                   │                   │                   │
       │                   │                   │                   │ 📱 Notification
       │                   │                   │                   │    received!
```

### 2. Inbound: Text Reply

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │     │  telegram-  │     │  Supabase   │     │ TTS Plugin  │
│   User      │     │  webhook    │     │  Realtime   │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ Reply: "Add tests"│                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │                   │ Lookup active     │                   │
       │                   │ reply_context     │                   │
       │                   │                   │                   │
       │                   │ INSERT into       │                   │
       │                   │ telegram_replies  │                   │
       │                   │ {session_id,      │                   │
       │                   │  reply_text}      │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │                   │ WebSocket push    │
       │                   │                   │ (postgres_changes)│
       │                   │                   │──────────────────>│
       │                   │                   │                   │
       │                   │                   │                   │ Forward to
       │                   │                   │                   │ OpenCode session
       │                   │                   │                   │
       │ ✓ Reply sent      │                   │                   │
       │<──────────────────│                   │                   │
```

### 3. Inbound: Voice Message

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │     │  telegram-  │     │  Supabase   │     │ TTS Plugin  │     │  Whisper    │
│   User      │     │  webhook    │     │  Realtime   │     │             │     │  Server     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │                   │
       │ 🎤 Voice message  │                   │                   │                   │
       │──────────────────>│                   │                   │                   │
       │                   │                   │                   │                   │
       │                   │ getFile(file_id)  │                   │                   │
       │                   │ Download audio    │                   │                   │
       │                   │ from Telegram API │                   │                   │
       │                   │                   │                   │                   │
       │                   │ INSERT into       │                   │                   │
       │                   │ telegram_replies  │                   │                   │
       │                   │ {session_id,      │                   │                   │
       │                   │  audio_base64,    │                   │                   │
       │                   │  is_voice: true}  │                   │                   │
       │                   │──────────────────>│                   │                   │
       │                   │                   │                   │                   │
       │                   │                   │ WebSocket push    │                   │
       │                   │                   │──────────────────>│                   │
       │                   │                   │                   │                   │
       │                   │                   │                   │ POST /transcribe  │
       │                   │                   │                   │ {audio_base64}    │
       │                   │                   │                   │──────────────────>│
       │                   │                   │                   │                   │
       │                   │                   │                   │    Transcribe     │
       │                   │                   │                   │    (faster-whisper)
       │                   │                   │                   │                   │
       │                   │                   │                   │ {text: "Add tests"}
       │                   │                   │                   │<──────────────────│
       │                   │                   │                   │                   │
       │                   │                   │                   │ Forward to        │
       │                   │                   │                   │ OpenCode session  │
       │                   │                   │                   │                   │
       │ ✓ Voice processed │                   │                   │                   │
       │<──────────────────│                   │                   │                   │
```

## Key Design Decisions

### Audio Data Flow (Voice Messages)

1. **Edge Function downloads audio** - Has BOT_TOKEN, can access Telegram file API
2. **Audio sent via WebSocket** - Temporary transport, not stored long-term
3. **Plugin transcribes locally** - Whisper STT on localhost:8787
4. **Only text forwarded to session** - Audio discarded after transcription

### Why Local Transcription?

- **Privacy**: Audio never leaves local machine after transport
- **Speed**: Local Whisper is fast, no cloud API latency
- **Cost**: No per-request STT API fees
- **Offline**: Works without internet (after initial model download)

### Data Retention

| Table                    | Retention | Purpose                          |
|--------------------------|-----------|----------------------------------|
| telegram_subscribers     | Permanent | User subscription info           |
| telegram_reply_contexts  | 24 hours  | Active session routing           |
| telegram_replies         | Ephemeral | Transport for replies + audio    |

## Configuration

### tts.json

```json
{
  "enabled": true,
  "engine": "coqui",
  "telegram": {
    "enabled": true,
    "uuid": "your-uuid-here",
    "receiveReplies": true
  },
  "whisper": {
    "enabled": true,
    "model": "base",
    "port": 8787
  }
}
```

### Environment Variables (Edge Functions)

Set via `supabase secrets set`:
- `TELEGRAM_BOT_TOKEN` - Bot API token
- `SUPABASE_SERVICE_ROLE_KEY` - Auto-set by Supabase

## Files

```
opencode-reflection-plugin/
├── tts.ts                              # Main plugin
│   ├── sendTelegramNotification()      # Outbound notifications
│   ├── subscribeToReplies()            # WebSocket subscription (handles both text + voice)
│   └── transcribeWithWhisper()         # Local STT for voice messages
│
├── whisper/
│   └── whisper_server.py               # Local Whisper HTTP server
│
├── supabase/
│   ├── functions/
│   │   ├── send-notify/index.ts        # Send notifications
│   │   └── telegram-webhook/index.ts   # Receive messages (downloads voice audio)
│   │
│   └── migrations/
│       ├── 20240113_create_subscribers.sql
│       ├── 20240114_add_telegram_replies.sql
│       └── 20240116_add_voice_to_replies.sql  # Voice support in replies table
│
└── docs/
    └── telegram.md                     # This file
```

## Database Schema

### Tables

```sql
-- User subscriptions
telegram_subscribers (
  uuid UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  username TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  notifications_sent INTEGER DEFAULT 0
)

-- Reply context tracking (for multi-session support)
telegram_reply_contexts (
  id UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,        -- OpenCode session ID
  message_id INTEGER,              -- Telegram message ID
  directory TEXT,                  -- Working directory
  expires_at TIMESTAMPTZ,          -- 24-hour expiration
  is_active BOOLEAN DEFAULT TRUE
)

-- Incoming replies (Realtime-enabled) - unified for text + voice
telegram_replies (
  id UUID PRIMARY KEY,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,
  directory TEXT,
  reply_text TEXT,                 -- Text content (nullable for voice)
  telegram_message_id INTEGER,
  telegram_chat_id BIGINT NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  -- Voice message fields
  is_voice BOOLEAN DEFAULT FALSE,
  audio_base64 TEXT,               -- Base64 audio from Edge Function
  voice_file_type TEXT,            -- 'voice', 'video_note', or 'video'
  voice_duration_seconds INTEGER
)
```

### Supported Audio/Video Formats

| Telegram Type | File Format | Handling |
|---------------|-------------|----------|
| Voice Message | OGG Opus | Direct transcription |
| Video Note | MP4 | Extract audio, transcribe |
| Audio File | MP3/WAV/OGG | Direct transcription |
| Video File | MP4/MOV | Extract audio, transcribe |

## Multi-Session Support

When multiple OpenCode sessions are running concurrently:

```
Session 1 (ses_abc)              Session 2 (ses_def)
┌─────────────────┐              ┌─────────────────┐
│ Working on      │              │ Working on      │
│ auth module     │              │ API endpoints   │
└────────┬────────┘              └────────┬────────┘
         │                                │
         ▼                                ▼
Notification sent:               Notification sent:
"[ses_abc] Auth done"            "[ses_def] API done"

                    User replies:
                    "Add tests"
                         │
                         ▼
                    Routed to most recent
                    context (ses_def)
```

**Routing Rules:**
1. Each notification creates a new `reply_context` entry
2. Previous contexts for same `chat_id` are deactivated
3. User reply goes to the **most recent** active session

## Security Model

| Layer | Description |
|-------|-------------|
| UUID Authentication | User generates UUID locally, maps to chat_id |
| Rate Limiting | 10 notifications per minute per UUID |
| Row Level Security | All tables have RLS, only service_role can access |
| Context Expiration | Reply contexts expire after 24 hours |
| Local Whisper | Audio transcribed locally, never leaves machine |

## Deployment Checklist

- [ ] Apply database migrations: `supabase db push`
- [ ] Deploy Edge Functions:
  - `supabase functions deploy telegram-webhook --no-verify-jwt` (IMPORTANT: must disable JWT for Telegram)
  - `supabase functions deploy send-notify`
- [ ] Set Telegram webhook URL to Edge Function
- [ ] Configure `tts.json` with UUID
- [ ] Copy plugin to `~/.config/opencode/plugin/`
- [ ] Restart OpenCode
- [ ] (Optional) Whisper server auto-starts on first voice message
