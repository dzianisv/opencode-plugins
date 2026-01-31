/**
 * Telegram Plugin for OpenCode
 *
 * Sends notifications to Telegram when agent completes tasks.
 * Receives replies from Telegram and injects them into the session.
 * 
 * Configure in ~/.config/opencode/telegram.json:
 * {
 *   "enabled": true,
 *   "uuid": "your-telegram-uuid",
 *   "sendText": true,
 *   "sendVoice": false,
 *   "receiveReplies": true
 * }
 * 
 * Or set environment variables:
 *   TELEGRAM_NOTIFICATION_UUID=your-uuid
 *   TELEGRAM_DISABLED=1  (to disable)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, unlink, mkdir, access } from "fs/promises"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import { join } from "path"
import { homedir } from "os"

const execAsync = promisify(exec)

// ==================== WHISPER PATHS ====================

const HELPERS_DIR = join(homedir(), ".config", "opencode", "opencode-helpers")
const WHISPER_DIR = join(HELPERS_DIR, "whisper")
const WHISPER_VENV = join(WHISPER_DIR, "venv")
const WHISPER_SERVER_SCRIPT = join(WHISPER_DIR, "whisper_server.py")
const WHISPER_PID = join(WHISPER_DIR, "server.pid")
const WHISPER_LOCK = join(WHISPER_DIR, "server.lock")
const WHISPER_DEFAULT_PORT = 8787

let whisperInstalled: boolean | null = null
let whisperSetupAttempted = false
let whisperServerProcess: ReturnType<typeof spawn> | null = null

// ==================== CONFIGURATION ====================

interface TelegramConfig {
  enabled?: boolean
  uuid?: string
  serviceUrl?: string
  sendText?: boolean
  sendVoice?: boolean
  receiveReplies?: boolean
  supabaseUrl?: string
  supabaseAnonKey?: string
  whisper?: {
    enabled?: boolean
    serverUrl?: string
    port?: number
    model?: string
    device?: string
  }
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "telegram.json")

const DEFAULT_TELEGRAM_SERVICE_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/send-notify"
const DEFAULT_UPDATE_REACTION_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/update-reaction"
const DEFAULT_SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"
const DEFAULT_WHISPER_URL = "http://127.0.0.1:8000"

// Debug logging
const DEBUG = process.env.TELEGRAM_DEBUG === "1"
async function debug(msg: string) {
  if (DEBUG) console.error(`[Telegram] ${msg}`)
}

// ==================== CONFIG LOADING ====================

async function loadConfig(): Promise<TelegramConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return {}
  }
}

async function isEnabled(): Promise<boolean> {
  if (process.env.TELEGRAM_DISABLED === "1") return false
  const config = await loadConfig()
  return config.enabled === true
}

// ==================== TELEGRAM REPLY TYPE ====================

interface TelegramReply {
  id: string
  uuid: string
  session_id: string
  directory: string | null
  reply_text: string | null
  telegram_message_id: number
  telegram_chat_id: number
  created_at: string
  processed: boolean
  is_voice?: boolean
  audio_base64?: string | null
  voice_file_type?: string | null
  voice_duration_seconds?: number | null
}

// ==================== UTILITY FUNCTIONS ====================

async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync("which ffmpeg")
    return true
  } catch {
    return false
  }
}

async function convertWavToOgg(wavPath: string): Promise<string | null> {
  if (!wavPath || typeof wavPath !== 'string') {
    console.error('[Telegram] convertWavToOgg called with invalid wavPath:', typeof wavPath, wavPath)
    return null
  }
  
  const oggPath = wavPath.replace(/\.wav$/i, ".ogg")
  try {
    await execAsync(
      `ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 32k -ar 48000 -ac 1 "${oggPath}"`,
      { timeout: 30000 }
    )
    return oggPath
  } catch {
    return null
  }
}

// ==================== TELEGRAM API FUNCTIONS ====================

async function sendNotification(
  text: string,
  voicePath: string | null,
  config: TelegramConfig,
  context?: { model?: string; directory?: string; sessionId?: string }
): Promise<{ success: boolean; error?: string; messageId?: number; chatId?: number }> {
  if (!config?.enabled) {
    return { success: false, error: "Telegram notifications disabled" }
  }

  const uuid = config.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  if (!uuid) {
    return { success: false, error: "No UUID configured for Telegram notifications" }
  }

  const serviceUrl = config.serviceUrl || DEFAULT_TELEGRAM_SERVICE_URL
  const sendText = config.sendText !== false
  const sendVoice = config.sendVoice !== false

  try {
    const body: { 
      uuid: string
      text?: string
      voice_base64?: string
      session_id?: string
      directory?: string 
    } = { uuid }

    if (context?.sessionId) body.session_id = context.sessionId
    if (context?.directory) body.directory = context.directory

    if (sendText && text) {
      const dirName = context?.directory?.split("/").pop() || null
      const sessionId = context?.sessionId || null
      const modelName = context?.model || null

      const headerParts = [dirName, sessionId, modelName].filter(Boolean)
      const header = headerParts.join(" | ")
      const replyHint = sessionId ? "\n\n💬 Reply to this message to continue" : ""

      const formattedText = header 
        ? `${header}\n${"─".repeat(Math.min(40, header.length))}\n\n${text}${replyHint}`
        : `${text}${replyHint}`
      
      body.text = formattedText.slice(0, 3800)
    }

    if (sendVoice && voicePath) {
      try {
        const ffmpegAvailable = await isFfmpegAvailable()
        let audioPath = voicePath
        let oggPath: string | null = null
        
        if (ffmpegAvailable && voicePath.endsWith(".wav")) {
          oggPath = await convertWavToOgg(voicePath)
          if (oggPath) audioPath = oggPath
        }

        const audioData = await readFile(audioPath)
        body.voice_base64 = audioData.toString("base64")

        if (oggPath) await unlink(oggPath).catch(() => {})
      } catch (err) {
        console.error("[Telegram] Failed to read voice file:", err)
      }
    }

    if (!body.text && !body.voice_base64) {
      return { success: false, error: "No content to send" }
    }

    const supabaseKey = config.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY
    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `HTTP ${response.status}: ${errorText.slice(0, 100)}` }
    }

    const result = await response.json()
    return { 
      success: result.success, 
      error: result.error,
      messageId: result.message_id,
      chatId: result.chat_id,
    }
  } catch (err: any) {
    return { success: false, error: err?.message || "Network error" }
  }
}

async function updateMessageReaction(
  chatId: number,
  messageId: number,
  emoji: string,
  config: TelegramConfig
): Promise<{ success: boolean; error?: string }> {
  const supabaseKey = config.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY
  if (!supabaseKey) {
    return { success: false, error: "No Supabase key configured" }
  }

  try {
    const response = await fetch(DEFAULT_UPDATE_REACTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
      },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, emoji }),
    })

    if (!response.ok) {
      const error = await response.text()
      return { success: false, error }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ==================== WHISPER STT ====================

/**
 * Find Python 3.11 for Whisper setup
 */
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

/**
 * Find Python 3.9-3.11 for Whisper
 */
async function findPython3(): Promise<string | null> {
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

/**
 * Ensure Whisper server script is installed
 */
async function ensureWhisperServerScript(): Promise<void> {
  await mkdir(WHISPER_DIR, { recursive: true })
  
  const script = `#!/usr/bin/env python3
"""
Faster Whisper STT Server for OpenCode Telegram Plugin
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
  if (!python) {
    await debug("No Python 3.9-3.11 found for Whisper")
    return false
  }
  
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
    
    await debug("Setting up Whisper virtualenv...")
    await execAsync(`"${python}" -m venv "${WHISPER_VENV}"`, { timeout: 60000 })
    
    const pip = join(WHISPER_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    await execAsync(`"${pip}" install faster-whisper fastapi uvicorn python-multipart`, { timeout: 600000 })
    
    await ensureWhisperServerScript()
    whisperInstalled = true
    await debug("Whisper setup complete")
    return true
  } catch (err: any) {
    await debug(`Whisper setup failed: ${err?.message}`)
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
    const { open } = await import("fs/promises")
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
async function startWhisperServer(config: TelegramConfig): Promise<boolean> {
  const port = config.whisper?.port || WHISPER_DEFAULT_PORT
  
  if (await isWhisperServerRunning(port)) {
    return true
  }
  
  if (!(await acquireWhisperLock())) {
    // Another process is starting the server, wait for it
    await debug("Waiting for another process to start Whisper server...")
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
    
    await debug("Starting Whisper server...")
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
      await debug(`Whisper server started with PID ${whisperServerProcess.pid}`)
    }
    
    whisperServerProcess.unref()
    
    // Wait for server to be ready (up to 3 minutes for model download)
    const startTime = Date.now()
    while (Date.now() - startTime < 180000) {
      if (await isWhisperServerRunning(port)) {
        await debug("Whisper server is ready")
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    await debug("Whisper server startup timeout")
    return false
  } finally {
    await releaseWhisperLock()
  }
}

/**
 * Transcribe audio using local Whisper server
 */
async function transcribeAudio(
  audioBase64: string, 
  config: TelegramConfig,
  format: string = "ogg"
): Promise<string | null> {
  if (!config.whisper?.enabled) {
    await debug("Whisper transcription disabled in config")
    return null
  }
  
  const port = config.whisper?.port || WHISPER_DEFAULT_PORT
  
  // Ensure server is running (auto-start if needed)
  const serverReady = await startWhisperServer(config)
  if (!serverReady) {
    await debug("Whisper server not ready, cannot transcribe")
    return null
  }
  
  try {
    const response = await fetch(`http://127.0.0.1:${port}/transcribe-base64`, {
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
      await debug(`Whisper transcription failed: ${response.status}`)
      return null
    }
    
    const result = await response.json() as { text: string; language: string; duration: number }
    await debug(`Transcribed ${result.duration}s of audio: ${result.text.slice(0, 50)}...`)
    return result.text || null
  } catch (err: any) {
    await debug(`Whisper transcription error: ${err?.message}`)
    return null
  }
}

// ==================== SESSION HELPERS ====================

function isJudgeSession(messages: any[]): boolean {
  const firstUser = messages.find((m: any) => m.info?.role === "user")
  if (!firstUser) return false
  const text = firstUser.parts?.find((p: any) => p.type === "text")?.text || ""
  return text.includes("You are a judge") || text.includes("Task to evaluate")
}

function isSessionComplete(messages: any[]): boolean {
  const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
  if (!lastAssistant) return false
  if (lastAssistant.info?.error) return false
  const hasPending = lastAssistant.parts?.some((p: any) => 
    p.type === "tool" && p.state === "pending"
  )
  return !hasPending
}

function extractLastResponse(messages: any[]): string {
  const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
  if (!lastAssistant) return ""
  
  const textParts = (lastAssistant.parts || [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text || "")
  
  return textParts.join("\n").trim()
}

// ==================== PLUGIN ====================

const spokenSessions = new Set<string>()
const lastMessages = new Map<string, { chatId: number; messageId: number }>()
let supabaseClient: any = null
let replySubscription: any = null

export const TelegramPlugin: Plugin = async ({ client, directory }) => {
  
  // Initialize Supabase client for reply subscription
  async function initSupabase(config: TelegramConfig): Promise<any> {
    if (supabaseClient) return supabaseClient
    if (!config?.enabled) return null
    if (config.receiveReplies === false) return null

    const supabaseUrl = config.supabaseUrl || DEFAULT_SUPABASE_URL
    const supabaseKey = config.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY

    try {
      const { createClient } = await import("@supabase/supabase-js")
      supabaseClient = createClient(supabaseUrl, supabaseKey, {})
      return supabaseClient
    } catch {
      console.error('[Telegram] Install @supabase/supabase-js to enable reply subscription')
      return null
    }
  }

  // Subscribe to Telegram replies
  async function subscribeToReplies(config: TelegramConfig) {
    if (replySubscription) return
    if (!config?.enabled) return
    if (config.receiveReplies === false) return

    const uuid = config.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
    if (!uuid) return

    const supabase = await initSupabase(config)
    if (!supabase) return

    await debug(`Subscribing to Telegram replies for UUID: ${uuid.slice(0, 8)}...`)

    replySubscription = supabase
      .channel('telegram_replies')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'telegram_replies',
          filter: `uuid=eq.${uuid}`,
        },
        async (payload: { new: TelegramReply }) => {
          const reply = payload.new
          if (!reply || reply.processed) return

          await debug(`Received reply: ${reply.reply_text?.slice(0, 50)}...`)

          // Handle voice messages
          let replyText = reply.reply_text
          if (reply.is_voice && reply.audio_base64) {
            // Determine format from voice_file_type (voice=ogg, video_note=mp4, video=mp4)
            const format = reply.voice_file_type === 'voice' ? 'ogg' : 
                          reply.voice_file_type === 'video_note' ? 'mp4' :
                          reply.voice_file_type === 'video' ? 'mp4' : 'ogg'
            const transcription = await transcribeAudio(reply.audio_base64, config, format)
            if (transcription) {
              replyText = transcription
              await debug(`Transcribed voice: ${transcription.slice(0, 50)}...`)
            } else {
              await debug(`Voice transcription failed`)
              return
            }
          }

          if (!replyText) return

          // Find session to inject reply
          const targetSessionId = reply.session_id
          if (!targetSessionId) {
            await debug(`No session_id in reply, cannot route`)
            return
          }

          try {
            const prefix = reply.is_voice ? '[User via Telegram Voice]' : '[User via Telegram]'
            await client.session.promptAsync({
              path: { id: targetSessionId },
              body: { parts: [{ type: "text", text: `${prefix} ${replyText}` }] }
            })

            // Update reaction to 👍
            await updateMessageReaction(
              reply.telegram_chat_id,
              reply.telegram_message_id,
              "👍",
              config
            )

            // Mark as processed
            await supabase.rpc('mark_reply_processed', { reply_id: reply.id })
            
            await debug(`Forwarded reply to session ${targetSessionId}`)
          } catch (err: any) {
            await debug(`Failed to forward reply: ${err?.message}`)
          }
        }
      )
      .subscribe()

    await debug('Subscribed to Telegram replies')
  }

  // Poll for missed replies (runs on startup)
  async function pollMissedReplies(config: TelegramConfig) {
    if (!config?.enabled) return
    if (config.receiveReplies === false) return

    const uuid = config.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
    if (!uuid) return

    const supabase = await initSupabase(config)
    if (!supabase) return

    try {
      const { data: unprocessed } = await supabase
        .from('telegram_replies')
        .select('*')
        .eq('uuid', uuid)
        .eq('processed', false)
        .order('created_at', { ascending: true })

      if (!unprocessed?.length) return

      await debug(`Found ${unprocessed.length} unprocessed replies`)

      for (const reply of unprocessed as TelegramReply[]) {
        if (!reply.session_id || !reply.reply_text) continue

        try {
          const prefix = reply.is_voice ? '[User via Telegram Voice]' : '[User via Telegram]'
          await client.session.promptAsync({
            path: { id: reply.session_id },
            body: { parts: [{ type: "text", text: `${prefix} ${reply.reply_text}` }] }
          })

          await updateMessageReaction(
            reply.telegram_chat_id,
            reply.telegram_message_id,
            "👍",
            config
          )

          await supabase.rpc('mark_reply_processed', { reply_id: reply.id })
          await debug(`Recovered reply for session ${reply.session_id}`)
        } catch {
          await debug(`Failed to recover reply ${reply.id}`)
        }
      }
    } catch (err: any) {
      await debug(`Poll failed: ${err?.message}`)
    }
  }

  // Initialize on plugin load
  const config = await loadConfig()
  if (config.enabled) {
    await subscribeToReplies(config)
    await pollMissedReplies(config)
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        await debug(`session.idle for ${sessionId}`)

        const enabled = await isEnabled()
        if (!enabled) {
          await debug(`Telegram disabled`)
          return
        }

        if (!sessionId || spokenSessions.has(sessionId)) return
        spokenSessions.add(sessionId)

        try {
          // Check for subagent
          const { data: sessionInfo } = await client.session.get({ path: { id: sessionId } })
          if (sessionInfo?.parentID) {
            await debug(`Subagent session, skipping`)
            return
          }

          const sessionDirectory = sessionInfo?.directory || directory

          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          if (!messages || messages.length < 2) return

          if (isJudgeSession(messages)) {
            await debug(`Judge session, skipping`)
            return
          }

          if (!isSessionComplete(messages)) {
            await debug(`Session not complete`)
            spokenSessions.delete(sessionId)
            return
          }

          const responseText = extractLastResponse(messages)
          if (!responseText) return

          // Send notification
          const config = await loadConfig()
          const result = await sendNotification(
            responseText.slice(0, 1000),
            null, // No voice for now - TTS plugin can add it
            config,
            { sessionId, directory: sessionDirectory }
          )

          if (result.success && result.messageId && result.chatId) {
            lastMessages.set(sessionId, {
              chatId: result.chatId,
              messageId: result.messageId
            })
            await debug(`Notification sent: msg=${result.messageId}`)
          } else {
            await debug(`Notification failed: ${result.error}`)
          }

        } catch (err: any) {
          await debug(`Error: ${err?.message}`)
          spokenSessions.delete(sessionId)
        }
      }

      // Update reaction when user sends follow-up
      if (event.type === "session.updated") {
        const sessionId = (event as any).properties?.sessionID
        const lastMsg = lastMessages.get(sessionId)
        if (lastMsg) {
          const config = await loadConfig()
          await updateMessageReaction(lastMsg.chatId, lastMsg.messageId, "😊", config)
          lastMessages.delete(sessionId)
          await debug(`Updated reaction to 😊`)
        }
      }
    }
  }
}

export default TelegramPlugin
