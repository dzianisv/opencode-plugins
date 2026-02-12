export const telegramDoc = `# Telegram Plugin (telegram.ts)

## Scope
Two-way notifications between OpenCode sessions and Telegram.

## Requirements
- Send a notification when an OpenCode session reaches session.idle and the assistant response is complete.
- Skip notifications for judge sessions, subagent sessions, or incomplete responses.
- Include optional metadata in the outbound payload: session_id and directory.
- Support text notifications and optional voice notifications (base64 audio).
- Subscribe to Telegram replies via Supabase Realtime and forward them into the correct OpenCode session using promptAsync.
- Handle voice replies by transcribing audio locally via a Whisper server before forwarding.
- Update the Telegram reaction when a reply is successfully forwarded and when the user follows up in the same session.
- Do not block OpenCode startup; initialize reply subscription asynchronously.
- Respect user config and environment overrides.

## Configuration
File: ~/.config/opencode/telegram.json

Options:
- enabled: boolean
- uuid: string (Telegram UUID)
- serviceUrl: string (send-notify endpoint)
- sendText: boolean
- sendVoice: boolean
- receiveReplies: boolean
- supabaseUrl: string
- supabaseAnonKey: string
- reflection.waitForVerdict: boolean
- reflection.maxWaitMs: number
- whisper.enabled: boolean
- whisper.serverUrl: string
- whisper.port: number
- whisper.model: string
- whisper.device: string

Environment:
- TELEGRAM_NOTIFICATION_UUID: string
- TELEGRAM_DISABLED=1
- TELEGRAM_DEBUG=1

## Design
### Components
- OpenCode plugin: reads session data, sends notifications, and subscribes to replies.
- Supabase Edge Functions:
  - send-notify: sends Telegram messages and records reply context.
  - update-reaction: applies emoji reactions to the original message.
  - telegram-webhook: receives Telegram inbound messages and inserts replies into the database.
- Supabase Postgres tables: telegram_subscribers, telegram_reply_contexts, telegram_replies.
- Local Whisper server: HTTP STT service used to transcribe voice replies.

### Outbound Flow
1. session.idle -> read session messages.
2. Skip if judge session, subagent session, or incomplete response.
3. Optionally wait for reflection verdict file in .reflection/.
4. Build payload: uuid, text, session_id, directory, optional voice_base64.
5. POST to send-notify.
6. Store last message ids for reaction updates.

### Inbound Flow (Text)
1. telegram-webhook inserts reply into telegram_replies.
2. Supabase Realtime notifies the plugin.
3. Plugin forwards reply with promptAsync to the matching session.
4. Plugin updates reaction and marks reply processed.

### Inbound Flow (Voice)
1. telegram-webhook inserts reply with audio_base64 and file type.
2. Plugin transcribes using local Whisper server.
3. Transcription is forwarded as a user message.

## System Design Diagram

```mermaid
flowchart LR
  subgraph Local[Local Machine]
    OC[OpenCode Session]
    TP[telegram.ts]
    WS[Whisper STT Server]
    OC -->|session.idle| TP
    TP -->|POST transcribe| WS
  end

  subgraph Supabase[Supabase Cloud]
    SN[send-notify]
    UR[update-reaction]
    TW[telegram-webhook]
    DB[(Postgres + Realtime)]
    SN --> DB
    TW --> DB
    DB -->|realtime INSERT| TP
  end

  TG[Telegram API]

  TP -->|notify| SN
  SN --> TG
  TG --> TW
  TP -->|reaction| UR
  UR --> TG
```

## Data Contracts
### Outbound payload (send-notify)
- uuid: string
- text?: string
- voice_base64?: string
- session_id?: string
- directory?: string

### Reply payload (telegram_replies)
- uuid
- session_id
- directory
- reply_text
- telegram_message_id
- telegram_chat_id
- processed
- is_voice
- audio_base64
- voice_file_type
- voice_duration_seconds

## Operational Notes
- If sendVoice is enabled and a WAV file is provided, ffmpeg converts it to OGG before upload.
- Voice transcription is opt-in via whisper.enabled and requires a local Whisper server.
- The plugin auto-starts the Whisper server on first voice reply if configured.
- Initialization runs in a background timer to avoid blocking plugin load.
`;
