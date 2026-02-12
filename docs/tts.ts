export const ttsDoc = `# TTS Plugin (tts.ts)

## Scope
Text-to-speech for OpenCode sessions with optional reflection gating and cross-session queuing.

## Requirements
- Speak the final assistant response when session.idle fires and the response is complete.
- Skip judge sessions, subagent sessions, incomplete responses, or already spoken sessions.
- Optionally wait for a reflection verdict before speaking (default: wait and require verdict).
- Support multiple engines: coqui, chatterbox, os.
- Ensure only one session speaks at a time using a file-based FIFO queue and lock.
- Provide /tts command handling to toggle, enable, disable, or report status without invoking the LLM.
- Provide a tool entry for toggling or checking TTS status.
- Allow immediate stop via a global stop signal file.
- Persist per-session TTS metadata in .tts/ and log debug output in .tts-debug.log.

## Configuration
File: ~/.config/opencode/tts.json

Options:
- enabled: boolean
- engine: "coqui" | "chatterbox" | "os"
- os.voice, os.rate
- coqui.model, coqui.device, coqui.voiceRef, coqui.language, coqui.speaker, coqui.serverMode
- chatterbox.device, chatterbox.voiceRef, chatterbox.exaggeration, chatterbox.useTurbo, chatterbox.serverMode
- reflection.waitForVerdict
- reflection.maxWaitMs
- reflection.requireVerdict

Environment:
- TTS_DISABLED=1
- TTS_ENGINE=os|coqui|chatterbox

## Design
### Components
- OpenCode plugin: listens to session events, extracts final response, and schedules speech.
- Speech queue: filesystem tickets and lock under ~/.config/opencode/speech-queue/ and speech.lock.
- Engine backends:
  - Coqui server (Unix socket) or one-shot script.
  - Chatterbox server (Unix socket) or one-shot script.
  - OS playback (macOS say / afplay, Linux espeak / paplay / aplay).
- Reflection verdict gate: checks .reflection/verdict_<session>.json before speaking.

### Flow
1. session.idle -> validate session (not judge/subagent, complete response).
2. Optionally wait for reflection verdict (or skip if disabled).
3. Create a queue ticket and wait for lock ownership.
4. Generate audio via selected engine.
5. Play audio (afplay/paplay/aplay), then release lock and cleanup.

## System Design Diagram

```mermaid
flowchart LR
  subgraph Local[Local Machine]
    OC[OpenCode Session]
    TTS[tts.ts]
    Q[Speech Queue + Lock]
    RV[Reflection Verdict File]
    TTS -->|wait for turn| Q
    TTS -->|optional| RV
    OC -->|session.idle| TTS
  end

  subgraph Engines[TTS Engines]
    C[Coqui Server]
    H[Chatterbox Server]
    O[OS TTS]
  end

  TTS --> C
  TTS --> H
  TTS --> O
  C -->|wav| TTS
  H -->|wav| TTS
```

## Files and Paths
- ~/.config/opencode/tts.json (config)
- ~/.config/opencode/tts_stop_signal (global stop)
- ~/.config/opencode/speech-queue/*.ticket (queue)
- ~/.config/opencode/speech.lock (lock)
- ~/.config/opencode/opencode-helpers/coqui/ (Coqui venv + server)
- ~/.config/opencode/opencode-helpers/chatterbox/ (Chatterbox venv + server)
- <workspace>/.tts/ (session metadata)
- <workspace>/.tts-debug.log (debug logs)

## Observability
- Debug logs are appended to .tts-debug.log.
- TTS data snapshots are written to .tts/*.json (original, cleaned, and spoken text).
`;
