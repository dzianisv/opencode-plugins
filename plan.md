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

---

# Feature: Configurable Reflection Prompts

Issue: Allow per-project and per-query customization of the reflection/judge prompt.
Started: 2026-01-31

## Goal
Enable users to customize how the reflection plugin evaluates task completion:
1. Per-project config via `.opencode/reflection.json`
2. Query-based overrides for specific types of tasks
3. Custom evaluation rules and severity mappings

## Tasks

- [x] Task 1: Design config schema
  - Defined ReflectionConfig interface with customRules, taskPatterns, severityMapping
  - Support custom evaluation rules per task type (coding/research)
  - Support custom severity mappings
  - Support task-type-specific rules via taskPatterns
- [x] Task 2: Implement config loading
  - Load from `<project>/.opencode/reflection.json`
  - Fall back to global `~/.config/opencode/reflection.json`
  - Implemented loadConfig(), mergeConfig() functions
- [x] Task 3: Add query-based customization
  - Implemented findMatchingPattern() to match task text
  - Patterns can override task type detection
  - Extra rules applied from matched patterns
- [x] Task 4: Write tests (15 new tests added)
  - Unit tests for findMatchingPattern
  - Unit tests for buildCustomRules
  - Unit tests for mergeConfig
  - Unit tests for config-based task type detection
- [x] Task 5: Update documentation
  - Added config section to AGENTS.md
  - Documented all config options with examples

## Config Schema (Draft)

```json
{
  "enabled": true,
  "model": "claude-sonnet-4-20250514",
  "customRules": {
    "coding": [
      "All tests must pass",
      "Build must succeed",
      "No console.log statements in production code"
    ],
    "research": [
      "Provide sources for claims",
      "Include code examples where relevant"
    ]
  },
  "severityMapping": {
    "testFailure": "BLOCKER",
    "buildFailure": "BLOCKER",
    "missingDocs": "LOW"
  },
  "taskPatterns": [
    {
      "pattern": "fix.*bug|debug",
      "type": "coding",
      "extraRules": ["Verify the bug is actually fixed with a test"]
    },
    {
      "pattern": "research|investigate|explore",
      "type": "research"
    }
  ],
  "promptTemplate": null
}
```

---

# Feature: Reflection Static Plugin (ABANDONED)

Issue: Original `reflection.ts` plugin was accidentally made read-only in commit `5a3e31e`.
GitHub Issue: #42
Started: 2026-02-07
**Status: ABANDONED** - Discovered original `reflection.ts` was active before it was accidentally made passive.

## What Happened

1. The original `reflection.ts` (before commit `5a3e31e`) was ACTIVE with:
   - GenAI stuck detection
   - Compression nudges
   - Automatic feedback to continue incomplete tasks
   - 1641 lines of sophisticated logic

2. Commit `5a3e31e` ("Update reflection plugin to be read-only") accidentally stripped all active features:
   - Reduced to 711 lines
   - Removed stuck detection
   - Removed compression nudges
   - Made it passive (toast-only)

3. `reflection-static.ts` was created as a simpler alternative, but the real fix was to restore the original active version.

## Resolution (2026-02-07)

- Restored `reflection.ts` to the active version from before commit `5a3e31e`
- Re-deployed `reflection.ts` (68KB, 1641 lines) instead of the broken passive version
- `reflection-static.ts` is kept in the repo but NOT deployed (it's a simpler alternative if needed)
- All tests pass: unit (147), plugin-load (5)

## Deployed Plugins

- `reflection.ts` - Full active version with stuck detection, compression nudges, GenAI evaluation
- `tts.ts` - Text-to-speech
- `worktree.ts` - Git worktree management
- `telegram.ts` (lib/) - Telegram notifications

