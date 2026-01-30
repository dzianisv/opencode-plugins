# Feature: Telegram Webhook Voice Support

Issue: Users want to send voice messages to the Telegram bot and have them transcribed and processed by the agent.
Started: 2026-01-30

## Goal
Enable the Telegram webhook to receive voice messages, download them from Telegram's API, transcribe them using the Whisper service, and forward the transcribed text to the OpenCode session as a user message.

## Tasks

- [ ] Task 1: Research Telegram Voice API
  - Understand `message.voice` object structure.
  - Check how to get file path via `getFile`.
  - Check how to download file content.
- [ ] Task 2: Update `telegram-webhook` Supabase Function
  - Handle `message.voice` in the webhook payload.
  - If voice message, call Telegram `getFile` API to get download URL.
  - Download the OGG/OGA file.
  - Forward the audio file (or download URL) to a processing service, or transcribe directly if feasible (likely need to pass to a service that can access Whisper).
  - *Refinement:* Since the webhook is an Edge Function, it might be better to forward the file info to the local `telegram.ts` plugin, which has access to the local Whisper service.
  - *Revised Plan:* Webhook stores voice file ID/URL in Supabase `telegram_replies` table.
- [ ] Task 3: Update `telegram.ts` Plugin
  - Update `pollTelegramReplies` to handle voice messages.
  - If a reply contains a voice file ID:
    - Download the file using Telegram Bot API.
    - Convert OGG to WAV (ffmpeg required).
    - Send to local Whisper service for transcription.
    - Inject transcribed text into OpenCode session.
- [ ] Task 4: Verify
  - Send voice message to bot.
  - Verify transcription appears in OpenCode.

## Completed

- [x] Implemented Immediate Global TTS Stop
  - Modified `tts.ts` to use a global stop signal file.
  - Updated `execAndTrack` to poll for the stop signal and kill active processes.
  - Verified with typecheck and unit tests.
- [x] Worktree Agent Delegation
  - Enhanced `worktree_create` to support optional task argument.
  - New worktrees launch with `opencode run "<task>"`.
