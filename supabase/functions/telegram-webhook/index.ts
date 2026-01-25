/**
 * Telegram Webhook Handler for OpenCode Notifications
 * 
 * This Edge Function handles incoming Telegram updates:
 * - /start <uuid> - Subscribe to notifications
 * - /stop - Unsubscribe from notifications
 * - /status - Check subscription status
 * - Non-command messages - Forward as replies to active OpenCode sessions
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface TelegramVoice {
  duration: number
  mime_type?: string
  file_id: string
  file_unique_id: string
  file_size?: number
}

interface TelegramVideoNote {
  duration: number
  length: number
  file_id: string
  file_unique_id: string
  file_size?: number
}

interface TelegramVideo {
  duration: number
  width: number
  height: number
  file_id: string
  file_unique_id: string
  file_size?: number
  mime_type?: string
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: {
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
    }
    chat: {
      id: number
      type: string
    }
    date: number
    text?: string
    voice?: TelegramVoice
    video_note?: TelegramVideoNote
    video?: TelegramVideo
  }
}

function isValidUUID(str: string): boolean {
  return UUID_REGEX.test(str)
}

async function sendTelegramMessage(chatId: number, text: string, parseMode: string = 'Markdown'): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    })
    return response.ok
  } catch (error) {
    console.error('Failed to send Telegram message:', error)
    return false
  }
}

Deno.serve(async (req) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Verify required environment variables
  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    const update: TelegramUpdate = await req.json()
    
    // Must have a message with chat
    if (!update.message?.chat) {
      return new Response('OK')
    }

    const chatId = update.message.chat.id
    const messageId = update.message.message_id
    const username = update.message.from?.username
    const firstName = update.message.from?.first_name

    // Initialize Supabase client with service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // ==================== HANDLE VOICE/VIDEO MESSAGES ====================
    const voice = update.message.voice
    const videoNote = update.message.video_note
    const video = update.message.video

    if (voice || videoNote || video) {
      // Get active reply context to know which session to send to
      const { data: context, error: contextError } = await supabase
        .rpc('get_active_reply_context', { p_chat_id: chatId })

      if (contextError || !context || context.length === 0) {
        await sendTelegramMessage(chatId,
          `ℹ️ *No active session*\n\n` +
          `There's no active OpenCode session to send voice messages to.\n\n` +
          `Start a new task in OpenCode first to receive notifications.`
        )
        return new Response('OK')
      }

      const activeContext = context[0]
      
      // Determine file info
      let fileId: string
      let fileType: string
      let duration: number
      let fileSize: number | undefined

      if (voice) {
        fileId = voice.file_id
        fileType = 'voice'
        duration = voice.duration
        fileSize = voice.file_size
      } else if (videoNote) {
        fileId = videoNote.file_id
        fileType = 'video_note'
        duration = videoNote.duration
        fileSize = videoNote.file_size
      } else if (video) {
        fileId = video.file_id
        fileType = 'video'
        duration = video.duration
        fileSize = video.file_size
      } else {
        return new Response('OK')
      }

      // Download the audio file from Telegram
      let audioBase64: string | null = null
      try {
        // Get file path from Telegram
        const fileInfoResponse = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
        )
        
        if (fileInfoResponse.ok) {
          const fileInfo = await fileInfoResponse.json() as { ok: boolean; result?: { file_path: string } }
          
          if (fileInfo.ok && fileInfo.result?.file_path) {
            // Download the actual file
            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`
            const fileResponse = await fetch(fileUrl)
            
            if (fileResponse.ok) {
              const arrayBuffer = await fileResponse.arrayBuffer()
              // Convert to base64
              const bytes = new Uint8Array(arrayBuffer)
              let binary = ''
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i])
              }
              audioBase64 = btoa(binary)
            }
          }
        }
      } catch (downloadError) {
        console.error('Error downloading audio from Telegram:', downloadError)
      }

      // Check if audio download failed - we can't proceed without the audio
      if (!audioBase64) {
        console.error('Failed to download audio from Telegram')
        await sendTelegramMessage(chatId,
          `❌ *Failed to download voice message*\n\n` +
          `Could not retrieve the audio from Telegram. Please try again.`
        )
        return new Response('OK')
      }

      // Store voice message in telegram_replies table for plugin to process
      // Plugin will receive this via Supabase Realtime and transcribe locally with Whisper
      const { error: insertError } = await supabase
        .from('telegram_replies')
        .insert({
          uuid: activeContext.uuid,
          session_id: activeContext.session_id,
          directory: activeContext.directory,
          telegram_chat_id: chatId,
          telegram_message_id: messageId,
          reply_text: null, // Will be filled after transcription by plugin
          is_voice: true,
          audio_base64: audioBase64,
          voice_file_type: fileType,
          voice_duration_seconds: duration,
          processed: false,
        })

      if (insertError) {
        console.error('Error storing voice message:', insertError)
        await sendTelegramMessage(chatId,
          `❌ *Failed to process voice message*\n\n` +
          `Please try again.`
        )
        return new Response('OK')
      }

      // Confirm to user (simple emoji - processing happens in background)
      await sendTelegramMessage(chatId, `🎤`)

      return new Response('OK')
    }

    // ==================== HANDLE TEXT MESSAGES ====================
    const text = update.message.text?.trim()
    
    // Skip if no text
    if (!text) {
      return new Response('OK')
    }

    // Handle /start command
    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/)
      const uuid = parts[1]

      if (!uuid) {
        await sendTelegramMessage(chatId, 
          `*Welcome to OpenCode Notifications!* 🔔\n\n` +
          `To subscribe, send your UUID:\n` +
          `\`/start <your-uuid>\`\n\n` +
          `*How to get your UUID:*\n` +
          `1. Generate one: \`uuidgen\` (in terminal)\n` +
          `2. Add to your config file:\n` +
          `\`~/.config/opencode/tts.json\`\n\n` +
          `\`\`\`json\n{\n  "telegram": {\n    "enabled": true,\n    "uuid": "your-uuid-here"\n  }\n}\`\`\`\n\n` +
          `Need help? Visit: github.com/opencode-ai/opencode`
        )
        return new Response('OK')
      }

      if (!isValidUUID(uuid)) {
        await sendTelegramMessage(chatId, 
          `❌ *Invalid UUID format*\n\n` +
          `Please provide a valid UUID v4.\n` +
          `Generate one with: \`uuidgen\``
        )
        return new Response('OK')
      }

      // Check if this UUID is already linked to a different chat
      const { data: existing } = await supabase
        .from('telegram_subscribers')
        .select('chat_id')
        .eq('uuid', uuid)
        .single()

      if (existing && existing.chat_id !== chatId) {
        await sendTelegramMessage(chatId, 
          `⚠️ *UUID already in use*\n\n` +
          `This UUID is linked to another Telegram account.\n` +
          `Please generate a new UUID with \`uuidgen\`.`
        )
        return new Response('OK')
      }

      // Upsert subscription
      const { error } = await supabase
        .from('telegram_subscribers')
        .upsert({
          uuid,
          chat_id: chatId,
          username,
          first_name: firstName,
          is_active: true,
        }, { onConflict: 'uuid' })

      if (error) {
        console.error('Database error:', error)
        await sendTelegramMessage(chatId, 
          `❌ *Subscription failed*\n\n` +
          `Please try again later or contact support.`
        )
        return new Response('OK')
      }

      await sendTelegramMessage(chatId, 
        `✅ *Subscribed successfully!*\n\n` +
        `You'll receive notifications when OpenCode tasks complete.\n\n` +
        `*Your UUID:* \`${uuid}\`\n\n` +
        `*Commands:*\n` +
        `• /status - Check subscription\n` +
        `• /stop - Unsubscribe`
      )
      return new Response('OK')
    }

    // Handle /stop command
    if (text === '/stop') {
      const { data: subscriber } = await supabase
        .from('telegram_subscribers')
        .select('uuid')
        .eq('chat_id', chatId)
        .eq('is_active', true)
        .single()

      if (!subscriber) {
        await sendTelegramMessage(chatId, 
          `ℹ️ *Not subscribed*\n\n` +
          `You don't have an active subscription.\n` +
          `Use /start <uuid> to subscribe.`
        )
        return new Response('OK')
      }

      const { error } = await supabase
        .from('telegram_subscribers')
        .update({ is_active: false })
        .eq('chat_id', chatId)

      if (error) {
        console.error('Database error:', error)
        await sendTelegramMessage(chatId, `❌ *Failed to unsubscribe*\n\nPlease try again.`)
        return new Response('OK')
      }

      await sendTelegramMessage(chatId, 
        `👋 *Unsubscribed*\n\n` +
        `You won't receive notifications anymore.\n` +
        `Use /start <uuid> to resubscribe anytime.`
      )
      return new Response('OK')
    }

    // Handle /status command
    if (text === '/status') {
      const { data: subscriber } = await supabase
        .from('telegram_subscribers')
        .select('uuid, created_at, notifications_sent, last_notified_at, is_active')
        .eq('chat_id', chatId)
        .single()

      if (!subscriber) {
        await sendTelegramMessage(chatId, 
          `ℹ️ *No subscription found*\n\n` +
          `Use /start <uuid> to subscribe.`
        )
        return new Response('OK')
      }

      const status = subscriber.is_active ? '✅ Active' : '❌ Inactive'
      const lastNotified = subscriber.last_notified_at 
        ? new Date(subscriber.last_notified_at).toLocaleString()
        : 'Never'

      await sendTelegramMessage(chatId, 
        `📊 *Subscription Status*\n\n` +
        `*Status:* ${status}\n` +
        `*UUID:* \`${subscriber.uuid}\`\n` +
        `*Notifications sent:* ${subscriber.notifications_sent}\n` +
        `*Last notification:* ${lastNotified}\n` +
        `*Subscribed since:* ${new Date(subscriber.created_at).toLocaleDateString()}`
      )
      return new Response('OK')
    }

    // Handle /help command
    if (text === '/help') {
      await sendTelegramMessage(chatId, 
        `*OpenCode Notification Bot* 🤖\n\n` +
        `*Commands:*\n` +
        `• /start <uuid> - Subscribe with your UUID\n` +
        `• /stop - Unsubscribe from notifications\n` +
        `• /status - Check subscription status\n` +
        `• /help - Show this message\n\n` +
        `*Setup Instructions:*\n` +
        `1. Generate a UUID: \`uuidgen\`\n` +
        `2. Add to ~/.config/opencode/tts.json\n` +
        `3. Send /start <uuid> here\n\n` +
        `*More info:* github.com/opencode-ai/opencode`
      )
      return new Response('OK')
    }

    // Unknown command
    if (text.startsWith('/')) {
      await sendTelegramMessage(chatId, 
        `❓ *Unknown command*\n\n` +
        `Use /help to see available commands.`
      )
      return new Response('OK')
    }

    // ==================== HANDLE REPLY MESSAGES ====================
    // Non-command messages are treated as replies to the most recent notification
    // Look up active reply context and forward to OpenCode session
    
    // Get the most recent active reply context for this chat
    const { data: context, error: contextError } = await supabase
      .rpc('get_active_reply_context', { p_chat_id: chatId })

    if (contextError) {
      console.error('Error looking up reply context:', contextError)
      await sendTelegramMessage(chatId,
        `❌ *Error processing reply*\n\n` +
        `Please try again later.`
      )
      return new Response('OK')
    }

    // Check if we found an active context
    if (!context || context.length === 0) {
      await sendTelegramMessage(chatId,
        `ℹ️ *No active session*\n\n` +
        `There's no active OpenCode session to reply to.\n\n` +
        `Replies are available for 24 hours after receiving a notification.\n` +
        `Start a new task in OpenCode to receive notifications.`
      )
      return new Response('OK')
    }

    // We have an active context - store the reply for OpenCode to pick up
    const activeContext = context[0]
    
    const { error: insertError } = await supabase
      .from('telegram_replies')
      .insert({
        uuid: activeContext.uuid,
        session_id: activeContext.session_id,
        directory: activeContext.directory,
        reply_text: text,
        telegram_message_id: update.message.message_id,
        telegram_chat_id: chatId,
        processed: false,
      })

    if (insertError) {
      console.error('Error storing reply:', insertError)
      await sendTelegramMessage(chatId,
        `❌ *Failed to send reply*\n\n` +
        `Please try again.`
      )
      return new Response('OK')
    }

    // Confirm to user that reply was sent (simple emoji acknowledgment)
    await sendTelegramMessage(chatId, `✅`)

    return new Response('OK')
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response('Internal server error', { status: 500 })
  }
})
