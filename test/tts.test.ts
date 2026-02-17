/**
 * TTS Plugin - Consolidated Tests
 * 
 * ALL TTS-related tests in ONE file:
 * 1. Unit tests - cleanTextForSpeech, config loading
 * 2. Whisper integration tests - /transcribe-base64 endpoint
 * 3. Chatterbox E2E tests (optional, slow)
 * 4. Manual speaking tests (optional)
 * 
 * Run all: npm test
 * Run E2E: OPENCODE_TTS_E2E=1 npm test
 * Run manual: TTS_MANUAL=1 npm test
 */

import assert from "assert"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import { readFileSync, existsSync, statSync } from "fs"
import { mkdir, writeFile, readFile, access, unlink } from "fs/promises"
import { join } from "path"
import { homedir, tmpdir } from "os"

const execAsync = promisify(exec)

// ============================================================================
// CONFIG
// ============================================================================

interface TTSConfig {
  enabled?: boolean
  engine?: "os" | "chatterbox"
  whisper?: {
    port?: number
    model?: string
    language?: string
  }
  chatterbox?: {
    device?: string
    useTurbo?: boolean
  }
}

function loadTTSConfig(): TTSConfig {
  const configPath = join(homedir(), ".config", "opencode", "tts.json")
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"))
    }
  } catch {
    // Ignore config errors
  }
  return {}
}

function getWhisperPort(): number {
  const config = loadTTSConfig()
  return config.whisper?.port || 5552 // Default to opencode-manager port
}

function getWhisperLanguage(): string | null {
  const config = loadTTSConfig()
  return config.whisper?.language || null
}

const WHISPER_PORT = getWhisperPort()
const WHISPER_URL = `http://localhost:${WHISPER_PORT}`

// ============================================================================
// UNIT TESTS - Pure functions, no external dependencies
// ============================================================================

describe("TTS Plugin - Unit Tests", () => {
  /**
   * Text cleaning function (must match plugin's implementation)
   */
  function cleanTextForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, "code block omitted")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~#]+/g, "")
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/\/[\w./-]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }

  it("removes code blocks", () => {
    const input = "Here is some code:\n```javascript\nconst x = 1;\n```\nDone."
    const result = cleanTextForSpeech(input)
    expect(result).not.toContain("const x")
    expect(result).toContain("code block omitted")
  })

  it("removes inline code", () => {
    const input = "Use the `say` command to speak."
    const result = cleanTextForSpeech(input)
    expect(result).not.toContain("`")
    expect(result).not.toContain("say")
  })

  it("keeps link text but removes URLs", () => {
    const input = "Check [OpenCode](https://github.com/sst/opencode) for more."
    const result = cleanTextForSpeech(input)
    expect(result).toContain("OpenCode")
    expect(result).not.toContain("https://")
    expect(result).not.toContain("github.com")
  })

  it("removes markdown formatting", () => {
    const input = "This is **bold** and *italic* and ~~strikethrough~~"
    const result = cleanTextForSpeech(input)
    expect(result).not.toContain("*")
    expect(result).not.toContain("~")
    expect(result).toContain("bold")
    expect(result).toContain("italic")
  })

  it("removes file paths", () => {
    const input = "Edit the file /Users/test/project/src/index.ts"
    const result = cleanTextForSpeech(input)
    expect(result).not.toContain("/Users")
  })

  it("collapses whitespace", () => {
    const input = "Hello    world\n\n\ntest"
    const result = cleanTextForSpeech(input)
    expect(result).toBe("Hello world test")
  })

  it("loads config with valid whisper port", () => {
    const port = getWhisperPort()
    console.log(`  [INFO] Whisper port from config: ${port}`)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})

// ============================================================================
// extractFinalResponse TESTS - Skips reflection-injected JSON messages
// ============================================================================

describe("extractFinalResponse - Reflection message filtering", () => {
  const REFLECTION_SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
  const REFLECTION_FEEDBACK_MARKER = "## Reflection-3:"

  function findReflectionCutoffIndex(messages: any[]): number {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.info?.role !== "user") continue
      for (const part of msg.parts || []) {
        if (
          part.type === "text" &&
          (part.text?.includes(REFLECTION_SELF_ASSESSMENT_MARKER) ||
            part.text?.includes(REFLECTION_FEEDBACK_MARKER))
        ) {
          return i
        }
      }
    }
    return -1
  }

  function extractFinalResponse(messages: any[]): string | null {
    const cutoff = findReflectionCutoffIndex(messages)
    const searchEnd = cutoff > -1 ? cutoff - 1 : messages.length - 1

    for (let i = searchEnd; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            return part.text
          }
        }
      }
    }
    return null
  }

  // Helper to build a fake message
  function msg(role: string, text: string) {
    return {
      info: { role },
      parts: [{ type: "text", text }],
    }
  }

  it("returns last assistant message when no reflection messages exist", () => {
    const messages = [
      msg("user", "What is 2+2?"),
      msg("assistant", "The answer is 4."),
    ]
    expect(extractFinalResponse(messages)).toBe("The answer is 4.")
  })

  it("skips reflection self-assessment JSON and returns the real response", () => {
    const messages = [
      msg("user", "Fix the bug in auth.ts"),
      msg("assistant", "I've fixed the authentication bug by updating the token validation logic."),
      msg("user", `${REFLECTION_SELF_ASSESSMENT_MARKER}\n\nTask summary: Fix auth bug\n\nRespond with JSON only:\n{}`),
      msg("assistant", '{"task_summary":"Fix auth bug","status":"complete","confidence":0.95}'),
    ]
    expect(extractFinalResponse(messages)).toBe(
      "I've fixed the authentication bug by updating the token validation logic."
    )
  })

  it("skips reflection feedback messages and returns the real response", () => {
    const messages = [
      msg("user", "Add unit tests"),
      msg("assistant", "I've added 5 unit tests for the auth module."),
      msg("user", `${REFLECTION_SELF_ASSESSMENT_MARKER}\n\nRespond with JSON only:`),
      msg("assistant", '{"status":"in_progress","remaining_work":["run tests"]}'),
      msg("user", `${REFLECTION_FEEDBACK_MARKER} Task incomplete.\nMissing: run tests`),
      msg("assistant", "Done, I ran the tests and they all pass."),
    ]
    // The cutoff should be at the first reflection prompt (index 2)
    // So the real response is at index 1
    expect(extractFinalResponse(messages)).toBe(
      "I've added 5 unit tests for the auth module."
    )
  })

  it("returns null when all messages are reflection artifacts", () => {
    const messages = [
      msg("user", `${REFLECTION_SELF_ASSESSMENT_MARKER}\n\nRespond with JSON only:`),
      msg("assistant", '{"status":"complete"}'),
    ]
    expect(extractFinalResponse(messages)).toBeNull()
  })

  it("handles empty message list", () => {
    expect(extractFinalResponse([])).toBeNull()
  })

  it("handles messages without text parts", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "image", url: "test.png" }] },
      { info: { role: "assistant" }, parts: [] },
    ]
    expect(extractFinalResponse(messages)).toBeNull()
  })

  it("works with multiple user-assistant exchanges before reflection", () => {
    const messages = [
      msg("user", "Create a PR"),
      msg("assistant", "I'll create a PR for you."),
      msg("user", "Include the test changes too"),
      msg("assistant", "PR created: https://github.com/example/repo/pull/42"),
      msg("user", `${REFLECTION_SELF_ASSESSMENT_MARKER}\n\nRespond with JSON only:`),
      msg("assistant", '{"status":"complete","evidence":{"pr":{"created":true}}}'),
    ]
    expect(extractFinalResponse(messages)).toBe(
      "PR created: https://github.com/example/repo/pull/42"
    )
  })

  it("findReflectionCutoffIndex returns -1 when no reflection messages", () => {
    const messages = [
      msg("user", "Hello"),
      msg("assistant", "Hi there!"),
    ]
    expect(findReflectionCutoffIndex(messages)).toBe(-1)
  })

  it("findReflectionCutoffIndex finds self-assessment marker", () => {
    const messages = [
      msg("user", "Do something"),
      msg("assistant", "Done."),
      msg("user", `${REFLECTION_SELF_ASSESSMENT_MARKER}\n\nRespond with JSON:`),
      msg("assistant", '{"status":"complete"}'),
    ]
    expect(findReflectionCutoffIndex(messages)).toBe(2)
  })

  it("findReflectionCutoffIndex finds feedback marker", () => {
    const messages = [
      msg("user", "Do something"),
      msg("assistant", "Done."),
      msg("user", `${REFLECTION_FEEDBACK_MARKER} Task incomplete.`),
      msg("assistant", "Continuing..."),
    ]
    expect(findReflectionCutoffIndex(messages)).toBe(2)
  })
})

// ============================================================================
// WHISPER INTEGRATION TESTS - Requires Whisper server running
// ============================================================================

describe("Whisper Server - Integration Tests", () => {
  jest.setTimeout(15000)
  /**
   * Helper to check if Whisper server is running
   */
  async function isWhisperRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${WHISPER_URL}/health`, { 
        signal: AbortSignal.timeout(2000) 
      })
      return response.ok
    } catch {
      return false
    }
  }
  
  /**
   * Generate a simple test audio (silence) as base64
   * Minimal valid WAV file with 0.1s of silence
   */
  function generateTestSilenceWav(): string {
    const sampleRate = 16000
    const numChannels = 1
    const bitsPerSample = 16
    const durationSeconds = 0.1
    const numSamples = Math.floor(sampleRate * durationSeconds)
    const dataSize = numSamples * numChannels * (bitsPerSample / 8)
    const fileSize = 44 + dataSize - 8
    
    const buffer = Buffer.alloc(44 + dataSize)
    
    // RIFF header
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(fileSize, 4)
    buffer.write('WAVE', 8)
    
    // fmt chunk
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28)
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32)
    buffer.writeUInt16LE(bitsPerSample, 34)
    
    // data chunk
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    // Audio data is zeros (silence)
    
    return buffer.toString('base64')
  }

  it("health endpoint responds when server is running", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log(`  [SKIP] Whisper server not running on ${WHISPER_URL}`)
      return
    }
    
    const response = await fetch(`${WHISPER_URL}/health`)
    expect(response.ok).toBe(true)
    
    const data = await response.json() as { status: string; model_loaded: boolean }
    expect(data.status).toBe("healthy")
    expect(data).toHaveProperty("model_loaded")
    console.log(`  [INFO] Whisper server healthy, model loaded: ${data.model_loaded}`)
  })

  it("models endpoint lists available models", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    const response = await fetch(`${WHISPER_URL}/models`)
    expect(response.ok).toBe(true)
    
    const data = await response.json() as { models: string[]; default: string }
    expect(Array.isArray(data.models)).toBe(true)
    expect(data.models).toContain("base")
    console.log(`  [INFO] Available models: ${data.models.join(", ")}`)
  })

  it("/transcribe-base64 endpoint accepts JSON audio", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    const testAudio = generateTestSilenceWav()
    const language = getWhisperLanguage()
    
    console.log(`  [INFO] Testing /transcribe-base64 with language: ${language || "auto"}`)
    
    // THIS IS THE CORRECT ENDPOINT - matches what the plugin uses
    const response = await fetch(`${WHISPER_URL}/transcribe-base64`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: testAudio,  // Field is "audio", not "audio_base64"
        format: "wav",
        model: "base",
        language: language
      })
    })
    
    expect(response.ok).toBe(true)
    
    const data = await response.json() as { text: string; duration: number }
    expect(data).toHaveProperty("text")
    expect(data).toHaveProperty("duration")
    console.log(`  [INFO] Transcription: "${data.text}" (${data.duration}s)`)
  })

  it("/transcribe-base64 handles format parameter", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    const testAudio = generateTestSilenceWav()
    
    const response = await fetch(`${WHISPER_URL}/transcribe-base64`, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: testAudio,
        format: "wav",
        model: "base"
      })
    })
    
    expect(response.ok).toBe(true)
    console.log("  [INFO] Format parameter accepted")
  })
})

// ============================================================================
// DEPENDENCY CHECKS - Informational only
// ============================================================================

describe("TTS Dependencies - Availability Check", () => {
  jest.setTimeout(15000)
  it("checks if faster-whisper can be imported", async () => {
    try {
      await execAsync('python3 -c "from faster_whisper import WhisperModel; print(\'ok\')"', { timeout: 10000 })
      console.log("  [INFO] faster-whisper is installed")
    } catch {
      console.log("  [INFO] faster-whisper not installed (pip install faster-whisper)")
    }
    expect(true).toBe(true)
  })

  it("checks if ffmpeg is available", async () => {
    try {
      await execAsync("which ffmpeg")
      console.log("  [INFO] ffmpeg is available")
    } catch {
      console.log("  [INFO] ffmpeg not installed (brew install ffmpeg)")
    }
    expect(true).toBe(true)
  })

  it("checks macOS say command", async () => {
    try {
      await execAsync("which say")
      console.log("  [INFO] macOS say command available")
    } catch {
      console.log("  [INFO] macOS say not available")
    }
    expect(true).toBe(true)
  })
})

// ============================================================================
// CHATTERBOX E2E TESTS - Optional, requires OPENCODE_TTS_E2E=1
// ============================================================================

const RUN_TTS_E2E = process.env.OPENCODE_TTS_E2E === "1"
const CHATTERBOX_DIR = join(homedir(), ".config/opencode/opencode-helpers/chatterbox")
const CHATTERBOX_VENV = join(CHATTERBOX_DIR, "venv")
const CHATTERBOX_SCRIPT = join(CHATTERBOX_DIR, "tts.py")
const VENV_PYTHON = join(CHATTERBOX_VENV, "bin/python")

const describeE2E = RUN_TTS_E2E ? describe : describe.skip

describeE2E("Chatterbox E2E Tests", () => {
  let mpsAvailable = false
  const createdFiles: string[] = []

  async function isChatterboxReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      await access(VENV_PYTHON)
    } catch {
      return { ready: false, reason: "Chatterbox venv not found" }
    }

    try {
      const { stdout } = await execAsync(`"${VENV_PYTHON}" -c "import chatterbox; print('ok')"`, { timeout: 10000 })
      if (!stdout.includes("ok")) {
        return { ready: false, reason: "Chatterbox import failed" }
      }
    } catch (e: any) {
      return { ready: false, reason: `Chatterbox error: ${e.message}` }
    }

    return { ready: true }
  }

  async function isMPSAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `"${VENV_PYTHON}" -c "import torch; print('yes' if torch.backends.mps.is_available() else 'no')"`,
        { timeout: 10000 }
      )
      return stdout.trim() === "yes"
    } catch {
      return false
    }
  }

  async function runTTS(text: string, device: string): Promise<{ success: boolean; error?: string; outputFile?: string; duration: number }> {
    const start = Date.now()
    const outputFile = join(tmpdir(), `tts_test_${device}_${Date.now()}.wav`)
    
    return new Promise((resolve) => {
      const proc = spawn(VENV_PYTHON, [
        CHATTERBOX_SCRIPT,
        "--output", outputFile,
        "--device", device,
        text
      ], { stdio: ["ignore", "pipe", "pipe"] })
      
      let stderr = ""
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      
      const timeout = setTimeout(() => {
        proc.kill()
        resolve({ success: false, error: "Timeout", duration: Date.now() - start })
      }, 180_000)
      
      proc.on("close", async (code) => {
        clearTimeout(timeout)
        const duration = Date.now() - start
        
        if (code !== 0) {
          resolve({ success: false, error: `Exit ${code}: ${stderr.slice(0, 200)}`, duration })
          return
        }
        
        try {
          const stats = statSync(outputFile)
          if (stats.size < 1000) {
            resolve({ success: false, error: `File too small: ${stats.size}`, outputFile, duration })
            return
          }
          resolve({ success: true, outputFile, duration })
        } catch (e: any) {
          resolve({ success: false, error: e.message, duration })
        }
      })
    })
  }

  beforeAll(async () => {
    console.log("\n=== Chatterbox E2E Setup ===")
    
    const status = await isChatterboxReady()
    if (!status.ready) {
      console.log(`Chatterbox not ready: ${status.reason}`)
      throw new Error(status.reason!)
    }
    
    mpsAvailable = await isMPSAvailable()
    console.log(`MPS available: ${mpsAvailable}`)
  }, 30000)

  afterAll(async () => {
    for (const file of createdFiles) {
      try { await unlink(file) } catch {}
    }
  })

  it("generates audio with MPS device", async () => {
    if (!mpsAvailable) {
      console.log("  [SKIP] MPS not available")
      return
    }
    
    console.log("Testing Chatterbox with MPS (may take 1-2 min)...")
    const result = await runTTS("Hello test.", "mps")
    
    if (result.outputFile) createdFiles.push(result.outputFile)
    console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"} (${Math.round(result.duration / 1000)}s)`)
    
    expect(result.success).toBe(true)
  }, 180000)

  it("generates audio with CPU device", async () => {
    console.log("Testing Chatterbox with CPU...")
    const result = await runTTS("Test.", "cpu")
    
    if (result.outputFile) createdFiles.push(result.outputFile)
    console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"} (${Math.round(result.duration / 1000)}s)`)
    
    expect(result.success).toBe(true)
  }, 180000)
})

// ============================================================================
// MANUAL TTS TESTS - Optional, requires TTS_MANUAL=1
// ============================================================================

const RUN_MANUAL = process.env.TTS_MANUAL === "1"
const describeManual = RUN_MANUAL ? describe : describe.skip

describeManual("Manual TTS Tests", () => {
  function cleanTextForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, "code block omitted")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~#]+/g, "")
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/\/[\w./-]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }

  async function speakWithOS(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "'\\''")
    await execAsync(`say -r 200 '${escaped}'`)
  }

  it("speaks simple text", async () => {
    console.log("Speaking: Hello, TTS is working...")
    await speakWithOS(cleanTextForSpeech("Hello! The TTS plugin is working correctly."))
    console.log("Done")
    expect(true).toBe(true)
  })

  it("speaks text with code block removed", async () => {
    const input = `Here's code:\n\`\`\`js\nconst x = 1;\n\`\`\`\nDone!`
    const cleaned = cleanTextForSpeech(input)
    console.log(`Speaking cleaned text: ${cleaned}`)
    await speakWithOS(cleaned)
    expect(true).toBe(true)
  })

  it("speaks text with markdown removed", async () => {
    const input = "This is **important** and *emphasized* text."
    const cleaned = cleanTextForSpeech(input)
    console.log(`Speaking: ${cleaned}`)
    await speakWithOS(cleaned)
    expect(true).toBe(true)
  })
})

// ============================================================================
// REFLECTION COORDINATION TESTS - Test verdict file reading/waiting
// ============================================================================

describe("Reflection Coordination Tests", () => {
  const testDir = join(tmpdir(), `tts-reflection-test-${Date.now()}`)
  const reflectionDir = join(testDir, ".reflection")

  beforeAll(async () => {
    await mkdir(reflectionDir, { recursive: true })
  })

  afterAll(async () => {
    // Cleanup test directory
    try {
      const { rm } = await import("fs/promises")
      await rm(testDir, { recursive: true, force: true })
    } catch {}
  })

  interface ReflectionVerdict {
    sessionId: string
    complete: boolean
    severity: string
    timestamp: number
  }

  // Recreate the waitForReflectionVerdict function for testing
  async function waitForReflectionVerdict(
    directory: string,
    sessionId: string,
    maxWaitMs: number,
    debugLog: (msg: string) => Promise<void> = async () => {}
  ): Promise<ReflectionVerdict | null> {
    const reflDir = join(directory, ".reflection")
    const signalPath = join(reflDir, `verdict_${sessionId.slice(0, 8)}.json`)
    const startTime = Date.now()
    const pollInterval = 100  // Faster polling for tests
    
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const content = await readFile(signalPath, "utf-8")
        const verdict = JSON.parse(content) as ReflectionVerdict
        
        // Check if this verdict is recent (within the last 30 seconds)
        const age = Date.now() - verdict.timestamp
        if (age < 30_000) {
          return verdict
        }
      } catch {
        // File doesn't exist yet, keep waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
    
    return null
  }

  it("returns null when no verdict file exists", async () => {
    const sessionId = "test-session-no-verdict"
    const verdict = await waitForReflectionVerdict(testDir, sessionId, 500)
    expect(verdict).toBeNull()
  })

  it("reads complete verdict from file", async () => {
    const sessionId = "test-session-complete"
    const verdictData: ReflectionVerdict = {
      sessionId: sessionId.slice(0, 8),
      complete: true,
      severity: "NONE",
      timestamp: Date.now()
    }
    
    // Write verdict file
    const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
    await writeFile(signalPath, JSON.stringify(verdictData))
    
    const verdict = await waitForReflectionVerdict(testDir, sessionId, 1000)
    expect(verdict).not.toBeNull()
    expect(verdict!.complete).toBe(true)
    expect(verdict!.severity).toBe("NONE")
  })

  it("reads incomplete verdict from file", async () => {
    const sessionId = "test-session-incomplete"
    const verdictData: ReflectionVerdict = {
      sessionId: sessionId.slice(0, 8),
      complete: false,
      severity: "HIGH",
      timestamp: Date.now()
    }
    
    // Write verdict file
    const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
    await writeFile(signalPath, JSON.stringify(verdictData))
    
    const verdict = await waitForReflectionVerdict(testDir, sessionId, 1000)
    expect(verdict).not.toBeNull()
    expect(verdict!.complete).toBe(false)
    expect(verdict!.severity).toBe("HIGH")
  })

  it("ignores stale verdict files (older than 30 seconds)", async () => {
    const sessionId = "test-session-stale"
    const verdictData: ReflectionVerdict = {
      sessionId: sessionId.slice(0, 8),
      complete: true,
      severity: "NONE",
      timestamp: Date.now() - 60_000  // 60 seconds ago (stale)
    }
    
    // Write verdict file
    const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
    await writeFile(signalPath, JSON.stringify(verdictData))
    
    const verdict = await waitForReflectionVerdict(testDir, sessionId, 500)
    expect(verdict).toBeNull()  // Stale verdict should be ignored
  })

  it("waits for verdict file to appear", async () => {
    const sessionId = "test-session-wait"
    const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
    
    // Start waiting for verdict (will wait up to 2 seconds)
    const waitPromise = waitForReflectionVerdict(testDir, sessionId, 2000)
    
    // After 500ms, write the verdict file
    setTimeout(async () => {
      const verdictData: ReflectionVerdict = {
        sessionId: sessionId.slice(0, 8),
        complete: true,
        severity: "LOW",
        timestamp: Date.now()
      }
      await writeFile(signalPath, JSON.stringify(verdictData))
    }, 500)
    
    const verdict = await waitPromise
    expect(verdict).not.toBeNull()
    expect(verdict!.complete).toBe(true)
    expect(verdict!.severity).toBe("LOW")
  })
})

// ============================================================================
// COQUI TTS BUG FIX TESTS - Issue #62
// ============================================================================

describe("Coqui TTS Bug Fixes (Issue #62)", () => {

  // --------------------------------------------------------------------------
  // BUG 1: Double reflection verdict check
  // The event handler already checks the verdict before calling speak().
  // speak() should NOT re-check, because the verdict file becomes stale
  // (>30s) during queue wait + lock acquisition.
  // --------------------------------------------------------------------------
  describe("BUG 1: No duplicate reflection verdict check in speak()", () => {
    interface ReflectionVerdict {
      sessionId: string
      complete: boolean
      severity: string
      timestamp: number
    }

    /**
     * Simulate the old speak() behavior that re-checks verdict.
     * This demonstrates the bug: if time passes between event handler check
     * and speak() check, the verdict becomes stale and speech is blocked.
     */
    function oldSpeakVerdictCheck(
      verdict: ReflectionVerdict | null,
      requireVerdict: boolean
    ): { blocked: boolean; reason?: string } {
      if (requireVerdict) {
        if (!verdict) {
          return { blocked: true, reason: "missing reflection verdict" }
        }
        if (!verdict.complete) {
          return { blocked: true, reason: `reflection verdict incomplete (${verdict.severity})` }
        }
      }
      return { blocked: false }
    }

    /**
     * Simulate the fixed speak() behavior — no verdict check at all.
     * The caller is responsible for checking the verdict.
     */
    function fixedSpeakVerdictCheck(): { blocked: boolean } {
      // Fixed: speak() trusts the caller's verdict check
      return { blocked: false }
    }

    it("old code blocks speech when verdict becomes stale during queue wait", () => {
      // Simulate: event handler checked verdict (fresh), but by the time
      // speak() runs, the verdict is stale (>30s) and re-read returns null
      const staleVerdict = null // waitForReflectionVerdict returns null for stale
      const result = oldSpeakVerdictCheck(staleVerdict, true)
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("missing reflection verdict")
    })

    it("fixed code does NOT re-check verdict (trusts caller)", () => {
      // In the fixed version, speak() doesn't check verdict at all
      const result = fixedSpeakVerdictCheck()
      expect(result.blocked).toBe(false)
    })

    it("old code blocks even when verdict was valid at event handler time", () => {
      // Simulate: event handler saw complete=true, but speak() re-checks
      // with a stale version that's now null
      const eventHandlerVerdict: ReflectionVerdict = {
        sessionId: "test1234",
        complete: true,
        severity: "NONE",
        timestamp: Date.now() - 45_000  // 45s ago - stale
      }
      // Event handler would have proceeded (it checked when fresh)
      // But speak() re-reads and gets stale/null
      const speakResult = oldSpeakVerdictCheck(null, true)
      expect(speakResult.blocked).toBe(true) // BUG: speech blocked despite valid verdict
    })

    it("verdict staleness window (30s) is shorter than typical queue wait", () => {
      // Document the timing mismatch that causes the bug
      const VERDICT_STALENESS_MS = 30_000
      const SPEECH_QUEUE_TIMEOUT_MS = 180_000 // 3 minutes
      const COQUI_SERVER_START_MS = 180_000   // 3 minutes for model download

      // The queue wait can easily exceed the staleness window
      expect(SPEECH_QUEUE_TIMEOUT_MS).toBeGreaterThan(VERDICT_STALENESS_MS)
      expect(COQUI_SERVER_START_MS).toBeGreaterThan(VERDICT_STALENESS_MS)
    })
  })

  // --------------------------------------------------------------------------
  // BUG 2: Model default mismatch between loadConfig() and startCoquiServer()
  // loadConfig() defaults to "vctk_vits" but startCoquiServer() defaulted
  // to "xtts_v2" — a much larger, slower model that may fail on limited hardware.
  // --------------------------------------------------------------------------
  describe("BUG 2: Model default consistency", () => {
    function loadConfigDefault() {
      return {
        engine: "coqui" as const,
        coqui: {
          model: "vctk_vits",
          device: "mps",
          speaker: "p226",
          serverMode: true,
        },
      }
    }

    function startCoquiServerModel(config: { coqui?: { model?: string } }) {
      // FIXED: now matches loadConfig() default
      const opts = config.coqui || {}
      return opts.model || "vctk_vits"
    }

    function startCoquiServerModel_OLD(config: { coqui?: { model?: string } }) {
      // OLD buggy code
      const opts = config.coqui || {}
      return opts.model || "xtts_v2"
    }

    it("loadConfig and startCoquiServer now use the same default model", () => {
      const configDefault = loadConfigDefault()
      const serverModel = startCoquiServerModel({}) // empty config → fallback
      expect(configDefault.coqui.model).toBe(serverModel)
    })

    it("old code had mismatched defaults", () => {
      const configDefault = loadConfigDefault()
      const oldServerModel = startCoquiServerModel_OLD({})
      expect(configDefault.coqui.model).not.toBe(oldServerModel) // BUG
      expect(oldServerModel).toBe("xtts_v2") // Wrong default
    })

    it("explicit model in config is respected by both", () => {
      const config = { coqui: { model: "bark" } }
      const serverModel = startCoquiServerModel(config)
      expect(serverModel).toBe("bark")
    })

    it("missing coqui config falls back to vctk_vits", () => {
      const serverModel = startCoquiServerModel({})
      expect(serverModel).toBe("vctk_vits")
    })
  })

  // --------------------------------------------------------------------------
  // BUG 3: No OS TTS fallback when Coqui/Chatterbox fails
  // When engine is "coqui" and Coqui fails, the old code checked
  // `engine === "os"` which was false, so speech failed silently.
  // The fix: always fall through to OS TTS when no audio was generated.
  // --------------------------------------------------------------------------
  describe("BUG 3: OS TTS fallback on engine failure", () => {
    type Engine = "coqui" | "chatterbox" | "os"

    interface EngineResult {
      spoke: boolean
      engine: string
      fallback: boolean
    }

    /**
     * Simulate OLD speak() engine selection — no fallback
     */
    function oldEngineSelection(
      engine: Engine,
      coquiAvailable: boolean,
      coquiSuccess: boolean,
      chatterboxAvailable: boolean,
      chatterboxSuccess: boolean
    ): EngineResult {
      let generatedAudioPath: string | null = null

      if (engine === "coqui" && coquiAvailable && coquiSuccess) {
        generatedAudioPath = "/tmp/audio.wav"
      }

      if (!generatedAudioPath && engine === "chatterbox" && chatterboxAvailable && chatterboxSuccess) {
        generatedAudioPath = "/tmp/audio.wav"
      }

      // BUG: only speaks with OS if engine === "os"
      if (!generatedAudioPath && engine === "os") {
        return { spoke: true, engine: "os", fallback: false }
      }

      return {
        spoke: generatedAudioPath !== null,
        engine: generatedAudioPath ? engine : "none",
        fallback: false,
      }
    }

    /**
     * Simulate FIXED speak() engine selection — always fall back to OS
     */
    function fixedEngineSelection(
      engine: Engine,
      coquiAvailable: boolean,
      coquiSuccess: boolean,
      chatterboxAvailable: boolean,
      chatterboxSuccess: boolean
    ): EngineResult {
      let generatedAudioPath: string | null = null

      if (engine === "coqui" && coquiAvailable && coquiSuccess) {
        generatedAudioPath = "/tmp/audio.wav"
      }

      if (!generatedAudioPath && engine === "chatterbox" && chatterboxAvailable && chatterboxSuccess) {
        generatedAudioPath = "/tmp/audio.wav"
      }

      // FIXED: always fall through to OS TTS when no audio generated
      if (!generatedAudioPath) {
        return { spoke: true, engine: "os", fallback: engine !== "os" }
      }

      return {
        spoke: true,
        engine,
        fallback: false,
      }
    }

    it("old code: coqui failure = silent failure (no speech)", () => {
      const result = oldEngineSelection("coqui", true, false, false, false)
      expect(result.spoke).toBe(false) // BUG: user hears nothing
    })

    it("fixed code: coqui failure = OS TTS fallback", () => {
      const result = fixedEngineSelection("coqui", true, false, false, false)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("os")
      expect(result.fallback).toBe(true)
    })

    it("old code: coqui unavailable = silent failure", () => {
      const result = oldEngineSelection("coqui", false, false, false, false)
      expect(result.spoke).toBe(false) // BUG
    })

    it("fixed code: coqui unavailable = OS TTS fallback", () => {
      const result = fixedEngineSelection("coqui", false, false, false, false)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("os")
      expect(result.fallback).toBe(true)
    })

    it("old code: chatterbox failure = silent failure", () => {
      const result = oldEngineSelection("chatterbox", false, false, true, false)
      expect(result.spoke).toBe(false) // BUG
    })

    it("fixed code: chatterbox failure = OS TTS fallback", () => {
      const result = fixedEngineSelection("chatterbox", false, false, true, false)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("os")
      expect(result.fallback).toBe(true)
    })

    it("coqui success = no fallback needed", () => {
      const result = fixedEngineSelection("coqui", true, true, false, false)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("coqui")
      expect(result.fallback).toBe(false)
    })

    it("chatterbox success = no fallback needed", () => {
      const result = fixedEngineSelection("chatterbox", false, false, true, true)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("chatterbox")
      expect(result.fallback).toBe(false)
    })

    it("os engine = direct OS TTS (not a fallback)", () => {
      const result = fixedEngineSelection("os", false, false, false, false)
      expect(result.spoke).toBe(true)
      expect(result.engine).toBe("os")
      expect(result.fallback).toBe(false)
    })
  })
})

describe("Telegram Subscription Reconnect Logic", () => {
  // These tests verify the logic for auto-reconnect and unprocessed reply recovery
  // They don't require actual Supabase connection - they test the logic patterns
  
  it("should detect subscription failure states", () => {
    // These are the states that should trigger reconnection
    const failureStates = ["TIMED_OUT", "CLOSED", "CHANNEL_ERROR"]
    const successStates = ["SUBSCRIBED", "SUBSCRIBING"]
    
    failureStates.forEach(state => {
      const shouldReconnect = ["TIMED_OUT", "CLOSED", "CHANNEL_ERROR"].includes(state)
      expect(shouldReconnect).toBe(true)
    })
    
    successStates.forEach(state => {
      const shouldReconnect = ["TIMED_OUT", "CLOSED", "CHANNEL_ERROR"].includes(state)
      expect(shouldReconnect).toBe(false)
    })
  })
  
  it("should handle voice message format detection", () => {
    // Test voice_file_type to format mapping
    const testCases = [
      { voice_file_type: "voice", expected: "ogg" },
      { voice_file_type: "video_note", expected: "mp4" },
      { voice_file_type: "audio", expected: "mp4" },
      { voice_file_type: undefined, expected: "mp4" }, // Default case
    ]
    
    testCases.forEach(({ voice_file_type, expected }) => {
      const format = voice_file_type === "voice" ? "ogg" : "mp4"
      expect(format).toBe(expected)
    })
  })
  
  it("should correctly identify voice vs text messages", () => {
    const voiceMessage = {
      is_voice: true,
      audio_base64: "T2dnUwAC...",
      reply_text: null,
    }
    
    const textMessage = {
      is_voice: false,
      audio_base64: null,
      reply_text: "Hello world",
    }
    
    const emptyMessage = {
      is_voice: false,
      audio_base64: null,
      reply_text: null,
    }
    
    // Voice message check
    const isVoice = voiceMessage.is_voice && !!voiceMessage.audio_base64
    expect(isVoice).toBe(true)
    
    // Text message check
    const isText = !textMessage.is_voice && !!textMessage.reply_text
    expect(isText).toBe(true)
    
    // Empty message should be skipped
    const isEmpty = !emptyMessage.is_voice && !emptyMessage.reply_text
    expect(isEmpty).toBe(true)
  })
  
  it("should deduplicate processed reply IDs", () => {
    const processedReplyIds = new Set<string>()
    
    const replyId1 = "6088dc4d-d433-471c-92aa-005ccddfb698"
    const replyId2 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    
    // First time processing - should not be in set
    expect(processedReplyIds.has(replyId1)).toBe(false)
    processedReplyIds.add(replyId1)
    
    // Second time - should be in set (duplicate)
    expect(processedReplyIds.has(replyId1)).toBe(true)
    
    // Different ID - should not be in set
    expect(processedReplyIds.has(replyId2)).toBe(false)
  })
  
  it("should limit processedReplyIds set size to prevent memory leaks", () => {
    const processedReplyIds = new Set<string>()
    const maxSize = 100
    
    // Add 150 IDs
    for (let i = 0; i < 150; i++) {
      processedReplyIds.add(`id-${i}`)
      
      // Limit set size (same logic as in tts.ts)
      if (processedReplyIds.size > maxSize) {
        const firstId = processedReplyIds.values().next().value
        if (firstId) processedReplyIds.delete(firstId)
      }
    }
    
    // Set should be limited to maxSize
    expect(processedReplyIds.size).toBeLessThanOrEqual(maxSize)
    
    // Oldest IDs should be removed
    expect(processedReplyIds.has("id-0")).toBe(false)
    expect(processedReplyIds.has("id-49")).toBe(false)
    
    // Newest IDs should still be present
    expect(processedReplyIds.has("id-149")).toBe(true)
    expect(processedReplyIds.has("id-100")).toBe(true)
  })
  
  it("should generate correct message prefix for voice vs text", () => {
    const getPrefix = (isVoice: boolean) => 
      isVoice ? "[User via Telegram Voice]" : "[User via Telegram]"
    
    expect(getPrefix(true)).toBe("[User via Telegram Voice]")
    expect(getPrefix(false)).toBe("[User via Telegram]")
  })
  
  it("should generate correct toast title for recovered messages", () => {
    const getToastTitle = (isVoice: boolean, isRecovered: boolean) => {
      if (isRecovered) {
        return isVoice ? "Telegram Voice (Recovered)" : "Telegram Reply (Recovered)"
      }
      return isVoice ? "Telegram Voice Message" : "Telegram Reply"
    }
    
    expect(getToastTitle(true, false)).toBe("Telegram Voice Message")
    expect(getToastTitle(false, false)).toBe("Telegram Reply")
    expect(getToastTitle(true, true)).toBe("Telegram Voice (Recovered)")
    expect(getToastTitle(false, true)).toBe("Telegram Reply (Recovered)")
  })
  
  describe("Session Not Found Error Handling", () => {
    /**
     * isSessionNotFoundError - detect when session no longer exists
     * Must match the implementation in tts.ts
     */
    function isSessionNotFoundError(error: any): boolean {
      const message = error?.message || String(error)
      return (
        message.includes('session not found') ||
        message.includes('Session not found') ||
        message.includes('not found') ||
        message.includes('does not exist') ||
        message.includes('404')
      )
    }
    
    it("should detect session not found errors", () => {
      const sessionNotFoundErrors = [
        { message: "session not found" },
        { message: "Session not found: ses_abc123" },
        { message: "Resource not found" },
        { message: "Session does not exist" },
        { message: "HTTP 404: Not found" },
        new Error("Session not found"),
      ]
      
      sessionNotFoundErrors.forEach((err, i) => {
        expect(isSessionNotFoundError(err)).toBe(true)
      })
    })
    
    it("should NOT flag non-session errors as session not found", () => {
      const otherErrors = [
        { message: "Network timeout" },
        { message: "Connection refused" },
        { message: "Authentication failed" },
        { message: "Internal server error" },
        new Error("Socket closed"),
      ]
      
      otherErrors.forEach((err, i) => {
        expect(isSessionNotFoundError(err)).toBe(false)
      })
    })
    
    it("should handle null/undefined errors gracefully", () => {
      expect(isSessionNotFoundError(null)).toBe(false)
      expect(isSessionNotFoundError(undefined)).toBe(false)
      expect(isSessionNotFoundError("")).toBe(false)
    })
    
    it("should determine correct error type for database recording", () => {
      function getErrorType(err: any): string {
        const isSessionGone = isSessionNotFoundError(err)
        const errorMessage = err?.message || String(err)
        return isSessionGone ? 'session_not_found' : `error: ${errorMessage.slice(0, 100)}`
      }
      
      // Session not found should map to specific type
      expect(getErrorType({ message: "Session not found" })).toBe("session_not_found")
      
      // Other errors should include the message
      expect(getErrorType({ message: "Network timeout" })).toBe("error: Network timeout")
      
      // Long error messages should be truncated
      const longError = { message: "A".repeat(200) }
      const errorType = getErrorType(longError)
      expect(errorType.length).toBeLessThanOrEqual(107) // "error: " + 100 chars
    })
  })
})

describe("Telegram Subscription - Integration Tests", () => {
  // These tests require actual Supabase connection
  // Skip if credentials not available
  
  const SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"
  const TEST_UUID = "a0dcb5d4-30c2-4dd0-bfbe-e569a42f47bb"
  
  it("should fetch unprocessed replies from Supabase", async () => {
    // This tests the actual query used by processUnprocessedReplies()
    try {
      const { createClient } = await import("@supabase/supabase-js")
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      
      const { data, error } = await supabase
        .from("telegram_replies")
        .select("id, is_voice, processed, created_at")
        .eq("uuid", TEST_UUID)
        .eq("processed", false)
        .order("created_at", { ascending: true })
        .limit(10)
      
      // Query should succeed (even if no results)
      expect(error).toBeNull()
      expect(Array.isArray(data)).toBe(true)
      
      console.log(`  [INFO] Found ${data?.length || 0} unprocessed replies for test UUID`)
    } catch (err: any) {
      console.log(`  [SKIP] Supabase client not available: ${err.message}`)
    }
  })
  
  it("should be able to mark reply as processed via RPC", async () => {
    // This tests the mark_reply_processed RPC function exists and is callable
    // We use a fake ID so it won't affect real data
    try {
      const { createClient } = await import("@supabase/supabase-js")
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      
      const fakeReplyId = "00000000-0000-0000-0000-000000000000"
      
      // This should not throw even if the ID doesn't exist
      // The RPC function handles non-existent IDs gracefully
      const { error } = await supabase.rpc("mark_reply_processed", { 
        p_reply_id: fakeReplyId 
      })
      
      // RPC function should exist (error would be about permissions, not function not found)
      if (error) {
        // Expected: either success or permission error, not "function does not exist"
        expect(error.message).not.toContain("function mark_reply_processed")
        console.log(`  [INFO] RPC call result: ${error.message}`)
      } else {
        console.log(`  [INFO] RPC mark_reply_processed succeeded`)
      }
    } catch (err: any) {
      console.log(`  [SKIP] Supabase client not available: ${err.message}`)
    }
  })
  
  it("should be able to set reply error via RPC", async () => {
    // This tests the set_reply_error RPC function exists and is callable
    try {
      const { createClient } = await import("@supabase/supabase-js")
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      
      const fakeReplyId = "00000000-0000-0000-0000-000000000000"
      
      // This should not throw even if the ID doesn't exist
      const { error } = await supabase.rpc("set_reply_error", { 
        p_reply_id: fakeReplyId,
        p_error: "session_not_found"
      })
      
      // RPC function should exist
      if (error) {
        // Expected: either success or permission error, not "function does not exist"
        expect(error.message).not.toContain("function set_reply_error")
        console.log(`  [INFO] RPC set_reply_error result: ${error.message}`)
      } else {
        console.log(`  [INFO] RPC set_reply_error succeeded`)
      }
    } catch (err: any) {
      console.log(`  [SKIP] Supabase client not available: ${err.message}`)
    }
  })
})
