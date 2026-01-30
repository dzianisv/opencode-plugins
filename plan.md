# Telegram Feature Implementation Plan

## Goals

### 1. Telegram Notification on Task Complete
When an OpenCode agent completes a task and reflection confirms it's done:
- Send Telegram message to subscribed user
- Include: workspace directory, session ID, model used
- Format: Clean header + task summary

### 2. Telegram Reply Forwarding with Voice Support
When user replies to a Telegram notification:
- **Text replies**: Forward directly to the originating OpenCode session
- **Voice messages**: 
  - Receive via webhook
  - Transcribe using Whisper
  - Forward transcribed text to OpenCode session
- **Session routing**: 
  - Track session_id and directory in reply context
  - Handle multiple concurrent sessions on localhost
  - Prevent cross-session message delivery

### 3. Emoji Reaction on New Task
When agent starts working on a new task (e.g., from Telegram reply):
- Update the previous Telegram message with smile emoji reaction
- Indicates: "I received your follow-up, working on it now"

### 4. Reflection Plugin Evaluation
Test reflection.ts judge quality against evaluation prompts:
- Document stuck sessions from past 4 weeks in YAML
- Run eval.ts to:
  1. Read evaluation input prompt
  2. Pass to reflection.ts judge logic
  3. Have Azure GPT-5.2 evaluate response quality
  4. Score 0-5
- Analyze feedback to improve judge accuracy

## Current Status

### Fixed Issues
- [x] `TypeError: undefined is not an object (evaluating 'config.telegram')` - Added null guards
- [x] `convertWavToOgg called with invalid wavPath: object` - Fixed deployment structure (telegram.ts in lib/)
- [x] Emoji reaction on new task follow-up (😊 reaction via chat.message hook)

### Pending Work
- [ ] Telegram webhook receives voice messages
- [ ] Whisper server transcription integration
- [ ] Session-aware reply routing
- [ ] Emoji reaction on task follow-up
- [ ] Evaluation test cases for stuck sessions
- [ ] eval.ts validation and execution

## Architecture

```
┌──────────────────┐      ┌──────────────────┐
│   OpenCode TUI   │      │    Telegram App  │
│  (localhost)     │      │   (mobile/web)   │
└────────┬─────────┘      └────────┬─────────┘
         │                         │
         │ session.idle            │ reply/voice
         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│   tts.ts plugin  │      │  Supabase Edge   │
│  - TTS playback  │      │  - telegram-     │
│  - Notification  │      │    webhook       │
└────────┬─────────┘      └────────┬─────────┘
         │                         │
         │ sendTelegramNotification│ INSERT
         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│  send-notify     │      │ telegram_replies │
│  (Edge Function) │      │   (DB table)     │
└────────┬─────────┘      └────────┬─────────┘
         │                         │
         │ Telegram API            │ Realtime
         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│  Telegram Bot    │      │  tts.ts plugin   │
│  (@YourBot)      │      │  - Subscribe     │
│                  │◄─────│  - Forward reply │
└──────────────────┘      └──────────────────┘
```

## Testing Requirements

### Concurrency Tests
1. Multiple OpenCode sessions in different worktrees
2. Simultaneous Telegram replies
3. Session ID collision prevention
4. Correct message routing

### Voice Message Tests
1. Telegram voice message webhook handling
2. Whisper transcription accuracy
3. Base64 audio encoding/decoding
4. Error handling for failed transcription

### Evaluation Tests
1. Stuck session detection accuracy
2. False positive/negative rates
3. Judge verdict consistency

## Deployment

### Important: Deployment Structure

The plugins use a special deployment structure where `telegram.ts` is placed in a `lib/` subdirectory to prevent OpenCode from loading it as a plugin.

```bash
# Deploy all plugins (with proper path transformation)
cat tts.ts | sed 's|from "./telegram.js"|from "./lib/telegram.js"|g' > ~/.config/opencode/plugin/tts.ts
mkdir -p ~/.config/opencode/plugin/lib
cp telegram.ts ~/.config/opencode/plugin/lib/telegram.ts
cp reflection.ts ~/.config/opencode/plugin/reflection.ts
```

### Plugin Files
- `~/.config/opencode/plugin/tts.ts` - Main TTS plugin (imports from lib/)
- `~/.config/opencode/plugin/reflection.ts` - Reflection/judge plugin
- `~/.config/opencode/plugin/lib/telegram.ts` - Telegram module (NOT loaded as plugin)
