---
name: plugin-testing
description: Verify plugin spec requirements with actionable test cases. Use when testing reflection or TTS plugins, validating code changes, or running the test suite before deployment.
metadata:
  author: opencode-reflection-plugin
  version: "1.0"
---

# Plugin Testing Checklist

Verify plugin spec requirements with actionable test cases for the reflection and TTS plugins.

## Plugin Specifications

### Reflection Plugin (`reflection-3.ts`)

#### Purpose
Evaluates task completion when the agent goes idle. If the task is incomplete, sends feedback to continue work.

#### Spec Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| R1 | Uses RECENT human input | Extract the most recent human message as the task (not the first) |
| R2 | Returns feedback only if INCOMPLETE | Only call `promptAsync()` when `verdict.complete === false` |
| R3 | No feedback if COMPLETE | Complete tasks show toast only, no prompt (prevents infinite loop) |
| R4 | No console.log | No logging to avoid breaking CLI output |
| R5 | Stores in `.reflection/` | Save reflection data (task, result, tools, prompt, verdict, timestamp) to `.reflection/` directory |
| R6 | Skip judge sessions | Never reflect on judge sessions (contain "TASK VERIFICATION") |
| R7 | Skip aborted sessions | Never reflect on sessions cancelled by user (Esc key) |
| R8 | Attempt limiting | Max 3 reflection attempts per session before giving up |
| R9 | Reset on new input | Reset attempt counter when user provides new input |
| R10 | Concurrent protection | Prevent multiple simultaneous reflections on same session |

#### Data Storage Format (`.reflection/`)
```json
{
  "task": "string - the most recent human message",
  "result": "string - the assistant's response (truncated to 2000 chars)",
  "tools": "string - last 10 tool calls",
  "prompt": "string - the full judge prompt sent",
  "verdict": {
    "complete": "boolean",
    "feedback": "string"
  },
  "timestamp": "ISO 8601 timestamp"
}
```

---

### TTS Plugin (`tts.ts`)

#### Purpose
Reads the agent's final response aloud when a session completes.

#### Spec Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| T1 | Default engine is Coqui | `loadConfig()` defaults to `engine: "coqui"` |
| T2 | Stores in `.tts/` | Save TTS data (originalText, cleanedText, spokenText, engine, timestamp) to `.tts/` directory |
| T3 | Skip judge sessions | Never speak judge session responses |
| T4 | Skip incomplete sessions | Only speak when session is complete |
| T5 | Speech lock | Prevent multiple agents from speaking simultaneously |
| T6 | Text cleaning | Remove code blocks, markdown, URLs before speaking |
| T7 | Text truncation | Truncate to 1000 chars max |
| T8 | Engine fallback | Fall back to OS TTS if configured engine fails |
| T9 | Multiple engines | Support coqui, chatterbox, and os engines |
| T10 | Server mode | Keep TTS model loaded for fast subsequent requests |

#### Data Storage Format (`.tts/`)
```json
{
  "originalText": "string - raw assistant response",
  "cleanedText": "string - after removing code/markdown",
  "spokenText": "string - final text sent to TTS (may be truncated)",
  "engine": "string - coqui|chatterbox|os",
  "timestamp": "ISO 8601 timestamp"
}
```

---

## Testing Checklist

### Pre-requisites
- [ ] Plugins deployed to `~/.config/opencode/plugin/`
- [ ] OpenCode restarted after deployment
- [ ] TTS config exists at `~/.config/opencode/tts.json`

### Reflection Plugin Tests

#### R1: Uses RECENT human input
- [ ] **Unit test exists**: Check `extractTaskAndResult()` uses last human message
- [ ] **Code review**: Line 137 uses `task = part.text` (overwrites, not assigns once)

#### R2: Returns feedback only if INCOMPLETE
- [ ] **Code review**: Lines 288-304 only call `promptAsync()` when `verdict.complete === false`

#### R3: No feedback if COMPLETE
- [ ] **Code review**: Lines 282-286 only call `showToast()`, no `promptAsync()`

#### R4: No console.log
- [ ] **Code search**: `grep -n "console.log\|log(" reflection-3.ts` returns no matches

#### R5: Stores in `.reflection/`
- [ ] **Code review**: `saveReflectionData()` function exists (lines 35-49)
- [ ] **Code review**: `reflectionDir = join(directory, ".reflection")` (line 27)
- [ ] **Code review**: All required fields saved (task, result, tools, prompt, verdict, timestamp)
- [ ] **E2E test**: After running a task, `.reflection/` directory contains JSON file

#### R6: Skip judge sessions
- [ ] **Code review**: `isJudgeSession()` function exists (lines 72-81)
- [ ] **Code review**: Judge sessions marked as processed (line 234)

#### R7: Skip aborted sessions
- [ ] **Code review**: `wasSessionAborted()` function exists (lines 83-109)
- [ ] **Code review**: `abortedSessions` Set tracks aborted sessions
- [ ] **Code review**: Fast path check at line 330

#### R8: Attempt limiting
- [ ] **Code review**: `MAX_ATTEMPTS = 3` (line 12)
- [ ] **Code review**: Attempt check at lines 218-223

#### R9: Reset on new input
- [ ] **Code review**: Lines 206-212 reset attempts on new human message

#### R10: Concurrent protection
- [ ] **Code review**: `activeReflections` Set exists (line 23)
- [ ] **Code review**: Early return at lines 182-184

### TTS Plugin Tests

#### T1: Default engine is Coqui
- [ ] **Code review**: `loadConfig()` returns `engine: "coqui"` (line 116)
- [ ] **Unit test**: `npm test` includes test for default engine

#### T2: Stores in `.tts/`
- [ ] **Code review**: `saveTTSData()` function exists (lines 1213-1226)
- [ ] **Code review**: `ttsDir = join(directory, ".tts")` (line 1205)
- [ ] **Code review**: All required fields saved
- [ ] **E2E test**: After TTS triggered, `.tts/` directory contains JSON file

#### T3: Skip judge sessions
- [ ] **Code review**: `isJudgeSession()` check at line 1338

#### T4: Skip incomplete sessions
- [ ] **Code review**: `isSessionComplete()` check at line 1339

#### T5: Speech lock
- [ ] **Code review**: `waitForSpeechLock()` called at line 1263
- [ ] **Code review**: Lock released in finally block (line 1300)

#### T6: Text cleaning
- [ ] **Code review**: `cleanTextForSpeech()` function removes code, markdown, URLs (lines 1242-1252)

#### T7: Text truncation
- [ ] **Code review**: `MAX_SPEECH_LENGTH = 1000` (line 34)
- [ ] **Code review**: Truncation logic at lines 1258-1260

#### T8: Engine fallback
- [ ] **Code review**: OS TTS fallback at line 1298

#### T9: Multiple engines
- [ ] **Code review**: `speakWithCoqui()`, `speakWithChatterbox()`, `speakWithOS()` all exist

#### T10: Server mode
- [ ] **Code review**: `serverMode` option in config (lines 68, 76)
- [ ] **Code review**: Server startup functions exist

---

## Running Tests

### Unit Tests
```bash
cd /Users/engineer/workspace/opencode-reflection-plugin
npm test
```

### E2E Tests (CRITICAL - must always run)
```bash
cd /Users/engineer/workspace/opencode-reflection-plugin
OPENCODE_E2E=1 npm run test:e2e
```

### Manual TTS Test
```bash
npm run test:tts:manual
```

### Verify Deployment
```bash
# Check plugins are deployed
ls -la ~/.config/opencode/plugin/

# Verify they match source
diff reflection-3.ts ~/.config/opencode/plugin/reflection.ts
diff tts.ts ~/.config/opencode/plugin/tts.ts

# Check TTS config
cat ~/.config/opencode/tts.json
```

### Verify Data Storage (after running a task)
```bash
# Check reflection data
ls -la .reflection/
cat .reflection/*.json | head -50

# Check TTS data
ls -la .tts/
cat .tts/*.json | head -50
```

---

## Known Issues

1. **Reflection may not trigger in test environments** - If tasks complete very quickly before `session.idle` fires, reflection may not run. This is expected behavior, not a bug.

2. **TTS Coqui server startup time** - First TTS request with Coqui may take 30-60 seconds while model downloads and loads. Subsequent requests are fast due to server mode.
