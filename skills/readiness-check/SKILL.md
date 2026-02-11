---
name: readiness-check
description: Verify all OpenCode plugin services are healthy and ready. Use when diagnosing plugin issues, after deployment, or when services like Whisper, TTS, Supabase, or Telegram aren't working.
metadata:
  author: opencode-reflection-plugin
  version: "1.0"
---

# Readiness Check

Verify that all OpenCode plugin services are healthy and operational.

## Quick Health Check

Run these commands to verify all services:

```bash
# 1. Check Whisper STT server
curl -s http://localhost:8787/health

# 2. Check Coqui TTS server
echo '{"text":"test", "output":"/tmp/test.wav"}' | nc -U ~/.config/opencode/coqui/tts.sock

# 3. Check running processes
ps aux | grep -E "whisper_server|tts_server" | grep -v grep

# 4. Check Supabase RLS (requires .env with SUPABASE_ANON_KEY)
source .env && curl -s "https://slqxwymujuoipyiqscrl.supabase.co/rest/v1/telegram_replies?select=id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# 5. Check Supabase migrations are in sync
supabase migration list
```

## Service Details

### Whisper STT Server

**Purpose**: Transcribes voice messages from Telegram to text.

**Location**: `whisper/whisper_server.py`

**Default Port**: 8787

**Start Command**:
```bash
cd /path/to/opencode-reflection-plugin/whisper
python3 whisper_server.py --port 8787 &
```

**Health Check**:
```bash
curl -s http://localhost:8787/health
```

**Expected Response**:
```json
{
  "status": "healthy",
  "model_loaded": true,
  "current_model": "base",
  "available_models": ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v2", "large-v3"]
}
```

**Troubleshooting**:
- If not running: Start with the command above
- If model loading fails: Check Python dependencies (`pip install openai-whisper`)
- For faster startup: Use `--model tiny` (lower quality but faster)

---

### Coqui TTS Server

**Purpose**: Generates speech audio from text responses.

**Location**: `~/.config/opencode/coqui/tts_server.py`

**Socket Path**: `~/.config/opencode/coqui/tts.sock`

**PID File**: `~/.config/opencode/coqui/server.pid`

**Health Check**:
```bash
# Check socket exists
ls -la ~/.config/opencode/coqui/tts.sock

# Check process is running
cat ~/.config/opencode/coqui/server.pid
ps aux | grep "$(cat ~/.config/opencode/coqui/server.pid)"

# Test TTS generation
echo '{"text":"Hello, this is a test.", "output":"/tmp/test_tts.wav"}' | nc -U ~/.config/opencode/coqui/tts.sock
```

**Expected Response**:
```json
{"success": true, "output": "/tmp/test_tts.wav"}
```

**Verify Audio**:
```bash
# Check file was created
file /tmp/test_tts.wav
# Expected: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 48000 Hz

# Play audio (macOS)
afplay /tmp/test_tts.wav
```

**Troubleshooting**:
- If socket missing: The TTS plugin auto-starts the server on first use
- To manually restart: `kill $(cat ~/.config/opencode/coqui/server.pid)` then trigger TTS
- Check logs in `~/.config/opencode/coqui/`

---

### Plugin Deployment

**Plugin Location**: `~/.config/opencode/plugin/`

**Check Deployed Plugins**:
```bash
ls -la ~/.config/opencode/plugin/
```

**Expected Files**:
- `reflection-3.ts` - Judge layer for task verification
- `tts.ts` - Text-to-speech with Telegram integration

**Deploy from Source**:
```bash
cp /path/to/opencode-reflection-plugin/tts.ts ~/.config/opencode/plugin/
cp /path/to/opencode-reflection-plugin/reflection-3.ts ~/.config/opencode/plugin/reflection.ts
```

**Restart OpenCode** after deploying for changes to take effect.

---

### TTS Configuration

**Config File**: `~/.config/opencode/tts.json`

**View Current Config**:
```bash
cat ~/.config/opencode/tts.json
```

**Example Configuration**:
```json
{
  "enabled": true,
  "engine": "coqui",
  "os": {
    "voice": "Samantha",
    "rate": 200
  },
  "coqui": {
    "model": "jenny",
    "device": "cpu",
    "language": "en",
    "serverMode": true
  },
  "telegram": {
    "enabled": true,
    "uuid": "your-uuid-here",
    "sendText": true,
    "sendVoice": true,
    "receiveReplies": true
  },
  "whisper": {
    "enabled": true,
    "model": "base",
    "port": 8787
  }
}
```

---

## Supabase Backend Verification

### RLS Policy Check

The `telegram_replies` table requires proper RLS policies for:
- **SELECT** with anon key (enables Realtime subscriptions)
- **mark_reply_processed** RPC function (marks replies as handled)

**Test SELECT Policy**:
```bash
source .env && curl -s "https://slqxwymujuoipyiqscrl.supabase.co/rest/v1/telegram_replies?select=id,uuid,processed,created_at&order=created_at.desc&limit=3" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq '.'
```

**Expected**: Array of reply objects (not an error)

**Test RPC Function**:
```bash
source .env && curl -s "https://slqxwymujuoipyiqscrl.supabase.co/rest/v1/rpc/mark_reply_processed" \
  -X POST \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_reply_id": "00000000-0000-0000-0000-000000000000"}' | jq '.'
```

**Expected**: `true` or `false` (not a permission error)

### Migration Sync Check

```bash
supabase migration list
```

**Expected**: All migrations show both Local and Remote columns with matching timestamps.

**If migrations are out of sync**:
```bash
# If remote has migrations not in local
supabase migration repair --status reverted <migration_id>

# Then push local migrations
supabase db push
```

### Edge Functions Check

```bash
# List deployed functions
supabase functions list

# Check function logs
supabase functions logs telegram-webhook --tail
supabase functions logs send-notify --tail
```

---

## Telegram Integration Verification

### 1. Check Telegram Config

```bash
cat ~/.config/opencode/tts.json | jq '.telegram'
```

**Required fields**:
- `enabled: true`
- `uuid`: Your user UUID from `/start` command
- `receiveReplies: true` (for two-way communication)

### 2. Test Outbound Notifications

Trigger a TTS event and check if notification was sent:

```bash
# Check recent notifications in Supabase
source .env && curl -s "https://slqxwymujuoipyiqscrl.supabase.co/rest/v1/telegram_notifications?select=id,message,created_at&order=created_at.desc&limit=3" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq '.'
```

### 3. Test Inbound Replies

Send a message to the Telegram bot, then check if it appears:

```bash
# Check for unprocessed replies
source .env && curl -s "https://slqxwymujuoipyiqscrl.supabase.co/rest/v1/telegram_replies?select=id,reply_text,is_voice,processed,created_at&processed=eq.false&order=created_at.desc&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq '.'
```

### 4. Test Voice Transcription

Send a voice message to the bot, then verify transcription:

```bash
# Check if Whisper is running
curl -s http://localhost:8787/health | jq '.'

# Voice messages will have is_voice=true and reply_text populated after transcription
```

---

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Whisper not responding | Server not started | `python3 whisper_server.py --port 8787 &` |
| Coqui socket missing | Server not started | Trigger any TTS action or restart OpenCode |
| Supabase module error | Dependency missing | Add to `~/.config/opencode/package.json` and run `bun install` |
| Telegram not working | Missing UUID | Get UUID from Telegram bot with `/start` |
| Voice messages not transcribed | Whisper not running | Start Whisper server |
| RLS permission denied | Missing SELECT policy | Deploy `20240117000000_fix_replies_rls.sql` migration |
| Realtime not receiving | Anon key blocked by RLS | Deploy RLS fix migration with SELECT policy for anon |
| mark_reply_processed fails | RPC function missing | Deploy RLS fix migration with SECURITY DEFINER function |
| Migrations out of sync | Remote has unknown migrations | Run `supabase migration repair` then `supabase db push` |
