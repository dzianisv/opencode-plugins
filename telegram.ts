/**
 * Telegram Integration for OpenCode
 *
 * Handles Telegram notifications and reply subscriptions using Supabase.
 */
import { readFile, unlink } from "fs/promises"
import { promisify } from "util"; const execAsync = promisify(require('child_process').exec)

// Local type definition for Telegram config (matches TTSConfig.telegram from tts.ts)
interface TTSConfig {
  telegram?: {
    enabled?: boolean
    uuid?: string
    serviceUrl?: string
    sendText?: boolean
    sendVoice?: boolean
    supabaseUrl?: string
    supabaseAnonKey?: string
  }
}

// Default Supabase Edge Function URLs
const DEFAULT_TELEGRAM_SERVICE_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/send-notify"
const DEFAULT_UPDATE_REACTION_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/update-reaction"
const DEFAULT_SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1..."

let supabaseClient: any = null
let replySubscription: any = null

export interface TelegramReply {
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

/**
 * Check if ffmpeg is available for audio conversion
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync("which ffmpeg")
    return true
  } catch {
    return false
  }
}

/**
 * Convert WAV file to OGG for Telegram voice messages
 */
export async function convertWavToOgg(wavPath: string): Promise<string | null> {
  // Type guard - ensure wavPath is actually a string
  if (!wavPath || typeof wavPath !== 'string') {
    console.error('[Telegram] convertWavToOgg called with invalid wavPath:', typeof wavPath, wavPath)
    return null
  }
  
  const oggPath = wavPath.replace(/\.wav$/i, ".ogg")
  try {
    await execAsync( // Use ffmpeg to convert WAV to OGG
      `ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 32k -ar 48000 -ac 1 "${oggPath}"`,
      { timeout: 30000 }
    )
    return oggPath
  } catch {
    return null
  }
}

/**
 * Update a message reaction in Telegram
 * Used to change from 👀 (received) to ✅ (delivered) after forwarding to OpenCode
 */
export async function updateMessageReaction(
  chatId: number,
  messageId: number,
  emoji: string,
  config: TTSConfig
): Promise<{ success: boolean; error?: string }> {
  const telegramConfig = config.telegram
  const supabaseKey = telegramConfig?.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY

  if (!supabaseKey || supabaseKey.includes("example")) {
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
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        emoji,
      }),
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

/**
 * Send Telegram notification
 */
export async function sendTelegramNotification(
  text: string,
  voicePath: string | null,
  config: TTSConfig,
  context?: { model?: string; directory?: string; sessionId?: string }
): Promise<{ success: boolean; error?: string }> {
  const telegramConfig = config.telegram
  if (!telegramConfig?.enabled) {
    return { success: false, error: "Telegram notifications disabled" }
  }

  const uuid = telegramConfig.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  const serviceUrl = telegramConfig.serviceUrl || DEFAULT_TELEGRAM_SERVICE_URL
  const sendText = telegramConfig.sendText !== false
  const sendVoice = telegramConfig.sendVoice !== false

  if (!uuid) {
    return { success: false, error: "No UUID configured for Telegram notifications" }
  }

  const body: Record<string, any> = { uuid }
  if (sendText) body.text = text
  if (sendVoice && voicePath) {
    try {
      const audioData = await readFile(voicePath)
      body.voice_base64 = audioData.toString("base64")
    } catch {
      return { success: false, error: "Voice file unreadable" }
    }
  }

  try {
    // Supabase Edge Functions require Authorization header with anon key
    const supabaseKey = telegramConfig?.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY
    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
      },
      body: JSON.stringify(body),
    })
    return response.ok
      ? { success: true }
      : { success: false, error: await response.text() }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Initialize Supabase client
 */
export async function initSupabaseClient(config: TTSConfig): Promise<any> {
  if (supabaseClient) return supabaseClient

  const telegramConfig = config.telegram
  const supabaseUrl = telegramConfig?.supabaseUrl || DEFAULT_SUPABASE_URL
  const supabaseKey = telegramConfig?.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY

  if (!supabaseKey || supabaseKey.includes("example")) return null
  try {
    const { createClient } = await import("@supabase/supabase-js")
    supabaseClient = createClient(supabaseUrl, supabaseKey, {})
    return supabaseClient
  } catch {
    return null
  }
}

/**
 * Subscribe to Telegram replies
 */
export async function subscribeToReplies(
  config: TTSConfig,
  client: any
): Promise<void> {
  if (replySubscription) return
  const telegramConfig = config.telegram
  if (!telegramConfig?.enabled) return

  const supabase = await initSupabaseClient(config)
  if (!supabase) return

  const uuid = telegramConfig.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  if (!uuid) return

  replySubscription = supabase.channel("telegram_replies").on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "telegram_replies", filter: `uuid=eq.${uuid}` },
    async (payload: { new: TelegramReply }) => {
      console.log("Received reply:", payload)
    }
  )
}