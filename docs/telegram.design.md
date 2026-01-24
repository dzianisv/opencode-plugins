# Telegram Integration Architecture

## Overview

The Telegram integration enables two-way communication between OpenCode and users via Telegram:
- **Outbound**: Notifications when tasks complete (text + voice)
- **Inbound**: Users can reply to messages (text, voice, video) to continue conversations

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM TWO-WAY INTEGRATION                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         OPENCODE (Local Machine)                            ││
│  │                                                                             ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       ││
│  │  │  Session 1  │  │  Session 2  │  │  Session 3  │  │  Session N  │       ││
│  │  │  ses_abc... │  │  ses_def... │  │  ses_ghi... │  │  ses_xyz... │       ││
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       ││
│  │         │                │                │                │               ││
│  │         └────────────────┴────────────────┴────────────────┘               ││
│  │                                   │                                         ││
│  │                          ┌────────▼────────┐                               ││
│  │                          │    TTS Plugin   │                               ││
│  │                          │    (tts.ts)     │                               ││
│  │                          └────────┬────────┘                               ││
│  │                                   │                                         ││
│  │         ┌─────────────────────────┼─────────────────────────┐              ││
│  │         │                         │                         │              ││
│  │         ▼                         ▼                         ▼              ││
│  │  ┌─────────────┐          ┌─────────────┐          ┌─────────────┐        ││
│  │  │ TTS Engine  │          │  Send HTTP  │          │  Supabase   │        ││
│  │  │ (Coqui/OS)  │          │  Notifica-  │          │  Realtime   │        ││
│  │  │             │          │  tion       │          │  Listener   │        ││
│  │  └─────────────┘          └──────┬──────┘          └──────┬──────┘        ││
│  │                                  │                        │                ││
│  └──────────────────────────────────┼────────────────────────┼────────────────┘│
│                                     │                        │                 │
│                                     │ HTTPS POST             │ WebSocket       │
│                                     │ + session_id           │ (postgres_changes)
│                                     ▼                        │                 │
│  ┌──────────────────────────────────────────────────────────┴────────────────┐│
│  │                              SUPABASE                                      ││
│  │                                                                            ││
│  │  ┌────────────────┐    ┌────────────────┐    ┌────────────────────────┐  ││
│  │  │  send-notify   │    │ telegram-      │    │     PostgreSQL DB      │  ││
│  │  │  Edge Function │    │ webhook        │    │                        │  ││
│  │  │                │    │ Edge Function  │    │  telegram_subscribers  │  ││
│  │  │ • Lookup UUID  │    │                │    │  telegram_reply_contexts││
│  │  │ • Send to TG   │    │ • Commands     │    │  telegram_replies      │  ││
│  │  │ • Store context│    │ • Voice STT    │    │                        │  ││
│  │  └───────┬────────┘    │ • Video STT    │    └────────────────────────┘  ││
│  │          │             │ • Text replies │                                 ││
│  │          │             └───────┬────────┘                                 ││
│  └──────────┼─────────────────────┼──────────────────────────────────────────┘│
│             │                     │                                            │
│             │                     │                                            │
│             ▼                     ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                           TELEGRAM BOT API                               │  │
│  │                                                                          │  │
│  │  sendMessage ◄─────────────────────────────────► getFile + webhook      │  │
│  │  sendVoice                                        (voice/video/text)     │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                     │                                          │
│                                     ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                           USER'S TELEGRAM                                │  │
│  │                                                                          │  │
│  │  📱 Receives: "Task Complete [ses_abc123]"                              │  │
│  │  🎤 Can reply: Text, Voice Message, or Video Note                       │  │
│  │                                                                          │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Message Flow Diagrams

### 1. Outbound Notification Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  OpenCode   │     │ TTS Plugin  │     │ send-notify │     │  Telegram   │
│  Session    │     │             │     │ Edge Func   │     │   User      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ session.idle      │                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │                   │ POST /send-notify │                   │
       │                   │ {                 │                   │
       │                   │   uuid,           │                   │
       │                   │   text,           │                   │
       │                   │   session_id,     │                   │
       │                   │   voice_base64    │                   │
       │                   │ }                 │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │                   │ Store context     │
       │                   │                   │ in reply_contexts │
       │                   │                   │                   │
       │                   │                   │ sendMessage       │
       │                   │                   │ "[ses_abc123]     │
       │                   │                   │  Task Complete"   │
       │                   │                   │──────────────────>│
       │                   │                   │                   │
       │                   │                   │ sendVoice (opt)   │
       │                   │                   │──────────────────>│
       │                   │                   │                   │
```

### 2. Inbound Reply Flow (Text)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │     │ telegram-   │     │  Supabase   │     │  OpenCode   │
│   User      │     │ webhook     │     │  Realtime   │     │  Session    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ "Fix the bug"     │                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │                   │ Lookup context    │                   │
       │                   │ by chat_id        │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │ Get session_id    │                   │
       │                   │<──────────────────│                   │
       │                   │                   │                   │
       │                   │ INSERT reply      │                   │
       │                   │ {session_id,      │                   │
       │                   │  reply_text}      │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │                   │ Realtime event    │
       │                   │                   │ (postgres_changes)│
       │                   │                   │──────────────────>│
       │                   │                   │                   │
       │                   │                   │ promptAsync()     │
       │                   │                   │ "[Telegram]: Fix  │
       │                   │                   │  the bug"         │
       │                   │                   │                   │
       │ "Reply sent ✓"    │                   │                   │
       │<──────────────────│                   │                   │
       │                   │                   │                   │
```

### 3. Inbound Reply Flow (Voice/Video with STT)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │     │ telegram-   │     │ Whisper STT │     │  Supabase   │
│   User      │     │ webhook     │     │  Server     │     │  Realtime   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ 🎤 Voice Message  │                   │                   │
       │──────────────────>│                   │                   │
       │                   │                   │                   │
       │                   │ getFile (file_id) │                   │
       │                   │ Download audio    │                   │
       │                   │                   │                   │
       │                   │ POST /transcribe  │                   │
       │                   │ (audio bytes)     │                   │
       │                   │──────────────────>│                   │
       │                   │                   │                   │
       │                   │ {"text": "..."}   │                   │
       │                   │<──────────────────│                   │
       │                   │                   │                   │
       │                   │ INSERT reply      │                   │
       │                   │ {reply_text:      │                   │
       │                   │  transcribed}     │                   │
       │                   │──────────────────────────────────────>│
       │                   │                   │                   │
       │ "Voice received:  │                   │                   │
       │  'Fix the bug'"   │                   │                   │
       │<──────────────────│                   │                   │
       │                   │                   │                   │
```

## Database Schema

### Tables

```sql
-- User subscriptions (existing)
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

-- Incoming replies (Realtime-enabled)
telegram_replies (
  id UUID PRIMARY KEY,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,        -- Target OpenCode session
  directory TEXT,
  reply_text TEXT NOT NULL,        -- Text or transcribed audio
  telegram_message_id INTEGER,
  telegram_chat_id BIGINT NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ
)
```

### Entity Relationship

```
┌─────────────────────┐      ┌─────────────────────┐
│ telegram_subscribers│      │telegram_reply_contexts
│                     │      │                     │
│ uuid (PK)           │◄─────│ uuid (FK)           │
│ chat_id             │      │ chat_id             │
│ username            │      │ session_id          │
│ is_active           │      │ message_id          │
│ notifications_sent  │      │ directory           │
└─────────────────────┘      │ expires_at          │
         │                   │ is_active           │
         │                   └─────────────────────┘
         │
         │                   ┌─────────────────────┐
         │                   │   telegram_replies  │
         │                   │                     │
         └───────────────────│ uuid (FK)           │
                             │ session_id          │
                             │ reply_text          │
                             │ processed           │
                             └─────────────────────┘
```

## Session ID in Messages

To support multiple concurrent OpenCode sessions, the session ID is embedded in outgoing messages:

```
🔔 *OpenCode Task Complete* [ses_abc12345]

Model: claude-sonnet-4 | Dir: my-project
────────────────────────────────────

I've completed the refactoring of the authentication module...

_💬 Reply to continue this session_
```

When a user replies, the webhook:
1. Looks up the most recent `reply_context` for that `chat_id`
2. Extracts the `session_id` 
3. Stores the reply with the correct `session_id`
4. Plugin receives via Realtime and routes to correct session

## Voice/Video Message Processing

### Faster Whisper STT Server

The Telegram webhook connects to a locally-running Faster Whisper server for speech-to-text:

```
┌─────────────────────────────────────────────────────────────────┐
│                    FASTER WHISPER STT SERVER                    │
│                                                                 │
│  Location: ~/.config/opencode/whisper/                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  whisper_server.py                                       │   │
│  │                                                          │   │
│  │  - Loads faster-whisper model (base/small/medium/large)  │   │
│  │  - HTTP server on localhost:8787                         │   │
│  │  - Endpoint: POST /transcribe                            │   │
│  │  - Accepts: audio file (OGG, MP3, WAV, MP4)              │   │
│  │  - Returns: {"text": "transcribed text", "language": "en"}│  │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Files:                                                         │
│  - whisper_server.py   (HTTP server script)                    │
│  - venv/               (Python virtualenv)                     │
│  - server.pid          (Running server PID)                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

Add to `~/.config/opencode/tts.json`:

```json
{
  "telegram": {
    "enabled": true,
    "uuid": "your-uuid",
    "receiveReplies": true,
    "whisperUrl": "http://localhost:8787/transcribe",
    "whisperModel": "base"
  }
}
```

### Supported Audio/Video Formats

| Telegram Type | File Format | Handling |
|---------------|-------------|----------|
| Voice Message | OGG Opus | Direct transcription |
| Video Note | MP4 | Extract audio, transcribe |
| Audio File | MP3/WAV/OGG | Direct transcription |
| Video File | MP4/MOV | Extract audio, transcribe |

## Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│                      SECURITY LAYERS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. UUID Authentication                                         │
│     - User generates UUID locally (never transmitted)           │
│     - UUID maps to chat_id (no personal data stored)            │
│     - Can revoke anytime with /stop                             │
│                                                                 │
│  2. Rate Limiting                                               │
│     - 10 notifications per minute per UUID                      │
│     - Prevents abuse of notification endpoint                   │
│                                                                 │
│  3. Row Level Security (RLS)                                    │
│     - All tables have RLS enabled                               │
│     - Only service_role can access (Edge Functions)             │
│     - Anon key for Realtime only (filtered by UUID)             │
│                                                                 │
│  4. Context Expiration                                          │
│     - Reply contexts expire after 24 hours                      │
│     - Automatic cleanup of stale data                           │
│                                                                 │
│  5. Whisper Server (Local)                                      │
│     - Runs on localhost only                                    │
│     - No audio data leaves local machine                        │
│     - Audio transcribed locally, only text sent to Supabase     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Multi-Session Support

When multiple OpenCode sessions are running concurrently:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONCURRENT SESSIONS                           │
│                                                                  │
│  Session 1 (ses_abc)      Session 2 (ses_def)                   │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │ Working on      │      │ Working on      │                   │
│  │ auth module     │      │ API endpoints   │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
│           ▼                        ▼                             │
│  Notification sent:       Notification sent:                     │
│  "[ses_abc] Auth done"    "[ses_def] API done"                  │
│                                                                  │
│                    ┌─────────────────┐                          │
│                    │  User replies:  │                          │
│                    │  "Add tests"    │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    Routed to most recent                        │
│                    context (ses_def)                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Routing Rules:**
1. Each notification creates a new `reply_context` entry
2. Previous contexts for same `chat_id` are deactivated
3. User reply goes to the **most recent** active session
4. To reply to a specific session, user can quote the message

## Files Reference

```
opencode-reflection-plugin/
├── tts.ts                           # Main plugin (client-side)
│   ├── sendTelegramNotification()   # Send notifications
│   ├── subscribeToReplies()         # Realtime subscription for text replies
│   ├── subscribeToVoiceMessages()   # Realtime subscription for voice messages
│   ├── processVoiceMessage()        # Download, transcribe, forward voice
│   ├── transcribeWithWhisper()      # Local Whisper STT transcription
│   ├── startWhisperServer()         # Manage local Whisper server
│   └── initSupabaseClient()         # Supabase client setup
│
├── whisper/
│   └── whisper_server.py            # Local Faster Whisper STT server (port 8787)
│
├── supabase/
│   ├── functions/
│   │   ├── send-notify/
│   │   │   └── index.ts             # Send notifications endpoint
│   │   └── telegram-webhook/
│   │       └── index.ts             # Handle incoming messages (text, voice, video)
│   │
│   └── migrations/
│       ├── 20240113000000_create_subscribers.sql    # User subscriptions
│       ├── 20240114000000_add_telegram_replies.sql  # Text reply support
│       └── 20240115000000_add_voice_messages.sql    # Voice/video message support
│
└── docs/
    └── telegram.design.md           # This file
```

## Deployment Checklist

- [ ] Apply database migrations: `supabase db push`
- [ ] Deploy Edge Functions: `supabase functions deploy`
- [ ] Set Telegram webhook URL
- [ ] Configure `tts.json` with UUID
- [ ] Start Whisper STT server (for voice messages)
- [ ] Copy plugin to `~/.config/opencode/plugin/`
- [ ] Restart OpenCode
