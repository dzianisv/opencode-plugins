# Feature: Telegram Webhook Voice Support

Issue: Users want to send voice messages to the Telegram bot and have them transcribed and processed by the agent.
Started: 2026-01-30

## Goal
Enable the Telegram webhook to receive voice messages, download them from Telegram's API, transcribe them using the Whisper service, and forward the transcribed text to the OpenCode session as a user message.

## Tasks

- [x] Task 1: Research Telegram Voice API
  - Understand `message.voice` object structure.
  - Check how to get file path via `getFile`.
  - Check how to download file content.
- [x] Task 2: Update `telegram-webhook` Supabase Function
  - Handle `message.voice` in the webhook payload.
  - If voice message, call Telegram `getFile` API to get download URL.
  - Download the OGG/OGA file.
  - Webhook stores voice audio as base64 in `telegram_replies` table (is_voice=true, audio_base64=<data>).
- [x] Task 3: Update `telegram.ts` Plugin
  - Added full Whisper server management (auto-setup, auto-start, health check).
  - If a reply contains `is_voice=true` and `audio_base64`:
    - Auto-starts local Whisper server if not running.
    - Sends audio to Whisper for transcription.
    - Inject transcribed text into OpenCode session.
- [x] Task 4: Verify
  - ✅ Enabled Whisper in config: `~/.config/opencode/telegram.json`
  - ✅ Fixed API endpoint: changed `/transcribe` to `/transcribe-base64` for compatibility with existing Whisper server on port 5552
  - ✅ Tested transcription endpoint - returns valid response
  - ✅ All tests pass: typecheck (0 errors), unit (132 passed), plugin-load (5 passed)

## Configuration

To enable voice transcription, add to `~/.config/opencode/telegram.json`:

```json
{
  "enabled": true,
  "uuid": "your-uuid",
  "receiveReplies": true,
  "whisper": {
    "enabled": true,
    "model": "base",
    "device": "auto"
  }
}
```

Available models: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large-v2, large-v3
Device options: auto, cuda, cpu

## Completed

- [x] Implemented Immediate Global TTS Stop
  - Modified `tts.ts` to use a global stop signal file.
  - Updated `execAndTrack` to poll for the stop signal and kill active processes.
  - Verified with typecheck and unit tests.
- [x] Worktree Agent Delegation
  - Enhanced `worktree_create` to support optional task argument.
  - New worktrees launch with `opencode run "<task>"`.
- [x] Whisper Server Management in telegram.ts
  - Added Whisper server auto-setup (Python venv, faster-whisper, FastAPI)
  - Added server lifecycle management (start, health check, lock mechanism)
  - Updated transcribeAudio() to auto-start server if needed
  - Supports voice, video_note, and video messages from Telegram
  - Tests pass: typecheck, unit tests (132), plugin-load (5)
- [x] Voice Transcription End-to-End (2026-01-31)
  - Fixed API endpoint: changed `/transcribe` to `/transcribe-base64` for opencode-manager Whisper server compatibility
  - Updated DEFAULT_SUPABASE_ANON_KEY to new token (expires 2081)
  - Verified real voice message transcription: "It's ready to use, maybe." from 1.6s audio
  - Full flow tested: Telegram → webhook → DB (audio_base64) → Whisper → transcription
  - All tests pass: typecheck (0 errors), unit (132), plugin-load (5)
