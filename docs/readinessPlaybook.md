# Plugin Readiness Playbook

This document describes how to verify that all OpenCode plugin services are healthy and ready.

## Quick Health Check

Run these commands to verify all services:

```bash
# 1. Check Whisper STT server
curl -s http://localhost:8787/health

# 2. Check Coqui TTS server
echo '{"text":"test", "output":"/tmp/test.wav"}' | nc -U ~/.config/opencode/coqui/tts.sock

# 3. Check running processes
ps aux | grep -E "whisper_server|tts_server" | grep -v grep
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
- `reflection.ts` - Judge layer for task verification
- `tts.ts` - Text-to-speech with Telegram integration

**Deploy from Source**:
```bash
cp /path/to/opencode-reflection-plugin/tts.ts ~/.config/opencode/plugin/
cp /path/to/opencode-reflection-plugin/reflection.ts ~/.config/opencode/plugin/
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

## Full Readiness Check Script

Save this as `check-readiness.sh`:

```bash
#!/bin/bash
set -e

echo "=== OpenCode Plugin Readiness Check ==="
echo

# Check Whisper
echo "1. Whisper STT Server:"
WHISPER_HEALTH=$(curl -s http://localhost:8787/health 2>/dev/null || echo "NOT_RUNNING")
if [[ "$WHISPER_HEALTH" == *"healthy"* ]]; then
    echo "   Status: HEALTHY"
    echo "   Model: $(echo $WHISPER_HEALTH | grep -o '"current_model":"[^"]*"' | cut -d'"' -f4)"
else
    echo "   Status: NOT RUNNING"
    echo "   Start with: cd whisper && python3 whisper_server.py --port 8787 &"
fi
echo

# Check Coqui TTS
echo "2. Coqui TTS Server:"
if [[ -S ~/.config/opencode/coqui/tts.sock ]]; then
    TTS_RESPONSE=$(echo '{"text":"test", "output":"/tmp/readiness_test.wav"}' | nc -U ~/.config/opencode/coqui/tts.sock 2>/dev/null || echo "ERROR")
    if [[ "$TTS_RESPONSE" == *"success"* ]]; then
        echo "   Status: HEALTHY"
        PID=$(cat ~/.config/opencode/coqui/server.pid 2>/dev/null || echo "unknown")
        echo "   PID: $PID"
        rm -f /tmp/readiness_test.wav
    else
        echo "   Status: ERROR - Socket exists but not responding"
    fi
else
    echo "   Status: NOT RUNNING"
    echo "   Will auto-start on first TTS request"
fi
echo

# Check Plugins
echo "3. Deployed Plugins:"
for plugin in tts.ts reflection.ts; do
    if [[ -f ~/.config/opencode/plugin/$plugin ]]; then
        echo "   $plugin: DEPLOYED"
    else
        echo "   $plugin: MISSING"
    fi
done
echo

# Check Config
echo "4. TTS Configuration:"
if [[ -f ~/.config/opencode/tts.json ]]; then
    echo "   Config file: EXISTS"
    TELEGRAM_ENABLED=$(grep -o '"telegram"[^}]*"enabled"[^,]*' ~/.config/opencode/tts.json 2>/dev/null | grep -o 'true\|false' || echo "not set")
    echo "   Telegram enabled: $TELEGRAM_ENABLED"
else
    echo "   Config file: MISSING (using defaults)"
fi
echo

echo "=== Readiness Check Complete ==="
```

Run with:
```bash
chmod +x check-readiness.sh
./check-readiness.sh
```

---

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Whisper not responding | Server not started | `python3 whisper_server.py --port 8787 &` |
| Coqui socket missing | Server not started | Trigger any TTS action or restart OpenCode |
| Supabase module error | Dependency missing | `npm install @supabase/supabase-js` |
| Telegram not working | Missing UUID | Get UUID from Telegram bot with `/start` |
| Voice messages not transcribed | Whisper not running | Start Whisper server |
