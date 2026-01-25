/**
 * TTS (Text-to-Speech) Plugin for OpenCode
 *
 * Reads the final answer aloud when the agent finishes.
 * Supports multiple TTS engines:
 *   - coqui: Coqui TTS - supports multiple models (bark, xtts_v2, tortoise, etc.)
 *   - chatterbox: High-quality neural TTS (auto-installed in virtualenv)
 *   - os: Native OS TTS (macOS `say` command)
 * 
 * Toggle TTS on/off:
 *   /tts       - toggle
 *   /tts on    - enable
 *   /tts off   - disable
 * 
 * Configure engine in ~/.config/opencode/tts.json:
 *   { "enabled": true, "engine": "coqui", "coqui": { "model": "bark" } }
 * 
 * Or set environment variables:
 *   TTS_DISABLED=1     - disable TTS
 *   TTS_ENGINE=coqui   - use Coqui TTS
 *   TTS_ENGINE=os      - use OS TTS
 */

import type { Plugin } from "@opencode-ai/plugin"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import { readFile, writeFile, access, unlink, mkdir, open, readdir, appendFile } from "fs/promises"
import { join } from "path"
import { homedir, tmpdir, platform } from "os"
import * as net from "net"

const execAsync = promisify(exec)

// Maximum characters to read (to avoid very long speeches)
const MAX_SPEECH_LENGTH = 1000

// Track sessions we've already spoken for
const spokenSessions = new Set<string>()

// Config file path for persistent TTS settings
const TTS_CONFIG_PATH = join(homedir(), ".config", "opencode", "tts.json")

// Global speech lock - prevents multiple agents from speaking simultaneously
const SPEECH_LOCK_PATH = join(homedir(), ".config", "opencode", "speech.lock")
const SPEECH_LOCK_TIMEOUT = 120000  // Max speech duration (2 minutes)
const SPEECH_QUEUE_DIR = join(homedir(), ".config", "opencode", "speech-queue")

// Unique identifier for this process instance
const PROCESS_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`

// TTS Engine types
type TTSEngine = "coqui" | "chatterbox" | "os"

// Coqui TTS model types
type CoquiModel = "bark" | "xtts_v2" | "tortoise" | "vits" | "jenny"

interface TTSConfig {
  enabled?: boolean
  engine?: TTSEngine
  // OS TTS options (macOS/Linux)
  os?: {
    voice?: string                    // Voice name (e.g., "Samantha", "Alex"). Run `say -v ?` on macOS to list voices
    rate?: number                     // Speaking rate in words per minute (default: 200)
  }
  // Coqui TTS options (supports bark, xtts_v2, tortoise, vits, etc.)
  coqui?: {
    model?: CoquiModel                // Model to use: "bark", "xtts_v2", "tortoise", "vits" (default: "xtts_v2")
    device?: "cuda" | "cpu" | "mps"   // GPU, CPU, or Apple Silicon (default: auto-detect)
    // XTTS-specific options  
    voiceRef?: string                 // Path to reference voice clip for cloning (XTTS)
    language?: string                 // Language code for XTTS (default: "en")
    speaker?: string                  // Speaker name for XTTS (default: "Ana Florence")
    serverMode?: boolean              // Keep model loaded for fast subsequent requests (default: true)
  }
  // Chatterbox-specific options
  chatterbox?: {
    device?: "cuda" | "cpu" | "mps"   // GPU, CPU, or Apple Silicon (default: auto-detect)
    voiceRef?: string                 // Path to reference voice clip for cloning (REQUIRED for custom voice)
    exaggeration?: number             // Emotion exaggeration (0.0-1.0)
    useTurbo?: boolean                // Use Turbo model for 10x faster inference
    serverMode?: boolean              // Keep model loaded for fast subsequent requests (default: true)
  }
  // Telegram notification options
  telegram?: {
    enabled?: boolean                 // Enable Telegram notifications (default: false)
    uuid?: string                     // User's unique identifier (required for subscription)
    serviceUrl?: string               // Supabase Edge Function URL (has default)
    sendText?: boolean                // Send text message (default: true)
    sendVoice?: boolean               // Send voice message (default: true)
    receiveReplies?: boolean          // Enable receiving replies from Telegram (default: true)
    supabaseUrl?: string              // Supabase project URL (for realtime subscription)
    supabaseAnonKey?: string          // Supabase anonymous key (for realtime subscription)
  }
  // Whisper STT options (for transcribing Telegram voice messages)
  whisper?: {
    enabled?: boolean                   // Enable Whisper STT for voice messages (default: true if telegram enabled)
    model?: string                      // Whisper model: "tiny", "base", "small", "medium", "large-v2", "large-v3"
    device?: "cuda" | "cpu" | "auto"    // Device for inference (default: auto)
    port?: number                       // HTTP server port (default: 8787)
  }
}

// ==================== HELPERS BASE DIRECTORY ====================

const HELPERS_DIR = join(homedir(), ".config", "opencode", "opencode-helpers")

// ==================== WHISPER STT ====================

const WHISPER_DIR = join(HELPERS_DIR, "whisper")
const WHISPER_VENV = join(WHISPER_DIR, "venv")
const WHISPER_SERVER_SCRIPT = join(WHISPER_DIR, "whisper_server.py")
const WHISPER_PID = join(WHISPER_DIR, "server.pid")
const WHISPER_LOCK = join(WHISPER_DIR, "server.lock")
const WHISPER_DEFAULT_PORT = 8787

let whisperInstalled: boolean | null = null
let whisperSetupAttempted = false
let whisperServerProcess: ReturnType<typeof spawn> | null = null

// ==================== CHATTERBOX ====================

const CHATTERBOX_DIR = join(HELPERS_DIR, "chatterbox")
const CHATTERBOX_VENV = join(CHATTERBOX_DIR, "venv")
const CHATTERBOX_SCRIPT = join(CHATTERBOX_DIR, "tts.py")
const CHATTERBOX_SERVER_SCRIPT = join(CHATTERBOX_DIR, "tts_server.py")
const CHATTERBOX_SOCKET = join(CHATTERBOX_DIR, "tts.sock")
const CHATTERBOX_LOCK = join(CHATTERBOX_DIR, "server.lock")
const CHATTERBOX_PID = join(CHATTERBOX_DIR, "server.pid")

let chatterboxInstalled: boolean | null = null
let chatterboxSetupAttempted = false

// ==================== COQUI TTS ====================

const COQUI_DIR = join(HELPERS_DIR, "coqui")
const COQUI_VENV = join(COQUI_DIR, "venv")
const COQUI_SCRIPT = join(COQUI_DIR, "tts.py")
const COQUI_SERVER_SCRIPT = join(COQUI_DIR, "tts_server.py")
const COQUI_SOCKET = join(COQUI_DIR, "tts.sock")
const COQUI_LOCK = join(COQUI_DIR, "server.lock")
const COQUI_PID = join(COQUI_DIR, "server.pid")

let coquiInstalled: boolean | null = null
let coquiSetupAttempted = false

/**
 * Load TTS configuration from file
 */
async function loadConfig(): Promise<TTSConfig> {
  try {
    const content = await readFile(TTS_CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return { 
      enabled: true, 
      engine: "coqui",
      coqui: {
        model: "xtts_v2",
        device: "mps",
        language: "en",
        serverMode: true
      },
      os: {
        voice: "Samantha",
        rate: 200
      }
    }
  }
}

/**
 * Check if TTS is enabled
 */
async function isEnabled(): Promise<boolean> {
  if (process.env.TTS_DISABLED === "1") return false
  const config = await loadConfig()
  return config.enabled !== false
}

/**
 * Get the TTS engine to use
 */
async function getEngine(): Promise<TTSEngine> {
  if (process.env.TTS_ENGINE === "os") return "os"
  if (process.env.TTS_ENGINE === "coqui") return "coqui"
  if (process.env.TTS_ENGINE === "chatterbox") return "chatterbox"
  const config = await loadConfig()
  return config.engine || "coqui"
}

// ==================== SPEECH LOCK (Cross-Process Queue) ====================

/**
 * Speech queue implementation using file-based locking.
 * Ensures multiple OpenCode sessions speak one at a time in FIFO order.
 * 
 * How it works:
 * 1. Each speech request creates a ticket file in SPEECH_QUEUE_DIR with timestamp
 * 2. Process waits until its ticket is the oldest (first in queue)
 * 3. Process acquires the lock, speaks, then releases lock and removes ticket
 * 4. Stale tickets (older than SPEECH_LOCK_TIMEOUT) are auto-cleaned
 */

interface SpeechTicket {
  processId: string
  timestamp: number
  sessionId: string
}

async function ensureQueueDir(): Promise<void> {
  try {
    await mkdir(SPEECH_QUEUE_DIR, { recursive: true })
  } catch {}
}

async function createSpeechTicket(sessionId: string): Promise<string> {
  await ensureQueueDir()
  const timestamp = Date.now()
  const ticketId = `${timestamp}-${PROCESS_ID}-${sessionId}`
  const ticketPath = join(SPEECH_QUEUE_DIR, `${ticketId}.ticket`)
  const ticket: SpeechTicket = {
    processId: PROCESS_ID,
    timestamp,
    sessionId
  }
  await writeFile(ticketPath, JSON.stringify(ticket))
  return ticketId
}

async function removeSpeechTicket(ticketId: string): Promise<void> {
  const ticketPath = join(SPEECH_QUEUE_DIR, `${ticketId}.ticket`)
  await unlink(ticketPath).catch(() => {})
}

async function getQueuedTickets(): Promise<{ id: string; ticket: SpeechTicket }[]> {
  await ensureQueueDir()
  // readdir is now statically imported
  try {
    const files = await readdir(SPEECH_QUEUE_DIR)
    const tickets: { id: string; ticket: SpeechTicket }[] = []
    
    for (const file of files) {
      if (!file.endsWith(".ticket")) continue
      const ticketId = file.replace(".ticket", "")
      const ticketPath = join(SPEECH_QUEUE_DIR, file)
      try {
        const content = await readFile(ticketPath, "utf-8")
        const ticket = JSON.parse(content) as SpeechTicket
        
        // Clean up stale tickets (older than timeout)
        if (Date.now() - ticket.timestamp > SPEECH_LOCK_TIMEOUT) {
          await unlink(ticketPath).catch(() => {})
          continue
        }
        
        tickets.push({ id: ticketId, ticket })
      } catch {
        // Invalid ticket, remove it
        await unlink(ticketPath).catch(() => {})
      }
    }
    
    // Sort by timestamp (FIFO)
    tickets.sort((a, b) => a.ticket.timestamp - b.ticket.timestamp)
    return tickets
  } catch {
    return []
  }
}

async function isMyTurn(ticketId: string): Promise<boolean> {
  const tickets = await getQueuedTickets()
  if (tickets.length === 0) return false
  return tickets[0].id === ticketId
}

async function acquireSpeechLock(ticketId: string): Promise<boolean> {
  // Only acquire lock if it's our turn in the queue
  if (!(await isMyTurn(ticketId))) {
    return false
  }
  
  const lockContent = JSON.stringify({
    processId: PROCESS_ID,
    ticketId,
    timestamp: Date.now()
  })
  
  try {
    // open is now statically imported
    const handle = await open(SPEECH_LOCK_PATH, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      // Lock exists - check if it's stale
      try {
        const content = await readFile(SPEECH_LOCK_PATH, "utf-8")
        const lock = JSON.parse(content)
        if (Date.now() - lock.timestamp > SPEECH_LOCK_TIMEOUT) {
          // Stale lock, remove it and try again
          await unlink(SPEECH_LOCK_PATH).catch(() => {})
          return acquireSpeechLock(ticketId)
        }
      } catch {
        // Corrupted lock file, remove and retry
        await unlink(SPEECH_LOCK_PATH).catch(() => {})
        return acquireSpeechLock(ticketId)
      }
    }
    return false
  }
}

async function releaseSpeechLock(ticketId: string): Promise<void> {
  // Only release if we own the lock
  try {
    const content = await readFile(SPEECH_LOCK_PATH, "utf-8")
    const lock = JSON.parse(content)
    if (lock.processId === PROCESS_ID && lock.ticketId === ticketId) {
      await unlink(SPEECH_LOCK_PATH).catch(() => {})
    }
  } catch {
    // Lock doesn't exist or is corrupted, nothing to release
  }
}

async function waitForSpeechTurn(ticketId: string, timeoutMs: number = 180000): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    // First wait for our turn in the queue
    if (await isMyTurn(ticketId)) {
      // Then try to acquire the lock
      if (await acquireSpeechLock(ticketId)) {
        return true
      }
    }
    // Wait before retrying
    await new Promise(r => setTimeout(r, 500))
  }
  
  // Timeout - remove our ticket and give up
  await removeSpeechTicket(ticketId)
  return false
}

// ==================== UTILITY FUNCTIONS ====================

async function findPython311(): Promise<string | null> {
  const candidates = ["python3.11", "/opt/homebrew/bin/python3.11", "/usr/local/bin/python3.11"]
  for (const py of candidates) {
    try {
      const { stdout } = await execAsync(`${py} --version 2>/dev/null`)
      if (stdout.includes("3.11")) return py
    } catch {
      // Try next
    }
  }
  return null
}

async function findPython3(): Promise<string | null> {
  // Coqui TTS requires Python 3.9-3.11 (not 3.12+)
  const candidates = [
    "python3.11", "python3.10", "python3.9",
    "/opt/homebrew/bin/python3.11", "/opt/homebrew/bin/python3.10", "/opt/homebrew/bin/python3.9",
    "/usr/local/bin/python3.11", "/usr/local/bin/python3.10", "/usr/local/bin/python3.9"
  ]
  for (const py of candidates) {
    try {
      const { stdout } = await execAsync(`${py} --version 2>/dev/null`)
      if (stdout.includes("Python 3.11") || stdout.includes("Python 3.10") || stdout.includes("Python 3.9")) {
        return py
      }
    } catch {
      // Try next
    }
  }
  return null
}

// ==================== CHATTERBOX SETUP ====================

async function setupChatterbox(): Promise<boolean> {
  if (chatterboxSetupAttempted) return chatterboxInstalled === true
  chatterboxSetupAttempted = true
  
  const python = await findPython311()
  if (!python) return false
  
  try {
    await mkdir(CHATTERBOX_DIR, { recursive: true })
    
    const venvPython = join(CHATTERBOX_VENV, "bin", "python")
    try {
      await access(venvPython)
      const { stdout } = await execAsync(`"${venvPython}" -c "import chatterbox; print('ok')"`, { timeout: 10000 })
      if (stdout.includes("ok")) {
        await ensureChatterboxScript()
        chatterboxInstalled = true
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    await execAsync(`"${python}" -m venv "${CHATTERBOX_VENV}"`, { timeout: 60000 })
    
    const pip = join(CHATTERBOX_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    await execAsync(`"${pip}" install chatterbox-tts`, { timeout: 600000 })
    
    await ensureChatterboxScript()
    chatterboxInstalled = true
    return true
  } catch {
    chatterboxInstalled = false
    return false
  }
}

async function ensureChatterboxScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Chatterbox TTS helper script for OpenCode."""
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--device", default="cuda", choices=["cuda", "mps", "cpu"])
    parser.add_argument("--voice", help="Reference voice audio path")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    args = parser.parse_args()
    
    try:
        import torch
        import torchaudio as ta
        
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        elif device == "mps" and not torch.backends.mps.is_available():
            device = "cpu"
        
        if args.turbo:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=device)
        else:
            from chatterbox.tts import ChatterboxTTS
            model = ChatterboxTTS.from_pretrained(device=device)
        
        if args.voice:
            wav = model.generate(args.text, audio_prompt_path=args.voice, exaggeration=args.exaggeration)
        else:
            wav = model.generate(args.text, exaggeration=args.exaggeration)
        
        ta.save(args.output, wav, model.sr)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`
  await writeFile(CHATTERBOX_SCRIPT, script, { mode: 0o755 })
}

async function ensureChatterboxServerScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Chatterbox TTS Server for OpenCode."""
import sys
import os
import json
import socket
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS Server")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "mps"])
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    parser.add_argument("--voice", help="Default reference voice audio path")
    args = parser.parse_args()
    
    import torch
    import torchaudio as ta
    
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        if torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    
    print(f"Loading model on {device}...", file=sys.stderr)
    
    if args.turbo:
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    else:
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=device)
    
    default_voice = args.voice
    
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(1)
    os.chmod(args.socket, 0o600)
    
    print(f"TTS server ready on {args.socket}", file=sys.stderr)
    sys.stderr.flush()
    
    while True:
        try:
            conn, _ = server.accept()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\\n" in data:
                    break
            
            request = json.loads(data.decode().strip())
            text = request.get("text", "")
            output = request.get("output", "/tmp/tts_output.wav")
            voice = request.get("voice") or default_voice
            exaggeration = request.get("exaggeration", 0.5)
            
            if voice:
                wav = model.generate(text, audio_prompt_path=voice, exaggeration=exaggeration)
            else:
                wav = model.generate(text, exaggeration=exaggeration)
            
            ta.save(output, wav, model.sr)
            
            conn.sendall(json.dumps({"success": True, "output": output}).encode() + b"\\n")
            conn.close()
        except Exception as e:
            try:
                conn.sendall(json.dumps({"success": False, "error": str(e)}).encode() + b"\\n")
                conn.close()
            except:
                pass

if __name__ == "__main__":
    main()
`
  await writeFile(CHATTERBOX_SERVER_SCRIPT, script, { mode: 0o755 })
}

async function isChatterboxServerRunning(): Promise<boolean> {
  try {
    await access(CHATTERBOX_SOCKET)
    // net is now statically imported
    return new Promise((resolve) => {
      const client = net.createConnection(CHATTERBOX_SOCKET, () => {
        client.destroy()
        resolve(true)
      })
      client.on("error", () => resolve(false))
      setTimeout(() => {
        client.destroy()
        resolve(false)
      }, 1000)
    })
  } catch {
    return false
  }
}

async function acquireChatterboxLock(): Promise<boolean> {
  const lockContent = `${process.pid}\n${Date.now()}`
  try {
    // open is now statically imported
    const handle = await open(CHATTERBOX_LOCK, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const content = await readFile(CHATTERBOX_LOCK, "utf-8")
        const timestamp = parseInt(content.split("\n")[1] || "0", 10)
        if (Date.now() - timestamp > 120000) {
          await unlink(CHATTERBOX_LOCK)
          return acquireChatterboxLock()
        }
      } catch {
        await unlink(CHATTERBOX_LOCK).catch(() => {})
        return acquireChatterboxLock()
      }
    }
    return false
  }
}

async function releaseChatterboxLock(): Promise<void> {
  await unlink(CHATTERBOX_LOCK).catch(() => {})
}

async function startChatterboxServer(config: TTSConfig): Promise<boolean> {
  if (await isChatterboxServerRunning()) {
    return true
  }
  
  if (!(await acquireChatterboxLock())) {
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isChatterboxServerRunning()) {
        return true
      }
    }
    return false
  }
  
  try {
    if (await isChatterboxServerRunning()) {
      return true
    }
    
    await ensureChatterboxServerScript()
    
    const venvPython = join(CHATTERBOX_VENV, "bin", "python")
    const opts = config.chatterbox || {}
    const device = opts.device || "cuda"
    
    const args = [
      CHATTERBOX_SERVER_SCRIPT,
      "--socket", CHATTERBOX_SOCKET,
      "--device", device,
    ]
    
    if (opts.useTurbo) {
      args.push("--turbo")
    }
    
    if (opts.voiceRef) {
      args.push("--voice", opts.voiceRef)
    }
    
    try {
      await unlink(CHATTERBOX_SOCKET)
    } catch {}
    
    const serverProcess = spawn(venvPython, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    
    if (serverProcess.pid) {
      await writeFile(CHATTERBOX_PID, String(serverProcess.pid))
    }
    
    serverProcess.unref()
    
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      if (await isChatterboxServerRunning()) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    return false
  } finally {
    await releaseChatterboxLock()
  }
}

async function speakWithChatterboxServer(text: string, config: TTSConfig): Promise<boolean> {
  const result = await speakWithChatterboxServerAndGetPath(text, config)
  return result.success
}

/**
 * Speak with Chatterbox server and return both success status and audio file path
 */
async function speakWithChatterboxServerAndGetPath(text: string, config: TTSConfig): Promise<{ success: boolean; audioPath?: string }> {
  // net is now statically imported
  const opts = config.chatterbox || {}
  const outputPath = join(tmpdir(), `opencode_tts_${Date.now()}.wav`)
  
  return new Promise((resolve) => {
    const client = net.createConnection(CHATTERBOX_SOCKET, () => {
      const request = JSON.stringify({
        text,
        output: outputPath,
        voice: opts.voiceRef,
        exaggeration: opts.exaggeration ?? 0.5,
      }) + "\n"
      client.write(request)
    })
    
    let response = ""
    client.on("data", (data) => {
      response += data.toString()
    })
    
    client.on("end", async () => {
      try {
        const result = JSON.parse(response.trim())
        if (!result.success) {
          resolve({ success: false })
          return
        }
        
        // Play the audio
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        // Return the path - caller is responsible for cleanup
        resolve({ success: true, audioPath: outputPath })
      } catch {
        resolve({ success: false })
      }
    })
    
    client.on("error", () => {
      resolve({ success: false })
    })
    
    setTimeout(() => {
      client.destroy()
      resolve({ success: false })
    }, 120000)
  })
}

async function isChatterboxAvailable(config: TTSConfig): Promise<boolean> {
  const installed = await setupChatterbox()
  if (!installed) return false
  
  const device = config.chatterbox?.device || "cuda"
  if (device === "cpu" || device === "mps") return true
  
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

/**
 * Speak with Chatterbox TTS and return both success status and audio file path
 * The caller is responsible for cleaning up the audio file
 */
async function speakWithChatterboxAndGetPath(text: string, config: TTSConfig): Promise<{ success: boolean; audioPath?: string }> {
  const opts = config.chatterbox || {}
  const useServer = opts.serverMode !== false
  
  if (useServer) {
    const serverReady = await startChatterboxServer(config)
    if (serverReady) {
      const result = await speakWithChatterboxServerAndGetPath(text, config)
      if (result.success) return result
    }
  }
  
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  const device = opts.device || "cuda"
  const outputPath = join(tmpdir(), `opencode_tts_${Date.now()}.wav`)
  
  const args = [
    CHATTERBOX_SCRIPT,
    "--output", outputPath,
    "--device", device,
  ]
  
  if (opts.voiceRef) {
    args.push("--voice", opts.voiceRef)
  }
  
  if (opts.exaggeration !== undefined) {
    args.push("--exaggeration", opts.exaggeration.toString())
  }
  
  if (opts.useTurbo) {
    args.push("--turbo")
  }
  
  args.push(text)
  
  return new Promise((resolve) => {
    const proc = spawn(venvPython, args)
    
    const timeout = device === "cpu" ? 300000 : 120000
    const timer = setTimeout(() => {
      proc.kill()
      resolve({ success: false })
    }, timeout)
    
    proc.on("close", async (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ success: false })
        return
      }
      
      try {
        // Play the audio
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        // Return the path - caller is responsible for cleanup
        resolve({ success: true, audioPath: outputPath })
      } catch {
        await unlink(outputPath).catch(() => {})
        resolve({ success: false })
      }
    })
    
    proc.on("error", () => {
      clearTimeout(timer)
      resolve({ success: false })
    })
  })
}

// ==================== COQUI TTS SETUP ====================

async function setupCoqui(): Promise<boolean> {
  if (coquiSetupAttempted) return coquiInstalled === true
  coquiSetupAttempted = true
  
  const python = await findPython3()
  if (!python) return false
  
  try {
    await mkdir(COQUI_DIR, { recursive: true })
    
    const venvPython = join(COQUI_VENV, "bin", "python")
    try {
      await access(venvPython)
      const { stdout } = await execAsync(`"${venvPython}" -c "from TTS.api import TTS; print('ok')"`, { timeout: 30000 })
      if (stdout.includes("ok")) {
        await ensureCoquiScript()
        coquiInstalled = true
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    await execAsync(`"${python}" -m venv "${COQUI_VENV}"`, { timeout: 60000 })
    
    const pip = join(COQUI_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    // Pin transformers<4.50 due to breaking API changes in 4.50+
    await execAsync(`"${pip}" install TTS "transformers<4.50"`, { timeout: 600000 })
    
    await ensureCoquiScript()
    coquiInstalled = true
    return true
  } catch {
    coquiInstalled = false
    return false
  }
}

async function ensureCoquiScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Coqui TTS helper script for OpenCode. Supports multiple models."""
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Coqui TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--model", default="xtts_v2", choices=["bark", "xtts_v2", "tortoise", "vits", "jenny"])
    parser.add_argument("--device", default="cuda", choices=["cuda", "mps", "cpu"])
    parser.add_argument("--voice-ref", help="Reference voice audio path (for XTTS voice cloning)")
    parser.add_argument("--language", default="en", help="Language code (for XTTS)")
    parser.add_argument("--speaker", default="Ana Florence", help="Speaker name for XTTS (e.g., 'Ana Florence', 'Claribel Dervla')")
    args = parser.parse_args()
    
    try:
        import torch
        
        # Workaround for PyTorch 2.6+ weights_only security change
        _original_load = torch.load
        def patched_load(*a, **kw):
            if 'weights_only' not in kw:
                kw['weights_only'] = False
            return _original_load(*a, **kw)
        torch.load = patched_load
        
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        elif device == "mps" and not torch.backends.mps.is_available():
            device = "cpu"
        
        from TTS.api import TTS
        
        if args.model == "bark":
            # Bark: use random speaker
            tts = TTS("tts_models/multilingual/multi-dataset/bark")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "xtts_v2":
            tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
            tts = tts.to(device)
            if args.voice_ref:
                tts.tts_to_file(
                    text=args.text,
                    file_path=args.output,
                    speaker_wav=args.voice_ref,
                    language=args.language
                )
            else:
                tts.tts_to_file(
                    text=args.text,
                    file_path=args.output,
                    speaker=args.speaker,
                    language=args.language
                )
        elif args.model == "tortoise":
            tts = TTS("tts_models/en/multi-dataset/tortoise-v2")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "vits":
            tts = TTS("tts_models/en/ljspeech/vits")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "jenny":
            tts = TTS("tts_models/en/jenny/jenny")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`
  await writeFile(COQUI_SCRIPT, script, { mode: 0o755 })
}

async function ensureCoquiServerScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Coqui TTS Server for OpenCode. Keeps model loaded for fast inference."""
import sys
import os
import json
import socket
import argparse

def main():
    parser = argparse.ArgumentParser(description="Coqui TTS Server")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--model", default="xtts_v2", choices=["bark", "xtts_v2", "tortoise", "vits", "jenny"])
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "mps"])
    parser.add_argument("--voice-ref", help="Default reference voice (for XTTS)")
    parser.add_argument("--speaker", default="Ana Florence", help="Default XTTS speaker")
    parser.add_argument("--language", default="en", help="Default language")
    args = parser.parse_args()
    
    import torch
    
    # Workaround for PyTorch 2.6+ weights_only security change
    _original_load = torch.load
    def patched_load(*a, **kw):
        if 'weights_only' not in kw:
            kw['weights_only'] = False
        return _original_load(*a, **kw)
    torch.load = patched_load
    
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        if torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    
    print(f"Loading Coqui TTS model '{args.model}' on {device}...", file=sys.stderr)
    
    from TTS.api import TTS
    
    if args.model == "bark":
        tts = TTS("tts_models/multilingual/multi-dataset/bark")
    elif args.model == "xtts_v2":
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    elif args.model == "tortoise":
        tts = TTS("tts_models/en/multi-dataset/tortoise-v2")
    elif args.model == "vits":
        tts = TTS("tts_models/en/ljspeech/vits")
    elif args.model == "jenny":
        tts = TTS("tts_models/en/jenny/jenny")
    
    tts = tts.to(device)
    print(f"Model loaded on {device}", file=sys.stderr)
    
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(1)
    os.chmod(args.socket, 0o600)
    
    print(f"TTS server ready on {args.socket}", file=sys.stderr)
    sys.stderr.flush()
    
    while True:
        try:
            conn, _ = server.accept()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\\n" in data:
                    break
            
            request = json.loads(data.decode().strip())
            text = request.get("text", "")
            output = request.get("output", "/tmp/tts_output.wav")
            voice_ref = request.get("voice_ref") or args.voice_ref
            speaker = request.get("speaker") or args.speaker
            language = request.get("language") or args.language
            
            if args.model == "bark":
                tts.tts_to_file(text=text, file_path=output)
            elif args.model == "xtts_v2":
                if voice_ref:
                    tts.tts_to_file(text=text, file_path=output, speaker_wav=voice_ref, language=language)
                else:
                    tts.tts_to_file(text=text, file_path=output, speaker=speaker, language=language)
            else:
                tts.tts_to_file(text=text, file_path=output)
            
            conn.sendall(json.dumps({"success": True, "output": output}).encode() + b"\\n")
            conn.close()
        except Exception as e:
            try:
                conn.sendall(json.dumps({"success": False, "error": str(e)}).encode() + b"\\n")
                conn.close()
            except:
                pass

if __name__ == "__main__":
    main()
`
  await writeFile(COQUI_SERVER_SCRIPT, script, { mode: 0o755 })
}

async function isCoquiServerRunning(): Promise<boolean> {
  try {
    await access(COQUI_SOCKET)
    // net is now statically imported
    return new Promise((resolve) => {
      const client = net.createConnection(COQUI_SOCKET, () => {
        client.destroy()
        resolve(true)
      })
      client.on("error", () => resolve(false))
      setTimeout(() => {
        client.destroy()
        resolve(false)
      }, 1000)
    })
  } catch {
    return false
  }
}

async function acquireCoquiLock(): Promise<boolean> {
  const lockContent = `${process.pid}\n${Date.now()}`
  try {
    // open is now statically imported
    const handle = await open(COQUI_LOCK, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const content = await readFile(COQUI_LOCK, "utf-8")
        const timestamp = parseInt(content.split("\n")[1] || "0", 10)
        if (Date.now() - timestamp > 120000) {
          await unlink(COQUI_LOCK)
          return acquireCoquiLock()
        }
      } catch {
        await unlink(COQUI_LOCK).catch(() => {})
        return acquireCoquiLock()
      }
    }
    return false
  }
}

async function releaseCoquiLock(): Promise<void> {
  await unlink(COQUI_LOCK).catch(() => {})
}

async function startCoquiServer(config: TTSConfig): Promise<boolean> {
  if (await isCoquiServerRunning()) {
    return true
  }
  
  if (!(await acquireCoquiLock())) {
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isCoquiServerRunning()) {
        return true
      }
    }
    return false
  }
  
  try {
    if (await isCoquiServerRunning()) {
      return true
    }
    
    await ensureCoquiServerScript()
    
    const venvPython = join(COQUI_VENV, "bin", "python")
    const opts = config.coqui || {}
    const device = opts.device || "cuda"
    const model = opts.model || "xtts_v2"
    
    const args = [
      COQUI_SERVER_SCRIPT,
      "--socket", COQUI_SOCKET,
      "--model", model,
      "--device", device,
    ]
    
    if (opts.voiceRef) {
      args.push("--voice-ref", opts.voiceRef)
    }
    
    if (opts.speaker) {
      args.push("--speaker", opts.speaker)
    }
    
    if (opts.language) {
      args.push("--language", opts.language)
    }
    
    try {
      await unlink(COQUI_SOCKET)
    } catch {}
    
    const serverProcess = spawn(venvPython, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    
    if (serverProcess.pid) {
      await writeFile(COQUI_PID, String(serverProcess.pid))
    }
    
    serverProcess.unref()
    
    const startTime = Date.now()
    while (Date.now() - startTime < 180000) {  // 3 minutes for model download
      if (await isCoquiServerRunning()) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    return false
  } finally {
    await releaseCoquiLock()
  }
}

// NOTE: speakWithCoquiServer removed - use speakWithCoquiServerAndGetPath instead

async function isCoquiAvailable(config: TTSConfig): Promise<boolean> {
  const installed = await setupCoqui()
  if (!installed) return false
  
  const device = config.coqui?.device || "cuda"
  if (device === "cpu" || device === "mps") return true
  
  const venvPython = join(COQUI_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

/**
 * Speak with Coqui TTS and return both success status and audio file path
 * The caller is responsible for cleaning up the audio file
 */
async function speakWithCoquiAndGetPath(text: string, config: TTSConfig): Promise<{ success: boolean; audioPath?: string }> {
  const opts = config.coqui || {}
  const useServer = opts.serverMode !== false
  
  if (useServer) {
    const serverReady = await startCoquiServer(config)
    if (serverReady) {
      const result = await speakWithCoquiServerAndGetPath(text, config)
      if (result.success) return result
    }
  }
  
  // One-shot mode
  const venvPython = join(COQUI_VENV, "bin", "python")
  const device = opts.device || "cuda"
  const model = opts.model || "xtts_v2"
  const outputPath = join(tmpdir(), `opencode_coqui_${Date.now()}.wav`)
  
  const args = [
    COQUI_SCRIPT,
    "--output", outputPath,
    "--model", model,
    "--device", device,
  ]
  
  if (opts.voiceRef) {
    args.push("--voice-ref", opts.voiceRef)
  }
  
  if (opts.speaker) {
    args.push("--speaker", opts.speaker)
  }
  
  if (opts.language) {
    args.push("--language", opts.language)
  }
  
  args.push(text)
  
  return new Promise((resolve) => {
    const proc = spawn(venvPython, args)
    
    const timeout = device === "cpu" ? 300000 : 180000
    const timer = setTimeout(() => {
      proc.kill()
      resolve({ success: false })
    }, timeout)
    
    proc.on("close", async (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ success: false })
        return
      }
      
      try {
        // Play the audio
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        // Return the path - caller is responsible for cleanup
        resolve({ success: true, audioPath: outputPath })
      } catch {
        await unlink(outputPath).catch(() => {})
        resolve({ success: false })
      }
    })
    
    proc.on("error", () => {
      clearTimeout(timer)
      resolve({ success: false })
    })
  })
}

/**
 * Speak with Coqui server and return both success status and audio file path
 */
async function speakWithCoquiServerAndGetPath(text: string, config: TTSConfig): Promise<{ success: boolean; audioPath?: string }> {
  // net is now statically imported
  const opts = config.coqui || {}
  const outputPath = join(tmpdir(), `opencode_coqui_${Date.now()}.wav`)
  
  return new Promise((resolve) => {
    const client = net.createConnection(COQUI_SOCKET, () => {
      const request = JSON.stringify({
        text,
        output: outputPath,
        voice_ref: opts.voiceRef,
        speaker: opts.speaker,
        language: opts.language || "en",
      }) + "\n"
      client.write(request)
    })
    
    let response = ""
    client.on("data", (data) => {
      response += data.toString()
    })
    
    client.on("end", async () => {
      try {
        const result = JSON.parse(response.trim())
        if (!result.success) {
          resolve({ success: false })
          return
        }
        
        // Play the audio
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        // Return the path - caller is responsible for cleanup
        resolve({ success: true, audioPath: outputPath })
      } catch {
        resolve({ success: false })
      }
    })
    
    client.on("error", () => {
      resolve({ success: false })
    })
    
    setTimeout(() => {
      client.destroy()
      resolve({ success: false })
    }, 120000)
  })
}

// ==================== WHISPER STT ====================

/**
 * Ensure Whisper server script is installed
 */
async function ensureWhisperServerScript(): Promise<void> {
  await mkdir(WHISPER_DIR, { recursive: true })
  
  // Copy the whisper_server.py from the plugin source
  // For now, we embed a minimal version here
  const script = `#!/usr/bin/env python3
"""
Faster Whisper STT Server for OpenCode TTS Plugin
"""

import os
import sys
import json
import tempfile
import logging
import subprocess
import shutil
import base64
from pathlib import Path
from typing import Optional

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse
    import uvicorn
except ImportError:
    print("Installing required packages...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fastapi", "uvicorn", "python-multipart"])
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse
    import uvicorn

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Installing faster-whisper...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper"])
    from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OpenCode Whisper STT Server", version="1.0.0")

MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR", str(Path.home() / ".cache" / "whisper"))
DEFAULT_MODEL = os.environ.get("WHISPER_DEFAULT_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")

AVAILABLE_MODELS = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v2", "large-v3"]

model_cache: dict[str, WhisperModel] = {}
current_model_name: Optional[str] = None


def convert_to_wav(input_path: str) -> str:
    output_path = input_path.rsplit('.', 1)[0] + '_converted.wav'
    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        return input_path
    try:
        result = subprocess.run([
            ffmpeg_path, '-y', '-i', input_path,
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
            output_path
        ], capture_output=True, timeout=30)
        if result.returncode == 0 and os.path.exists(output_path):
            return output_path
        return input_path
    except:
        return input_path


def get_model(model_name: str = DEFAULT_MODEL) -> WhisperModel:
    global current_model_name
    if model_name not in AVAILABLE_MODELS:
        model_name = DEFAULT_MODEL
    if model_name in model_cache:
        return model_cache[model_name]
    
    logger.info(f"Loading Whisper model: {model_name}")
    device = DEVICE
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
    compute_type = COMPUTE_TYPE
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    
    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=MODELS_DIR)
    model_cache[model_name] = model
    current_model_name = model_name
    logger.info(f"Model {model_name} loaded on {device}")
    return model


@app.on_event("startup")
async def startup_event():
    logger.info("Starting OpenCode Whisper STT Server...")
    try:
        get_model(DEFAULT_MODEL)
    except Exception as e:
        logger.warning(f"Could not pre-load model: {e}")


@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": current_model_name is not None, "current_model": current_model_name}


@app.post("/transcribe")
async def transcribe(request: dict):
    audio_data = request.get("audio")
    model_name = request.get("model", DEFAULT_MODEL)
    language = request.get("language")
    if language in ("auto", ""):
        language = None
    file_format = request.get("format", "ogg")
    
    if not audio_data:
        raise HTTPException(status_code=400, detail="No audio data provided")
    
    tmp_path = None
    converted_path = None
    
    try:
        if "," in audio_data:
            audio_data = audio_data.split(",")[1]
        audio_bytes = base64.b64decode(audio_data)
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{file_format}") as tmp_file:
            tmp_file.write(audio_bytes)
            tmp_path = tmp_file.name
        
        audio_path = tmp_path
        if file_format.lower() in ['webm', 'ogg', 'mp4', 'm4a', 'opus', 'oga']:
            converted_path = convert_to_wav(tmp_path)
            if converted_path != tmp_path:
                audio_path = converted_path
        
        whisper_model = get_model(model_name)
        segments, info = whisper_model.transcribe(
            audio_path, language=language, task="transcribe",
            vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=400)
        )
        
        segments_list = list(segments)
        full_text = " ".join(segment.text.strip() for segment in segments_list)
        
        return JSONResponse(content={
            "text": full_text, "language": info.language,
            "language_probability": info.language_probability, "duration": info.duration
        })
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except: pass
        if converted_path and converted_path != tmp_path:
            try: os.unlink(converted_path)
            except: pass


if __name__ == "__main__":
    port = int(os.environ.get("WHISPER_PORT", "8787"))
    host = os.environ.get("WHISPER_HOST", "127.0.0.1")
    logger.info(f"Starting Whisper server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
`
  await writeFile(WHISPER_SERVER_SCRIPT, script, { mode: 0o755 })
}

/**
 * Setup Whisper virtualenv and dependencies
 */
async function setupWhisper(): Promise<boolean> {
  if (whisperSetupAttempted) return whisperInstalled === true
  whisperSetupAttempted = true
  
  const python = await findPython311() || await findPython3()
  if (!python) return false
  
  try {
    await mkdir(WHISPER_DIR, { recursive: true })
    
    const venvPython = join(WHISPER_VENV, "bin", "python")
    try {
      await access(venvPython)
      const { stdout } = await execAsync(`"${venvPython}" -c "from faster_whisper import WhisperModel; print('ok')"`, { timeout: 30000 })
      if (stdout.includes("ok")) {
        await ensureWhisperServerScript()
        whisperInstalled = true
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    await execAsync(`"${python}" -m venv "${WHISPER_VENV}"`, { timeout: 60000 })
    
    const pip = join(WHISPER_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    await execAsync(`"${pip}" install faster-whisper fastapi uvicorn python-multipart`, { timeout: 600000 })
    
    await ensureWhisperServerScript()
    whisperInstalled = true
    return true
  } catch {
    whisperInstalled = false
    return false
  }
}

/**
 * Check if Whisper server is running
 */
async function isWhisperServerRunning(port: number = WHISPER_DEFAULT_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Acquire lock for starting Whisper server
 */
async function acquireWhisperLock(): Promise<boolean> {
  const lockContent = `${process.pid}\n${Date.now()}`
  try {
    // open is now statically imported
    const handle = await open(WHISPER_LOCK, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const content = await readFile(WHISPER_LOCK, "utf-8")
        const timestamp = parseInt(content.split("\n")[1] || "0", 10)
        if (Date.now() - timestamp > 120000) {
          await unlink(WHISPER_LOCK)
          return acquireWhisperLock()
        }
      } catch {
        await unlink(WHISPER_LOCK).catch(() => {})
        return acquireWhisperLock()
      }
    }
    return false
  }
}

/**
 * Release Whisper server lock
 */
async function releaseWhisperLock(): Promise<void> {
  await unlink(WHISPER_LOCK).catch(() => {})
}

/**
 * Start the Whisper STT server
 */
async function startWhisperServer(config: TTSConfig): Promise<boolean> {
  const port = config.whisper?.port || WHISPER_DEFAULT_PORT
  
  if (await isWhisperServerRunning(port)) {
    return true
  }
  
  if (!(await acquireWhisperLock())) {
    // Another process is starting the server, wait for it
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isWhisperServerRunning(port)) {
        return true
      }
    }
    return false
  }
  
  try {
    if (await isWhisperServerRunning(port)) {
      return true
    }
    
    const installed = await setupWhisper()
    if (!installed) {
      return false
    }
    
    const venvPython = join(WHISPER_VENV, "bin", "python")
    const model = config.whisper?.model || "base"
    const device = config.whisper?.device || "auto"
    
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      WHISPER_PORT: port.toString(),
      WHISPER_HOST: "127.0.0.1",
      WHISPER_DEFAULT_MODEL: model,
      WHISPER_DEVICE: device,
      PYTHONUNBUFFERED: "1"
    }
    
    whisperServerProcess = spawn(venvPython, [WHISPER_SERVER_SCRIPT], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    
    if (whisperServerProcess.pid) {
      await writeFile(WHISPER_PID, String(whisperServerProcess.pid))
    }
    
    whisperServerProcess.unref()
    
    // Wait for server to be ready
    const startTime = Date.now()
    while (Date.now() - startTime < 180000) {  // 3 minutes for model download
      if (await isWhisperServerRunning(port)) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    return false
  } finally {
    await releaseWhisperLock()
  }
}

/**
 * Transcribe audio using local Whisper server
 */
async function transcribeWithWhisper(
  audioBase64: string, 
  config: TTSConfig,
  format: string = "ogg"
): Promise<{ text: string; language: string; duration: number } | null> {
  const port = config.whisper?.port || WHISPER_DEFAULT_PORT
  
  // Ensure server is running
  const serverReady = await startWhisperServer(config)
  if (!serverReady) {
    return null
  }
  
  try {
    const response = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: audioBase64,
        model: config.whisper?.model || "base",
        format,
      }),
      signal: AbortSignal.timeout(120000)  // 2 minute timeout
    })
    
    if (!response.ok) {
      return null
    }
    
    const result = await response.json() as { text: string; language: string; duration: number }
    return result
  } catch {
    return null
  }
}

// ==================== OS TTS ====================

async function speakWithOS(text: string, config: TTSConfig): Promise<boolean> {
  const escaped = text.replace(/'/g, "'\\''")
  const opts = config.os || {}
  const voice = opts.voice || "Samantha"
  const rate = opts.rate || 200
  
  try {
    if (platform() === "darwin") {
      await execAsync(`say -v "${voice}" -r ${rate} '${escaped}'`)
    } else {
      await execAsync(`espeak '${escaped}'`)
    }
    return true
  } catch {
    return false
  }
}

// ==================== TELEGRAM NOTIFICATIONS ====================

// Default Supabase Edge Function URL for sending notifications
const DEFAULT_TELEGRAM_SERVICE_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/send-notify"

/**
 * Check if ffmpeg is available for audio conversion
 */
async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync("which ffmpeg")
    return true
  } catch {
    return false
  }
}

/**
 * Convert WAV file to OGG (Opus) format for Telegram voice messages
 * Returns the path to the OGG file, or null if conversion failed
 */
async function convertWavToOgg(wavPath: string): Promise<string | null> {
  const oggPath = wavPath.replace(/\.wav$/i, ".ogg")
  
  try {
    // Use ffmpeg to convert WAV to OGG with Opus codec
    // -c:a libopus: Use Opus codec (required for Telegram voice)
    // -b:a 32k: 32kbps bitrate (good quality for speech)
    // -ar 48000: 48kHz sample rate (Opus standard)
    // -ac 1: Mono audio (voice doesn't need stereo)
    await execAsync(
      `ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 32k -ar 48000 -ac 1 "${oggPath}"`,
      { timeout: 30000 }
    )
    return oggPath
  } catch (err) {
    console.error("[TTS] Failed to convert WAV to OGG:", err)
    return null
  }
}

/**
 * Send notification to Telegram via Supabase Edge Function
 */
async function sendTelegramNotification(
  text: string,
  voicePath: string | null,
  config: TTSConfig,
  context?: { model?: string; directory?: string; sessionId?: string }
): Promise<{ success: boolean; error?: string }> {
  const telegramConfig = config.telegram
  if (!telegramConfig?.enabled) {
    return { success: false, error: "Telegram notifications disabled" }
  }

  // Get UUID from config or environment variable
  const uuid = telegramConfig.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  if (!uuid) {
    return { success: false, error: "No UUID configured for Telegram notifications" }
  }

  const serviceUrl = telegramConfig.serviceUrl || DEFAULT_TELEGRAM_SERVICE_URL
  const sendText = telegramConfig.sendText !== false
  const sendVoice = telegramConfig.sendVoice !== false

  try {
    const body: { 
      uuid: string
      text?: string
      voice_base64?: string
      session_id?: string
      directory?: string 
    } = { uuid }

    // Add session context for reply support
    if (context?.sessionId) {
      body.session_id = context.sessionId
    }
    if (context?.directory) {
      body.directory = context.directory
    }

    // Add text if enabled
    if (sendText && text) {
      // Build message with context header
      const dirName = context?.directory ? context.directory.split("/").pop() || context.directory : undefined
      const header = [
        context?.model ? `Model: ${context.model}` : null,
        dirName ? `Dir: ${dirName}` : null
      ].filter(Boolean).join(" | ")
      
      const formattedText = header 
        ? `${header}\n${"─".repeat(Math.min(header.length, 30))}\n\n${text}`
        : text
      
      // Truncate to Telegram's limit (leave room for header)
      body.text = formattedText.slice(0, 3900)
    }

    // Add voice if enabled and path provided
    if (sendVoice && voicePath) {
      try {
        // First check if ffmpeg is available
        const ffmpegAvailable = await isFfmpegAvailable()
        
        let audioPath = voicePath
        let oggPath: string | null = null
        
        if (ffmpegAvailable && voicePath.endsWith(".wav")) {
          // Convert WAV to OGG for better Telegram compatibility
          oggPath = await convertWavToOgg(voicePath)
          if (oggPath) {
            audioPath = oggPath
          }
        }

        // Read the audio file and encode to base64
        const audioData = await readFile(audioPath)
        body.voice_base64 = audioData.toString("base64")

        // Clean up converted OGG file
        if (oggPath) {
          await unlink(oggPath).catch(() => {})
        }
      } catch (err) {
        console.error("[TTS] Failed to read voice file for Telegram:", err)
        // Continue without voice - text notification is still valuable
      }
    }

    // Only send if we have something to send
    if (!body.text && !body.voice_base64) {
      return { success: false, error: "No content to send" }
    }

    // Send to Supabase Edge Function
    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorJson: any = {}
      try {
        errorJson = JSON.parse(errorText)
      } catch {}
      return { 
        success: false, 
        error: errorJson.error || `HTTP ${response.status}: ${errorText.slice(0, 100)}` 
      }
    }

    const result = await response.json()
    return { success: result.success, error: result.error }
  } catch (err: any) {
    return { success: false, error: err?.message || "Network error" }
  }
}

/**
 * Check if Telegram notifications are enabled
 */
async function isTelegramEnabled(): Promise<boolean> {
  if (process.env.TELEGRAM_DISABLED === "1") return false
  const config = await loadConfig()
  return config.telegram?.enabled === true
}

// ==================== TELEGRAM REPLY SUBSCRIPTION ====================

// Default Supabase configuration for reply subscription
const DEFAULT_SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
// Note: Anon key is safe to expose - it only allows public access with RLS
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"

// Global subscription state
let replySubscription: any = null
let supabaseClient: any = null
// Track processed reply IDs to prevent duplicate processing across multiple instances
const processedReplyIds = new Set<string>()

interface TelegramReply {
  id: string
  uuid: string
  session_id: string
  directory: string | null
  reply_text: string | null  // Can be null for voice messages before transcription
  telegram_message_id: number
  telegram_chat_id: number
  created_at: string
  processed: boolean
  // Voice message fields (populated when is_voice = true)
  is_voice?: boolean
  audio_base64?: string | null
  voice_file_type?: string | null
  voice_duration_seconds?: number | null
}

/**
 * Mark a reply as processed in the database
 * Uses the mark_reply_processed RPC function which has SECURITY DEFINER
 * to bypass RLS restrictions
 */
async function markReplyProcessed(replyId: string): Promise<void> {
  if (!supabaseClient) return
  
  try {
    // Use RPC function instead of direct update to work with RLS
    await supabaseClient.rpc('mark_reply_processed', { p_reply_id: replyId })
  } catch (err) {
    console.error('[TTS] Failed to mark reply as processed:', err)
  }
}

/**
 * Initialize Supabase client for realtime subscriptions
 * Uses dynamic import to avoid bundling issues
 */
async function initSupabaseClient(config: TTSConfig): Promise<any> {
  if (supabaseClient) return supabaseClient
  
  const telegramConfig = config.telegram
  if (!telegramConfig?.enabled) return null
  if (telegramConfig.receiveReplies === false) return null
  
  const supabaseUrl = telegramConfig.supabaseUrl || DEFAULT_SUPABASE_URL
  const supabaseKey = telegramConfig.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY
  
  if (!supabaseKey || supabaseKey.includes('example')) {
    // Anon key not configured - skip realtime subscription
    return null
  }
  
  try {
    // Dynamic import to avoid bundling issues in Node.js environment
    const { createClient } = await import('@supabase/supabase-js')
    supabaseClient = createClient(supabaseUrl, supabaseKey, {
      realtime: {
        params: {
          eventsPerSecond: 2
        }
      }
    })
    return supabaseClient
  } catch (err) {
    console.error('[TTS] Failed to initialize Supabase client:', err)
    console.error('[TTS] Install @supabase/supabase-js to enable Telegram reply subscription')
    return null
  }
}

/**
 * Subscribe to Telegram replies for this user
 * Replies are forwarded to the appropriate OpenCode session
 */
async function subscribeToReplies(
  config: TTSConfig,
  client: any,
  debugLog: (msg: string) => Promise<void>
): Promise<void> {
  if (replySubscription) {
    await debugLog('Already subscribed to Telegram replies')
    return
  }
  
  const telegramConfig = config.telegram
  if (!telegramConfig?.enabled) return
  if (telegramConfig.receiveReplies === false) return
  
  const uuid = telegramConfig.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  if (!uuid) {
    await debugLog('No UUID configured, skipping reply subscription')
    return
  }
  
  const supabase = await initSupabaseClient(config)
  if (!supabase) {
    await debugLog('Supabase client not available, skipping reply subscription')
    return
  }
  
  await debugLog(`Subscribing to Telegram replies for UUID: ${uuid.slice(0, 8)}...`)
  
  try {
    // Subscribe to new replies for this user
    replySubscription = supabase
      .channel('telegram_replies')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'telegram_replies',
          filter: `uuid=eq.${uuid}`
        },
        async (payload: { new: TelegramReply }) => {
          const reply = payload.new
          
          // Deduplication: skip if we've already processed this reply ID
          if (processedReplyIds.has(reply.id)) {
            await debugLog(`Reply ${reply.id.slice(0, 8)}... already processed locally, skipping duplicate`)
            return
          }
          processedReplyIds.add(reply.id)
          
          // Limit set size to prevent memory leaks (keep last 100 IDs)
          if (processedReplyIds.size > 100) {
            const firstId = processedReplyIds.values().next().value
            if (firstId) processedReplyIds.delete(firstId)
          }
          
          if (reply.processed) {
            await debugLog('Reply already processed, skipping')
            return
          }
          
          // CRITICAL: Mark as processed in database IMMEDIATELY to prevent race conditions
          // between multiple OpenCode instances. This must happen BEFORE any processing
          // (transcription, forwarding, etc.) to ensure only one instance handles the reply.
          await markReplyProcessed(reply.id)
          await debugLog(`Marked reply ${reply.id.slice(0, 8)}... as processed in database`)
          
          try {
            let messageText: string
            
            // Check if this is a voice message that needs transcription
            if (reply.is_voice && reply.audio_base64) {
              await debugLog(`Received voice message (${reply.voice_duration_seconds}s ${reply.voice_file_type})`)
              
              // Transcribe the audio locally with Whisper
              const format = reply.voice_file_type === 'voice' ? 'ogg' : 'mp4'
              const transcription = await transcribeWithWhisper(reply.audio_base64, config, format)
              
              if (!transcription || !transcription.text) {
                await debugLog('Transcription failed or returned empty text')
                
                // Show error toast
                await client.tui.publish({
                  body: {
                    type: "toast",
                    toast: {
                      title: "Telegram Voice Error",
                      description: "Failed to transcribe voice message",
                      severity: "error"
                    }
                  }
                })
                
                // Already marked as processed at start of handler
                return
              }
              
              messageText = transcription.text
              await debugLog(`Transcribed: "${messageText.slice(0, 100)}..."`)
            } else if (reply.reply_text) {
              // Regular text message
              await debugLog(`Received Telegram reply: ${reply.reply_text.slice(0, 50)}...`)
              messageText = reply.reply_text
            } else {
              await debugLog('Reply has no text and is not a voice message, skipping')
              // Already marked as processed at start of handler
              return
            }
            
            // Forward the reply to the OpenCode session
            const prefix = reply.is_voice ? '[User via Telegram Voice]' : '[User via Telegram]'
            await debugLog(`Forwarding reply to session: ${reply.session_id}`)
            
            await client.session.promptAsync({
              path: { id: reply.session_id },
              body: {
                parts: [{
                  type: "text",
                  text: `${prefix}: ${messageText}`
                }]
              }
            })
            
            await debugLog('Reply forwarded successfully')
            
            // Show toast notification with session info so user knows where reply went
            const toastTitle = reply.is_voice ? "Telegram Voice Message" : "Telegram Reply"
            const shortSessionId = reply.session_id.slice(0, 12)
            await client.tui.publish({
              body: {
                type: "toast",
                toast: {
                  title: `${toastTitle} → ${shortSessionId}...`,
                  description: `"${messageText.slice(0, 40)}${messageText.length > 40 ? '...' : ''}"`,
                  severity: "info"
                }
              }
            })
          } catch (err: any) {
            await debugLog(`Failed to process reply: ${err?.message || err}`)
            
            // Show error toast
            await client.tui.publish({
              body: {
                type: "toast",
                toast: {
                  title: "Telegram Reply Error",
                  description: `Failed to process reply`,
                  severity: "error"
                }
              }
            })
          }
        }
      )
      .subscribe((status: string) => {
        debugLog(`Reply subscription status: ${status}`)
      })
    
    await debugLog('Successfully subscribed to Telegram replies')
  } catch (err: any) {
    await debugLog(`Failed to subscribe to replies: ${err?.message || err}`)
  }
}

/**
 * Cleanup reply subscription
 */
async function unsubscribeFromReplies(): Promise<void> {
  if (replySubscription && supabaseClient) {
    try {
      await supabaseClient.removeChannel(replySubscription)
      replySubscription = null
    } catch {}
  }
}

// ==================== PLUGIN ====================

export const TTSPlugin: Plugin = async ({ client, directory }) => {
  // Tool definition required by Plugin interface
  const tool = {
    tts: {
      name: 'tts',
      description: 'Text-to-speech functionality for OpenCode sessions',
      execute: async ({ client, params }: { client: any; params: any }) => {
        // TTS is triggered via session.idle events, not direct tool invocation
        return 'TTS plugin active - speech triggered on session completion'
      },
    },
  }

  // Directory for storing TTS output data
  const ttsDir = join(directory, ".tts")

  async function ensureTTSDir(): Promise<void> {
    try {
      await mkdir(ttsDir, { recursive: true })
    } catch {}
  }

  async function saveTTSData(sessionId: string, data: {
    originalText: string
    cleanedText: string
    spokenText: string
    engine: string
    timestamp: string
  }): Promise<void> {
    await ensureTTSDir()
    const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
    const filepath = join(ttsDir, filename)
    try {
      await writeFile(filepath, JSON.stringify(data, null, 2))
    } catch {}
  }

  function extractFinalResponse(messages: any[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
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

  async function speak(text: string, sessionId: string, modelID?: string): Promise<void> {
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) return

    const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
      ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
      : cleaned

    // Create a ticket and wait for our turn in the speech queue
    const ticketId = await createSpeechTicket(sessionId)
    const gotTurn = await waitForSpeechTurn(ticketId, 180000) // 3 min timeout
    if (!gotTurn) {
      await debugLog(`Failed to acquire speech turn for ${sessionId}`)
      return
    }

    let generatedAudioPath: string | null = null

    try {
      const config = await loadConfig()
      const engine = await getEngine()
      
      // Save TTS data to .tts/ directory
      await saveTTSData(sessionId, {
        originalText: text,
        cleanedText: cleaned,
        spokenText: toSpeak,
        engine,
        timestamp: new Date().toISOString()
      })

      // Check if Telegram is enabled - we may need to keep the audio file
      const telegramEnabled = await isTelegramEnabled()
      
      // Generate and play audio based on engine
      if (engine === "coqui") {
        const available = await isCoquiAvailable(config)
        if (available) {
          const result = await speakWithCoquiAndGetPath(toSpeak, config)
          if (result.success) {
            generatedAudioPath = result.audioPath || null
          }
        }
      }
      
      if (!generatedAudioPath && engine === "chatterbox") {
        const available = await isChatterboxAvailable(config)
        if (available) {
          const result = await speakWithChatterboxAndGetPath(toSpeak, config)
          if (result.success) {
            generatedAudioPath = result.audioPath || null
          }
        }
      }
      
      // OS TTS (fallback or explicit choice) - no audio file generated
      if (!generatedAudioPath && engine === "os") {
        await speakWithOS(toSpeak, config)
      }

      // Send Telegram notification if enabled (runs in parallel, non-blocking)
      if (telegramEnabled) {
        await debugLog(`Sending Telegram notification...`)
        const telegramResult = await sendTelegramNotification(
          cleaned, 
          generatedAudioPath, 
          config,
          { model: modelID, directory, sessionId }
        )
        if (telegramResult.success) {
          await debugLog(`Telegram notification sent successfully`)
        } else {
          await debugLog(`Telegram notification failed: ${telegramResult.error}`)
        }
      }
    } finally {
      // Clean up generated audio file
      if (generatedAudioPath) {
        await unlink(generatedAudioPath).catch(() => {})
      }
      await releaseSpeechLock(ticketId)
      await removeSpeechTicket(ticketId)
    }
  }

  function isSessionComplete(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        return !!(msg.info?.time as any)?.completed
      }
    }
    return false
  }

  function isJudgeSession(messages: any[]): boolean {
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  // Debug log file for TTS diagnostics
  const debugLogPath = join(directory, ".tts-debug.log")
  
  async function debugLog(msg: string): Promise<void> {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${msg}\n`
    try {
      // appendFile is now statically imported
      await appendFile(debugLogPath, line)
    } catch {}
  }

  // Initialize Telegram reply subscription (non-blocking)
  // This handles both text replies and voice messages (voice messages are transcribed with Whisper)
  ;(async () => {
    try {
      const config = await loadConfig()
      if (config.telegram?.enabled) {
        await subscribeToReplies(config, client, debugLog)
      }
    } catch (err: any) {
      await debugLog(`Failed to initialize reply subscription: ${err?.message || err}`)
    }
  })()

  return {
    tool,
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        await debugLog(`session.idle fired for ${sessionId}`)
        
        const enabled = await isEnabled()
        if (!enabled) {
          await debugLog(`TTS disabled, skipping`)
          return
        }

        if (!sessionId || typeof sessionId !== "string") {
          await debugLog(`Invalid sessionId: ${sessionId}`)
          return
        }

        if (spokenSessions.has(sessionId)) {
          await debugLog(`Already spoken for ${sessionId}`)
          return
        }
        
        // Mark session as processing IMMEDIATELY to prevent race conditions
        // (session.idle can fire multiple times rapidly before async operations complete)
        spokenSessions.add(sessionId)
        let shouldKeepInSet = false

        try {
          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          await debugLog(`Got ${messages?.length || 0} messages`)
          
          if (!messages || messages.length < 2) {
            await debugLog(`Not enough messages, skipping`)
            return
          }
          
          if (isJudgeSession(messages)) {
            await debugLog(`Judge session detected, skipping`)
            // Keep in set - never speak judge sessions
            shouldKeepInSet = true
            return
          }
          
          const complete = isSessionComplete(messages)
          await debugLog(`Session complete: ${complete}`)
          
          // Log the last assistant message structure for debugging
          const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
          if (lastAssistant) {
            await debugLog(`Last assistant msg.info: ${JSON.stringify(lastAssistant.info || {})}`)
          }
          
          if (!complete) {
            await debugLog(`Session not complete, skipping`)
            return
          }

          const finalResponse = extractFinalResponse(messages)
          await debugLog(`Final response length: ${finalResponse?.length || 0}`)
          
          // Extract model ID from the last assistant message (use any to handle SDK type limitations)
          const msgInfo = lastAssistant?.info as any
          const modelID = msgInfo?.modelID || msgInfo?.model || undefined
          await debugLog(`Model ID: ${modelID || "unknown"}`)
          
          if (finalResponse) {
            shouldKeepInSet = true
            await debugLog(`Speaking now...`)
            await speak(finalResponse, sessionId, modelID)
            await debugLog(`Speech complete`)
          }
        } catch (e: any) {
          await debugLog(`Error: ${e?.message || e}`)
        } finally {
          // Remove from set if we didn't actually speak (allow re-processing later)
          if (!shouldKeepInSet) {
            spokenSessions.delete(sessionId)
          }
        }
      }
    }
  }
}

export default TTSPlugin
