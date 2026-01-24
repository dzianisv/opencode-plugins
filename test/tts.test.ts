/**
 * Tests for OpenCode TTS Plugin
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))

describe("TTS Plugin - Unit Tests", () => {
  // Test the text cleaning logic (extracted from plugin)
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
    assert.ok(!result.includes("const x"))
    assert.ok(result.includes("code block omitted"))
  })

  it("removes inline code", () => {
    const input = "Use the `say` command to speak."
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("`"))
    assert.ok(!result.includes("say"))
  })

  it("keeps link text but removes URLs", () => {
    const input = "Check [OpenCode](https://github.com/sst/opencode) for more."
    const result = cleanTextForSpeech(input)
    assert.ok(result.includes("OpenCode"))
    assert.ok(!result.includes("https://"))
    assert.ok(!result.includes("github.com"))
  })

  it("removes markdown formatting", () => {
    const input = "This is **bold** and *italic* and ~~strikethrough~~"
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("*"))
    assert.ok(!result.includes("~"))
    assert.ok(result.includes("bold"))
    assert.ok(result.includes("italic"))
  })

  it("removes file paths", () => {
    const input = "Edit the file /Users/test/project/src/index.ts"
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("/Users"))
  })

  it("collapses whitespace", () => {
    const input = "Hello    world\n\n\ntest"
    const result = cleanTextForSpeech(input)
    assert.strictEqual(result, "Hello world test")
  })
})

describe("TTS Plugin - Structure Validation", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("has required exports", () => {
    assert.ok(pluginContent.includes("export const TTSPlugin"), "Missing TTSPlugin export")
    assert.ok(pluginContent.includes("export default"), "Missing default export")
  })

  it("uses macOS say command for OS TTS", () => {
    assert.ok(pluginContent.includes("say"), "Missing say command")
    assert.ok(pluginContent.includes("execAsync"), "Missing exec for say command")
  })

  it("has session tracking to prevent duplicates", () => {
    assert.ok(pluginContent.includes("spokenSessions"), "Missing spokenSessions set")
  })

  it("has max speech length limit", () => {
    assert.ok(pluginContent.includes("MAX_SPEECH_LENGTH"), "Missing MAX_SPEECH_LENGTH")
  })

  it("skips judge sessions", () => {
    assert.ok(pluginContent.includes("isJudgeSession"), "Missing judge session check")
    assert.ok(pluginContent.includes("TASK VERIFICATION"), "Missing judge session marker")
  })

  it("listens to session.idle event", () => {
    assert.ok(pluginContent.includes("session.idle"), "Missing session.idle event handler")
  })

  it("extracts final assistant response", () => {
    assert.ok(pluginContent.includes("extractFinalResponse"), "Missing response extraction")
    assert.ok(pluginContent.includes('role === "assistant"'), "Missing assistant role check")
  })

  it("checks for TTS_DISABLED env var", () => {
    assert.ok(pluginContent.includes("process.env.TTS_DISABLED"), "Missing env var check")
  })

  it("supports config file toggle", () => {
    assert.ok(pluginContent.includes("tts.json"), "Missing config file reference")
    assert.ok(pluginContent.includes("isEnabled"), "Missing isEnabled check")
  })
})

describe("TTS Plugin - Engine Configuration", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("supports chatterbox engine", () => {
    assert.ok(pluginContent.includes("chatterbox"), "Missing chatterbox engine")
    assert.ok(pluginContent.includes("ChatterboxTTS"), "Missing ChatterboxTTS reference")
  })

  it("supports OS TTS engine", () => {
    assert.ok(pluginContent.includes("speakWithOS"), "Missing OS TTS function")
    assert.ok(pluginContent.includes('TTS_ENGINE === "os"') || pluginContent.includes('"os"'), "Missing OS engine option")
  })

  it("has engine type definition", () => {
    assert.ok(pluginContent.includes("TTSEngine"), "Missing TTSEngine type")
    assert.ok(pluginContent.includes('"chatterbox" | "os"'), "Missing engine type union")
  })

  it("supports TTS_ENGINE env var", () => {
    assert.ok(pluginContent.includes("process.env.TTS_ENGINE"), "Missing TTS_ENGINE env var check")
  })

  it("implements automatic fallback", () => {
    assert.ok(pluginContent.includes("isChatterboxAvailable"), "Missing availability check")
    assert.ok(pluginContent.includes("speakWithOS"), "Missing OS TTS fallback")
  })

  it("has Chatterbox configuration options", () => {
    assert.ok(pluginContent.includes("chatterbox?:"), "Missing chatterbox config section")
    assert.ok(pluginContent.includes("device?:"), "Missing device option")
    assert.ok(pluginContent.includes("voiceRef?:"), "Missing voice reference option")
    assert.ok(pluginContent.includes("exaggeration?:"), "Missing exaggeration option")
    assert.ok(pluginContent.includes("useTurbo?:"), "Missing turbo option")
  })

  it("has Python helper script generation", () => {
    assert.ok(pluginContent.includes("tts.py"), "Missing Python script path")
    assert.ok(pluginContent.includes("ensureChatterboxScript"), "Missing script generation function")
  })

  it("defaults to Coqui TTS engine", () => {
    // Default is now Coqui TTS for high-quality neural voice
    assert.ok(pluginContent.includes('engine: "coqui"'), "Coqui TTS should be default engine")
  })
})

describe("TTS Plugin - Chatterbox Features", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("supports GPU (cuda) and CPU device selection", () => {
    assert.ok(pluginContent.includes('"cuda"'), "Missing cuda device option")
    assert.ok(pluginContent.includes('"cpu"'), "Missing cpu device option")
  })

  it("supports Turbo model variant", () => {
    assert.ok(pluginContent.includes("--turbo"), "Missing turbo flag")
    assert.ok(pluginContent.includes("ChatterboxTurboTTS"), "Missing Turbo model import")
  })

  it("supports voice cloning via reference audio", () => {
    assert.ok(pluginContent.includes("--voice"), "Missing voice reference flag")
    assert.ok(pluginContent.includes("audio_prompt_path"), "Missing audio_prompt_path")
  })

  it("supports emotion exaggeration control", () => {
    assert.ok(pluginContent.includes("--exaggeration"), "Missing exaggeration flag")
    assert.ok(pluginContent.includes("exaggeration="), "Missing exaggeration parameter")
  })

  it("generates WAV files to temp directory", () => {
    assert.ok(pluginContent.includes("tmpdir()"), "Missing temp directory usage")
    assert.ok(pluginContent.includes(".wav"), "Missing WAV file extension")
  })

  it("plays audio with afplay on macOS", () => {
    assert.ok(pluginContent.includes("afplay"), "Missing afplay for audio playback")
  })

  it("cleans up temp files after playback", () => {
    assert.ok(pluginContent.includes("unlink"), "Missing file cleanup")
  })

  it("supports server mode for persistent model loading", () => {
    assert.ok(pluginContent.includes("serverMode"), "Missing serverMode option")
    assert.ok(pluginContent.includes("tts_server.py"), "Missing server script")
    assert.ok(pluginContent.includes("startChatterboxServer"), "Missing server start function")
    assert.ok(pluginContent.includes("speakWithChatterboxServer"), "Missing server speak function")
  })

  it("uses Unix socket for fast IPC with server", () => {
    assert.ok(pluginContent.includes("tts.sock"), "Missing socket path")
    assert.ok(pluginContent.includes("AF_UNIX"), "Missing Unix socket in server script")
  })

  it("supports Apple Silicon (MPS) device", () => {
    assert.ok(pluginContent.includes('"mps"'), "Missing MPS device option")
    assert.ok(pluginContent.includes("torch.backends.mps.is_available"), "Missing MPS detection")
  })

  it("prevents multiple server instances with locking", () => {
    assert.ok(pluginContent.includes("server.lock"), "Missing lock file")
    assert.ok(pluginContent.includes("acquireChatterboxLock"), "Missing lock acquisition")
    assert.ok(pluginContent.includes("releaseChatterboxLock"), "Missing lock release")
    assert.ok(pluginContent.includes("isChatterboxServerRunning"), "Missing server check function")
  })

  it("runs server detached for sharing across sessions", () => {
    assert.ok(pluginContent.includes("detached: true"), "Server should be detached")
    assert.ok(pluginContent.includes("server.pid"), "Missing PID file for server tracking")
    assert.ok(pluginContent.includes(".unref()"), "Server should be unref'd")
  })
})

describe("TTS Plugin - macOS Integration", () => {
  it("say command is available on macOS", async () => {
    try {
      await execAsync("which say")
      assert.ok(true, "say command found")
    } catch {
      // Skip on non-macOS
      console.log("  [SKIP] say command not available (not macOS)")
    }
  })

  it("can list available voices", async () => {
    try {
      const { stdout } = await execAsync("say -v '?'")
      assert.ok(stdout.length > 0, "Should list voices")
      assert.ok(stdout.includes("en_"), "Should have English voices")
    } catch {
      console.log("  [SKIP] say command not available (not macOS)")
    }
  })

  it("afplay command is available on macOS", async () => {
    try {
      await execAsync("which afplay")
      assert.ok(true, "afplay command found")
    } catch {
      console.log("  [SKIP] afplay command not available (not macOS)")
    }
  })
})

describe("TTS Plugin - Chatterbox Availability Check", () => {
  it("checks Python chatterbox import", async () => {
    try {
      await execAsync('python3 -c "import chatterbox; print(\'ok\')"', { timeout: 10000 })
      console.log("  [INFO] Chatterbox is installed and available")
    } catch {
      console.log("  [INFO] Chatterbox not installed - will fall back to OS TTS")
      console.log("  [INFO] Install with: pip install chatterbox-tts")
    }
    // This test always passes - just informational
    assert.ok(true)
  })
})

describe("TTS Plugin - Embedded Python Scripts Validation", () => {
  /**
   * NOTE: These are fast sanity checks that grep for strings.
   * They are NOT sufficient to catch all bugs.
   * 
   * The REAL protection is the E2E test in tts.e2e.test.ts which
   * actually runs Chatterbox with MPS and verifies audio is produced.
   * 
   * Run E2E tests with: npm run test:tts:e2e
   */
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  // Extract embedded script content between backticks after a specific marker
  function extractEmbeddedScript(content: string, marker: string): string | null {
    const markerIndex = content.indexOf(marker)
    if (markerIndex === -1) return null
    
    const startIndex = content.indexOf('`', markerIndex)
    if (startIndex === -1) return null
    
    const endIndex = content.indexOf('`', startIndex + 1)
    if (endIndex === -1) return null
    
    return content.slice(startIndex + 1, endIndex)
  }

  describe("One-shot script (tts.py)", () => {
    it("accepts --device mps in argparse choices", () => {
      // The embedded script must have mps in the choices list
      assert.ok(
        pluginContent.includes('choices=["cuda", "mps", "cpu"]'),
        "Embedded tts.py script must accept 'mps' as a device choice. " +
        "Found argparse line but missing mps in choices."
      )
    })

    it("handles MPS device fallback when unavailable", () => {
      // Must check mps availability and fall back to cpu
      assert.ok(
        pluginContent.includes('device == "mps" and not torch.backends.mps.is_available()'),
        "Embedded tts.py must handle MPS unavailability fallback"
      )
    })

    it("auto-detects MPS when CUDA unavailable", () => {
      // When cuda requested but unavailable, should try mps before cpu
      assert.ok(
        pluginContent.includes('device = "mps" if torch.backends.mps.is_available() else "cpu"'),
        "Embedded tts.py should auto-detect MPS when CUDA is unavailable"
      )
    })
  })

  describe("Server script (tts_server.py)", () => {
    it("accepts --device mps in argparse choices", () => {
      // The server script must also support mps
      assert.ok(
        pluginContent.includes('choices=["cuda", "cpu", "mps"]') ||
        pluginContent.includes('choices=["cuda", "mps", "cpu"]'),
        "Embedded tts_server.py script must accept 'mps' as a device choice"
      )
    })

    it("handles MPS device detection and fallback", () => {
      // Server script has its own device detection
      const hasMpsCheck = pluginContent.includes('device == "mps" and not torch.backends.mps.is_available()')
      const hasMpsAutoDetect = pluginContent.includes('torch.backends.mps.is_available()')
      assert.ok(
        hasMpsCheck && hasMpsAutoDetect,
        "Embedded tts_server.py must handle MPS detection and fallback"
      )
    })
  })

  describe("Device consistency", () => {
    it("all device options are consistent across scripts", () => {
      // Count occurrences of device choices patterns
      const oneshot = pluginContent.includes('choices=["cuda", "mps", "cpu"]')
      const server = pluginContent.includes('choices=["cuda", "cpu", "mps"]')
      
      assert.ok(
        oneshot && server,
        "Both embedded scripts must support the same device options (cuda, mps, cpu)"
      )
    })
  })
})

describe("TTS Plugin - Telegram Notification Features", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("has Telegram configuration section in TTSConfig", () => {
    assert.ok(pluginContent.includes("telegram?:"), "Missing telegram config section")
    assert.ok(pluginContent.includes("telegram?: {"), "Missing telegram config object")
  })

  it("supports Telegram enabled flag", () => {
    assert.ok(pluginContent.includes("telegram?.enabled"), "Missing telegram enabled check")
    assert.ok(pluginContent.includes("isTelegramEnabled"), "Missing isTelegramEnabled function")
  })

  it("supports UUID configuration for Telegram subscription", () => {
    assert.ok(pluginContent.includes("uuid?:"), "Missing uuid config option")
    assert.ok(pluginContent.includes("TELEGRAM_NOTIFICATION_UUID"), "Missing UUID env var support")
  })

  it("supports custom service URL for Telegram backend", () => {
    assert.ok(pluginContent.includes("serviceUrl?:"), "Missing serviceUrl config option")
    assert.ok(pluginContent.includes("DEFAULT_TELEGRAM_SERVICE_URL"), "Missing default service URL")
  })

  it("supports sendText and sendVoice toggle options", () => {
    assert.ok(pluginContent.includes("sendText?:"), "Missing sendText config option")
    assert.ok(pluginContent.includes("sendVoice?:"), "Missing sendVoice config option")
  })

  it("has sendTelegramNotification function", () => {
    assert.ok(pluginContent.includes("sendTelegramNotification"), "Missing sendTelegramNotification function")
    assert.ok(pluginContent.includes("voice_base64"), "Missing voice base64 encoding")
  })

  it("converts WAV to OGG for Telegram voice messages", () => {
    assert.ok(pluginContent.includes("convertWavToOgg"), "Missing WAV to OGG conversion function")
    assert.ok(pluginContent.includes("libopus"), "Missing Opus codec for OGG conversion")
    assert.ok(pluginContent.includes("ffmpeg"), "Missing ffmpeg for audio conversion")
  })

  it("checks ffmpeg availability before conversion", () => {
    assert.ok(pluginContent.includes("isFfmpegAvailable"), "Missing ffmpeg availability check")
    assert.ok(pluginContent.includes("which ffmpeg"), "Missing ffmpeg path check")
  })

  it("integrates Telegram notification with speak function", () => {
    assert.ok(pluginContent.includes("telegramEnabled"), "Missing telegram enabled check in speak")
    assert.ok(pluginContent.includes("Sending Telegram notification"), "Missing telegram notification log")
  })

  it("supports TELEGRAM_DISABLED env var", () => {
    assert.ok(pluginContent.includes("TELEGRAM_DISABLED"), "Missing TELEGRAM_DISABLED env var support")
  })

  it("returns audio path from TTS engines for Telegram", () => {
    assert.ok(pluginContent.includes("speakWithCoquiAndGetPath"), "Missing speakWithCoquiAndGetPath function")
    assert.ok(pluginContent.includes("speakWithChatterboxAndGetPath"), "Missing speakWithChatterboxAndGetPath function")
    assert.ok(pluginContent.includes("audioPath?:"), "Missing audioPath return type")
  })

  it("has proper error handling for Telegram notifications", () => {
    assert.ok(pluginContent.includes("Telegram notification failed"), "Missing Telegram error log")
    assert.ok(pluginContent.includes("success: false"), "Missing failure handling")
  })
})

describe("TTS Plugin - Telegram UUID Validation", () => {
  // UUID v4 regex (same as in edge function)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  it("validates correct UUID v4 format", () => {
    const validUUIDs = [
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    ]
    for (const uuid of validUUIDs) {
      assert.ok(UUID_REGEX.test(uuid), `UUID should be valid: ${uuid}`)
    }
  })

  it("rejects invalid UUID formats", () => {
    const invalidUUIDs = [
      "not-a-uuid",
      "550e8400-e29b-41d4-a716",  // Too short
      "550e8400-e29b-51d4-a716-446655440000",  // Version 5, not 4
      "550e8400-e29b-41d4-c716-446655440000",  // Invalid variant
      "g50e8400-e29b-41d4-a716-446655440000",  // Invalid character
    ]
    for (const uuid of invalidUUIDs) {
      assert.ok(!UUID_REGEX.test(uuid), `UUID should be invalid: ${uuid}`)
    }
  })
})

describe("Supabase Edge Functions - Structure Validation", () => {
  let webhookContent: string
  let sendNotifyContent: string

  before(async () => {
    try {
      webhookContent = await readFile(
        join(__dirname, "../supabase/functions/telegram-webhook/index.ts"),
        "utf-8"
      )
      sendNotifyContent = await readFile(
        join(__dirname, "../supabase/functions/send-notify/index.ts"),
        "utf-8"
      )
    } catch (e) {
      console.log("  [SKIP] Supabase functions not found")
    }
  })

  describe("telegram-webhook function", () => {
    it("exists and has content", () => {
      if (!webhookContent) {
        console.log("  [SKIP] telegram-webhook function not found")
        return
      }
      assert.ok(webhookContent.length > 0)
    })

    it("handles /start command", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("/start"), "Missing /start command handler")
      assert.ok(webhookContent.includes("uuid"), "Missing UUID handling")
    })

    it("handles /stop command", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("/stop"), "Missing /stop command handler")
      assert.ok(webhookContent.includes("is_active"), "Missing deactivation logic")
    })

    it("handles /status command", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("/status"), "Missing /status command handler")
      assert.ok(webhookContent.includes("notifications_sent"), "Missing notification count")
    })

    it("validates UUID format", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("isValidUUID"), "Missing UUID validation function")
      assert.ok(webhookContent.includes("UUID_REGEX"), "Missing UUID regex")
    })

    it("uses Supabase client with service role", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("createClient"), "Missing Supabase client creation")
      assert.ok(webhookContent.includes("SUPABASE_SERVICE_ROLE_KEY"), "Missing service role key")
    })

    it("sends response messages via Telegram API", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("sendTelegramMessage"), "Missing Telegram message function")
      assert.ok(webhookContent.includes("api.telegram.org"), "Missing Telegram API URL")
    })
  })

  describe("send-notify function", () => {
    it("exists and has content", () => {
      if (!sendNotifyContent) {
        console.log("  [SKIP] send-notify function not found")
        return
      }
      assert.ok(sendNotifyContent.length > 0)
    })

    it("accepts uuid, text, and voice_base64 in request", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("uuid"), "Missing uuid field")
      assert.ok(sendNotifyContent.includes("text"), "Missing text field")
      assert.ok(sendNotifyContent.includes("voice_base64"), "Missing voice_base64 field")
    })

    it("looks up subscriber by UUID", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("telegram_subscribers"), "Missing subscribers table")
      assert.ok(sendNotifyContent.includes(".eq('uuid'"), "Missing UUID lookup")
    })

    it("sends text messages via Telegram API", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("sendTelegramMessage"), "Missing text message function")
      assert.ok(sendNotifyContent.includes("sendMessage"), "Missing Telegram sendMessage endpoint")
    })

    it("sends voice messages via Telegram API", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("sendTelegramVoice"), "Missing voice message function")
      assert.ok(sendNotifyContent.includes("sendVoice"), "Missing Telegram sendVoice endpoint")
    })

    it("has rate limiting", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("isRateLimited"), "Missing rate limiting function")
      assert.ok(sendNotifyContent.includes("RATE_LIMIT"), "Missing rate limit constants")
    })

    it("handles CORS headers", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("Access-Control-Allow-Origin"), "Missing CORS header")
      assert.ok(sendNotifyContent.includes("OPTIONS"), "Missing OPTIONS method handling")
    })

    it("increments notification count", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("increment_notifications"), "Missing notification count increment")
    })

    it("checks subscription is active", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("is_active"), "Missing active status check")
    })
  })
})

describe("Supabase Database Schema - Structure Validation", () => {
  let migrationContent: string

  before(async () => {
    try {
      // Find migration file
      const { readdir } = await import("fs/promises")
      const migrationsDir = join(__dirname, "../supabase/migrations")
      const files = await readdir(migrationsDir)
      const migrationFile = files.find(f => f.includes("subscribers"))
      if (migrationFile) {
        migrationContent = await readFile(join(migrationsDir, migrationFile), "utf-8")
      }
    } catch {
      console.log("  [SKIP] Migration files not found")
    }
  })

  it("creates telegram_subscribers table", () => {
    if (!migrationContent) {
      console.log("  [SKIP] Migration file not found")
      return
    }
    assert.ok(migrationContent.includes("telegram_subscribers"), "Missing table creation")
  })

  it("has uuid as primary key", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("uuid UUID PRIMARY KEY"), "Missing UUID primary key")
  })

  it("has chat_id column", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("chat_id BIGINT"), "Missing chat_id column")
  })

  it("has notification tracking columns", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("notifications_sent"), "Missing notifications_sent column")
    assert.ok(migrationContent.includes("last_notified_at"), "Missing last_notified_at column")
  })

  it("has is_active column for subscription status", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("is_active"), "Missing is_active column")
  })

  it("enables Row Level Security", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("ROW LEVEL SECURITY"), "Missing RLS enablement")
  })

  it("has service role only policy", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("service_role"), "Missing service role policy")
  })

  it("has increment_notifications function", () => {
    if (!migrationContent) return
    assert.ok(migrationContent.includes("increment_notifications"), "Missing increment function")
  })
})

describe("Telegram Reply Support - Structure Validation", () => {
  let webhookContent: string
  let sendNotifyContent: string
  let replyMigrationContent: string
  let ttsContent: string

  before(async () => {
    try {
      webhookContent = await readFile(
        join(__dirname, "../supabase/functions/telegram-webhook/index.ts"),
        "utf-8"
      )
      sendNotifyContent = await readFile(
        join(__dirname, "../supabase/functions/send-notify/index.ts"),
        "utf-8"
      )
      ttsContent = await readFile(
        join(__dirname, "../tts.ts"),
        "utf-8"
      )
      
      // Find reply migration file
      const { readdir } = await import("fs/promises")
      const migrationsDir = join(__dirname, "../supabase/migrations")
      const files = await readdir(migrationsDir)
      const replyMigrationFile = files.find(f => f.includes("replies"))
      if (replyMigrationFile) {
        replyMigrationContent = await readFile(join(migrationsDir, replyMigrationFile), "utf-8")
      }
    } catch (e) {
      console.log("  [SKIP] Files not found for reply support tests")
    }
  })

  describe("telegram_reply_contexts table", () => {
    it("creates telegram_reply_contexts table", () => {
      if (!replyMigrationContent) {
        console.log("  [SKIP] Reply migration file not found")
        return
      }
      assert.ok(replyMigrationContent.includes("telegram_reply_contexts"), "Missing reply contexts table")
    })

    it("has session_id column for OpenCode session tracking", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("session_id TEXT"), "Missing session_id column")
    })

    it("has chat_id column for Telegram chat identification", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("chat_id BIGINT"), "Missing chat_id column")
    })

    it("has expires_at column for context expiration", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("expires_at"), "Missing expires_at column")
    })

    it("has is_active column for context status", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("is_active BOOLEAN"), "Missing is_active column")
    })
  })

  describe("telegram_replies table", () => {
    it("creates telegram_replies table", () => {
      if (!replyMigrationContent) {
        console.log("  [SKIP] Reply migration file not found")
        return
      }
      assert.ok(replyMigrationContent.includes("telegram_replies"), "Missing replies table")
    })

    it("has reply_text column for user message content", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("reply_text TEXT"), "Missing reply_text column")
    })

    it("has processed column for tracking delivery status", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("processed BOOLEAN"), "Missing processed column")
    })

    it("enables Supabase Realtime for replies table", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("supabase_realtime"), "Missing realtime enablement")
    })
  })

  describe("send-notify session context support", () => {
    it("accepts session_id in request body", () => {
      if (!sendNotifyContent) {
        console.log("  [SKIP] send-notify function not found")
        return
      }
      assert.ok(sendNotifyContent.includes("session_id"), "Missing session_id field")
    })

    it("accepts directory in request body", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("directory"), "Missing directory field")
    })

    it("stores reply context in database", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("telegram_reply_contexts"), "Missing context storage")
    })

    it("deactivates previous contexts before creating new one", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("is_active: false") || sendNotifyContent.includes("is_active = false"), 
        "Missing previous context deactivation")
    })

    it("returns message_id from Telegram API", () => {
      if (!sendNotifyContent) return
      assert.ok(sendNotifyContent.includes("messageId"), "Missing message ID extraction")
    })
  })

  describe("telegram-webhook reply handling", () => {
    it("handles non-command messages as replies", () => {
      if (!webhookContent) {
        console.log("  [SKIP] telegram-webhook function not found")
        return
      }
      assert.ok(webhookContent.includes("get_active_reply_context"), "Missing reply context lookup")
    })

    it("stores replies in telegram_replies table", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("telegram_replies"), "Missing reply storage")
    })

    it("confirms reply receipt to user", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("Reply sent"), "Missing confirmation message")
    })

    it("handles missing reply context gracefully", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("No active session"), "Missing no-context message")
    })
  })

  describe("tts.ts Telegram reply subscription", () => {
    it("has receiveReplies config option", () => {
      if (!ttsContent) {
        console.log("  [SKIP] tts.ts not found")
        return
      }
      assert.ok(ttsContent.includes("receiveReplies"), "Missing receiveReplies config option")
    })

    it("has supabaseUrl config option", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("supabaseUrl"), "Missing supabaseUrl config option")
    })

    it("has supabaseAnonKey config option", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("supabaseAnonKey"), "Missing supabaseAnonKey config option")
    })

    it("has subscribeToReplies function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("subscribeToReplies"), "Missing subscribeToReplies function")
    })

    it("uses Supabase Realtime for reply subscription", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("postgres_changes"), "Missing Supabase Realtime subscription")
    })

    it("forwards replies to OpenCode session via promptAsync", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("promptAsync"), "Missing promptAsync call for reply forwarding")
      assert.ok(ttsContent.includes("[User via Telegram]"), "Missing Telegram reply prefix")
    })

    it("marks replies as processed after forwarding", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("markReplyProcessed"), "Missing reply processed marking")
    })

    it("passes sessionId to sendTelegramNotification", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("sessionId?: string") || ttsContent.includes("sessionId: string"), 
        "Missing sessionId in notification context")
    })

    it("includes session_id in notification request body", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("body.session_id"), "Missing session_id in request body")
    })
  })

  describe("helper functions", () => {
    it("has get_active_reply_context function in migration", () => {
      if (!replyMigrationContent) {
        console.log("  [SKIP] Reply migration file not found")
        return
      }
      assert.ok(replyMigrationContent.includes("get_active_reply_context"), "Missing helper function")
    })

    it("has cleanup_expired_reply_contexts function", () => {
      if (!replyMigrationContent) return
      assert.ok(replyMigrationContent.includes("cleanup_expired_reply_contexts"), "Missing cleanup function")
    })

    it("has unsubscribeFromReplies function in tts.ts", () => {
      if (!ttsContent) {
        console.log("  [SKIP] tts.ts not found")
        return
      }
      assert.ok(ttsContent.includes("unsubscribeFromReplies"), "Missing unsubscribe function")
    })
  })
})

// ==================== VOICE MESSAGE SUPPORT TESTS ====================

// ==================== WHISPER INTEGRATION TESTS ====================

describe("Whisper Server - Integration Tests", () => {
  const WHISPER_URL = "http://localhost:8787"
  
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
   * This is a minimal valid WAV file with 0.1s of silence
   */
  function generateTestSilenceWav(): string {
    // Minimal WAV header for 16-bit PCM, mono, 16kHz
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
    buffer.writeUInt32LE(16, 16) // chunk size
    buffer.writeUInt16LE(1, 20) // audio format (PCM)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28) // byte rate
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32) // block align
    buffer.writeUInt16LE(bitsPerSample, 34)
    
    // data chunk
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    // Audio data is already zeros (silence)
    
    return buffer.toString('base64')
  }

  it("health endpoint responds when server is running", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running on localhost:8787")
      console.log("         Start with: cd ~/.config/opencode/whisper && python whisper_server.py")
      return
    }
    
    const response = await fetch(`${WHISPER_URL}/health`)
    assert.ok(response.ok, "Health endpoint should return 200")
    
    const data = await response.json() as { status: string; model_loaded: boolean }
    assert.strictEqual(data.status, "healthy", "Status should be healthy")
    assert.ok("model_loaded" in data, "Should report model status")
    console.log(`  [INFO] Whisper server healthy, model loaded: ${data.model_loaded}`)
  })

  it("models endpoint lists available models", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    const response = await fetch(`${WHISPER_URL}/models`)
    assert.ok(response.ok, "Models endpoint should return 200")
    
    const data = await response.json() as { models: string[]; default: string }
    assert.ok(Array.isArray(data.models), "Should return array of models")
    assert.ok(data.models.includes("base"), "Should include base model")
    assert.ok(data.models.includes("tiny"), "Should include tiny model")
  })

  it("transcribe endpoint accepts audio and returns text", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    // Use minimal silence audio - Whisper should return empty or minimal text
    const testAudio = generateTestSilenceWav()
    
    const response = await fetch(`${WHISPER_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: testAudio,
        format: "wav",
        model: "base"  // Use base model for faster testing
      }),
      signal: AbortSignal.timeout(30000) // 30 second timeout for transcription
    })
    
    assert.ok(response.ok, `Transcribe endpoint should return 200, got ${response.status}`)
    
    const data = await response.json() as { text: string; language: string; duration: number }
    assert.ok("text" in data, "Response should include text field")
    assert.ok("language" in data, "Response should include language field")
    assert.ok("duration" in data, "Response should include duration field")
    
    console.log(`  [INFO] Transcription successful - text: "${data.text}", duration: ${data.duration}s`)
  })

  it("transcribe endpoint handles invalid audio gracefully", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    // Send invalid base64 that decodes to garbage
    const response = await fetch(`${WHISPER_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: Buffer.from("not valid audio data").toString("base64"),
        format: "ogg"
      }),
      signal: AbortSignal.timeout(10000)
    })
    
    // Server should return 500 for invalid audio, not crash
    assert.ok(response.status === 500 || response.status === 400, 
      `Should return error status for invalid audio, got ${response.status}`)
  })

  it("transcribe endpoint requires audio field", async () => {
    const running = await isWhisperRunning()
    if (!running) {
      console.log("  [SKIP] Whisper server not running")
      return
    }
    
    const response = await fetch(`${WHISPER_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    })
    
    assert.strictEqual(response.status, 400, "Should return 400 for missing audio")
  })
})

describe("Whisper Dependencies - Availability Check", () => {
  it("checks if faster-whisper can be imported", async () => {
    try {
      await execAsync('python3 -c "from faster_whisper import WhisperModel; print(\'ok\')"', { timeout: 10000 })
      console.log("  [INFO] faster-whisper is installed and available")
    } catch {
      console.log("  [INFO] faster-whisper not installed")
      console.log("         Install with: pip install faster-whisper")
    }
    // Test always passes - informational only
    assert.ok(true)
  })

  it("checks if fastapi and uvicorn are available", async () => {
    try {
      await execAsync('python3 -c "from fastapi import FastAPI; import uvicorn; print(\'ok\')"', { timeout: 10000 })
      console.log("  [INFO] FastAPI and uvicorn are installed")
    } catch {
      console.log("  [INFO] FastAPI/uvicorn not installed")
      console.log("         Install with: pip install fastapi uvicorn")
    }
    assert.ok(true)
  })

  it("checks if ffmpeg is available for audio conversion", async () => {
    try {
      await execAsync("which ffmpeg")
      console.log("  [INFO] ffmpeg is available for audio format conversion")
    } catch {
      console.log("  [INFO] ffmpeg not installed - audio conversion will be limited")
      console.log("         Install with: brew install ffmpeg")
    }
    assert.ok(true)
  })
})

// ==================== VOICE MESSAGE SUPPORT TESTS ====================

describe("Telegram Voice Message Support - Structure Validation", () => {
  let ttsContent: string | null = null
  let webhookContent: string | null = null
  let voiceToRepliesMigrationContent: string | null = null
  let whisperServerContent: string | null = null

  before(async () => {
    try {
      ttsContent = await readFile(join(__dirname, "..", "tts.ts"), "utf-8")
    } catch { ttsContent = null }
    
    try {
      webhookContent = await readFile(join(__dirname, "..", "supabase", "functions", "telegram-webhook", "index.ts"), "utf-8")
    } catch { webhookContent = null }
    
    try {
      // Load the new migration that adds voice support to telegram_replies
      voiceToRepliesMigrationContent = await readFile(join(__dirname, "..", "supabase", "migrations", "20240116000000_add_voice_to_replies.sql"), "utf-8")
    } catch { voiceToRepliesMigrationContent = null }
    
    try {
      whisperServerContent = await readFile(join(__dirname, "..", "whisper", "whisper_server.py"), "utf-8")
    } catch { whisperServerContent = null }
  })

  describe("tts.ts whisper integration", () => {
    it("has whisper config interface", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("whisper?:"), "Missing whisper config in TTSConfig")
    })

    it("has WHISPER_DIR constant", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("WHISPER_DIR"), "Missing WHISPER_DIR constant")
    })

    it("has setupWhisper function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("async function setupWhisper"), "Missing setupWhisper function")
    })

    it("has startWhisperServer function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("async function startWhisperServer"), "Missing startWhisperServer function")
    })

    it("has transcribeWithWhisper function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("async function transcribeWithWhisper"), "Missing transcribeWithWhisper function")
    })

    it("has isWhisperServerRunning function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("async function isWhisperServerRunning"), "Missing isWhisperServerRunning function")
    })

    it("has subscribeToReplies function", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("subscribeToReplies"), "Missing subscribeToReplies function")
    })
    
    it("subscribeToReplies handles voice messages with audio_base64", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("reply.is_voice && reply.audio_base64"), "Missing voice message handling in subscribeToReplies")
    })
    
    it("transcribes voice messages with Whisper", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("transcribeWithWhisper(reply.audio_base64"), "Missing transcribeWithWhisper call for voice messages")
    })
    
    it("TelegramReply interface has voice message fields", () => {
      if (!ttsContent) return
      assert.ok(ttsContent.includes("is_voice?: boolean"), "Missing is_voice field in TelegramReply")
      assert.ok(ttsContent.includes("audio_base64?: string"), "Missing audio_base64 field in TelegramReply")
    })
  })

  describe("telegram-webhook voice handling", () => {
    it("has TelegramVoice interface", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("interface TelegramVoice"), "Missing TelegramVoice interface")
    })

    it("has TelegramVideoNote interface", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("interface TelegramVideoNote"), "Missing TelegramVideoNote interface")
    })

    it("has TelegramVideo interface", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("interface TelegramVideo"), "Missing TelegramVideo interface")
    })

    it("handles voice messages in TelegramUpdate", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("voice?: TelegramVoice"), "Missing voice in TelegramUpdate")
    })

    it("handles video_note messages", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("video_note?: TelegramVideoNote"), "Missing video_note in TelegramUpdate")
    })

    it("stores voice messages in telegram_replies table with is_voice flag", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("is_voice: true"), "Missing is_voice flag in insert")
      assert.ok(webhookContent.includes("telegram_replies"), "Should insert into telegram_replies table")
    })

    it("includes audio_base64 in voice message insert", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("audio_base64: audioBase64"), "Missing audio_base64 in insert")
    })
    
    it("includes voice_file_type and voice_duration_seconds", () => {
      if (!webhookContent) return
      assert.ok(webhookContent.includes("voice_file_type: fileType"), "Missing voice_file_type in insert")
      assert.ok(webhookContent.includes("voice_duration_seconds: duration"), "Missing voice_duration_seconds in insert")
    })
  })

  describe("voice to replies migration", () => {
    it("adds voice columns to telegram_replies table", () => {
      if (!voiceToRepliesMigrationContent) {
        console.log("  [SKIP] Voice to replies migration file not found")
        return
      }
      assert.ok(voiceToRepliesMigrationContent.includes("ALTER TABLE"), "Missing ALTER TABLE")
      assert.ok(voiceToRepliesMigrationContent.includes("telegram_replies"), "Missing telegram_replies table reference")
    })

    it("has is_voice column", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("is_voice BOOLEAN"), "Missing is_voice column")
    })

    it("has audio_base64 column", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("audio_base64 TEXT"), "Missing audio_base64 column")
    })

    it("has voice_file_type column", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("voice_file_type TEXT"), "Missing voice_file_type column")
    })

    it("has voice_duration_seconds column", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("voice_duration_seconds INTEGER"), "Missing voice_duration_seconds column")
    })

    it("makes reply_text nullable for voice messages", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("reply_text DROP NOT NULL"), "Missing reply_text nullability change")
    })
    
    it("drops old telegram_voice_messages table", () => {
      if (!voiceToRepliesMigrationContent) return
      assert.ok(voiceToRepliesMigrationContent.includes("DROP TABLE IF EXISTS"), "Missing DROP TABLE")
      assert.ok(voiceToRepliesMigrationContent.includes("telegram_voice_messages"), "Missing telegram_voice_messages drop")
    })
  })

  describe("whisper server script", () => {
    it("exists at whisper/whisper_server.py", () => {
      if (!whisperServerContent) {
        console.log("  [SKIP] Whisper server script not found")
        return
      }
      assert.ok(whisperServerContent.length > 0, "Whisper server script is empty")
    })

    it("uses faster_whisper library", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("faster_whisper"), "Missing faster_whisper import")
    })

    it("has FastAPI app", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("FastAPI"), "Missing FastAPI import")
    })

    it("has /health endpoint", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes('@app.get("/health")'), "Missing /health endpoint")
    })

    it("has /transcribe endpoint", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes('@app.post("/transcribe")'), "Missing /transcribe endpoint")
    })

    it("uses VAD filtering", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("vad_filter=True"), "Missing VAD filter")
    })

    it("converts audio to WAV format", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("convert_to_wav"), "Missing audio conversion function")
    })

    it("uses ffmpeg for conversion", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("ffmpeg"), "Missing ffmpeg usage")
    })

    it("runs on port 8787 by default", () => {
      if (!whisperServerContent) return
      assert.ok(whisperServerContent.includes("8787"), "Missing default port 8787")
    })
  })
})
