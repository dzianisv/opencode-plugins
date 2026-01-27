/**
 * Send Notification Edge Function for OpenCode TTS Plugin
 * 
 * Called by the OpenCode plugin to send text and voice messages to Telegram.
 * Stores session context so users can reply to notifications.
 * 
 * Request body:
 * {
 *   uuid: string,           // User's UUID
 *   text?: string,          // Text message to send
 *   voice_base64?: string,  // Base64 encoded OGG audio
 *   session_id?: string,    // OpenCode session ID (for reply support)
 *   directory?: string,     // Working directory (for context)
 * }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Rate limiting: max 10 notifications per minute per UUID
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 10
const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

interface SendNotifyRequest {
  uuid: string
  text?: string
  voice_base64?: string
  session_id?: string    // OpenCode session ID for reply support
  directory?: string     // Working directory for context
}

function isValidUUID(str: string): boolean {
  return UUID_REGEX.test(str)
}

function isRateLimited(uuid: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(uuid)
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(uuid, { count: 1, windowStart: now })
    return false
  }
  
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true
  }
  
  entry.count++
  return false
}

/**
 * Escape special characters for Telegram MarkdownV2
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1')
}

/**
 * Convert common markdown to Telegram MarkdownV2 format
 * This preserves code blocks and basic formatting while escaping problematic characters
 */
function convertToTelegramMarkdown(text: string): string {
  // First, extract and protect code blocks (``` and `)
  const codeBlocks: string[] = []
  const inlineCode: string[] = []
  
  // Protect fenced code blocks (```...```)
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    // Don't escape inside code blocks, just use pre formatting
    codeBlocks.push(`\`\`\`${lang}\n${code}\`\`\``)
    return `__CODE_BLOCK_${idx}__`
  })
  
  // Protect inline code (`...`)
  processed = processed.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCode.length
    inlineCode.push(`\`${code}\``)
    return `__INLINE_CODE_${idx}__`
  })
  
  // Now escape the rest of the text for MarkdownV2
  processed = escapeMarkdownV2(processed)
  
  // Convert markdown headers to bold (## Header -> *Header*)
  processed = processed.replace(/^\\#\\#\\#\s+(.+)$/gm, '*$1*')
  processed = processed.replace(/^\\#\\#\s+(.+)$/gm, '*$1*')
  processed = processed.replace(/^\\#\s+(.+)$/gm, '*$1*')
  
  // Convert **bold** to *bold* (MarkdownV2 uses single asterisk)
  processed = processed.replace(/\\\*\\\*([^*]+)\\\*\\\*/g, '*$1*')
  
  // Convert __underline__ or _italic_ - keep as is since we escaped them
  // Just unescape single underscores for italic
  processed = processed.replace(/\\_([^_]+)\\_/g, '_$1_')
  
  // Restore code blocks (they're already in correct format)
  codeBlocks.forEach((block, idx) => {
    processed = processed.replace(`__CODE_BLOCK_${idx}__`, block)
  })
  
  // Restore inline code
  inlineCode.forEach((code, idx) => {
    processed = processed.replace(`__INLINE_CODE_${idx}__`, code)
  })
  
  return processed
}

async function sendTelegramMessage(chatId: number, text: string, useMarkdown: boolean = true): Promise<{ success: boolean; messageId?: number; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: useMarkdown ? convertToTelegramMarkdown(text) : text,
    }
    
    if (useMarkdown) {
      body.parse_mode = 'MarkdownV2'
    }
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error('Telegram sendMessage failed:', errorText)
      
      // If markdown parsing failed, retry without markdown
      if (useMarkdown && errorText.includes("can't parse")) {
        console.log('Retrying without markdown...')
        return sendTelegramMessage(chatId, text, false)
      }
      
      return { success: false, error: errorText }
    }
    
    // Extract message_id from response for reply context tracking
    const result = await response.json()
    return { success: true, messageId: result.result?.message_id }
  } catch (error) {
    console.error('Failed to send Telegram message:', error)
    return { success: false, error: String(error) }
  }
}

async function sendTelegramVoice(chatId: number, audioBase64: string): Promise<boolean> {
  try {
    // Decode base64 to Uint8Array
    const binaryString = atob(audioBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    
    // Create form data with the voice file
    const formData = new FormData()
    formData.append('chat_id', chatId.toString())
    formData.append('voice', new Blob([bytes], { type: 'audio/ogg' }), 'voice.ogg')
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`, {
      method: 'POST',
      body: formData,
    })
    
    if (!response.ok) {
      const error = await response.text()
      console.error('Telegram sendVoice failed:', error)
      
      // Fallback: try sending as audio file instead
      return await sendTelegramAudio(chatId, audioBase64)
    }
    return true
  } catch (error) {
    console.error('Failed to send Telegram voice:', error)
    return false
  }
}

async function sendTelegramAudio(chatId: number, audioBase64: string): Promise<boolean> {
  try {
    const binaryString = atob(audioBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    
    const formData = new FormData()
    formData.append('chat_id', chatId.toString())
    formData.append('audio', new Blob([bytes], { type: 'audio/ogg' }), 'notification.ogg')
    formData.append('title', 'OpenCode Notification')
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
      method: 'POST',
      body: formData,
    })
    
    if (!response.ok) {
      const error = await response.text()
      console.error('Telegram sendAudio failed:', error)
      return false
    }
    return true
  } catch (error) {
    console.error('Failed to send Telegram audio:', error)
    return false
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Verify required environment variables
  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ success: false, error: 'Server configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body: SendNotifyRequest = await req.json()
    const { uuid, text, voice_base64, session_id, directory } = body

    // Validate UUID
    if (!uuid || !isValidUUID(uuid)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid or missing UUID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check rate limit
    if (isRateLimited(uuid)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Rate limit exceeded. Max 10 notifications per minute.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Must have at least text or voice
    if (!text && !voice_base64) {
      return new Response(
        JSON.stringify({ success: false, error: 'Must provide text or voice_base64' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client with service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Lookup subscriber by UUID
    const { data: subscriber, error: lookupError } = await supabase
      .from('telegram_subscribers')
      .select('chat_id, is_active')
      .eq('uuid', uuid)
      .single()

    if (lookupError || !subscriber) {
      return new Response(
        JSON.stringify({ success: false, error: 'UUID not found. Use /start <uuid> in Telegram bot to subscribe.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!subscriber.is_active) {
      return new Response(
        JSON.stringify({ success: false, error: 'Subscription is inactive. Use /start <uuid> in Telegram to reactivate.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const chatId = subscriber.chat_id
    let textSent = false
    let voiceSent = false
    let sentMessageId: number | undefined
    let textError: string | undefined

    // Send text message
    if (text) {
      // Truncate text if too long (Telegram limit is 4096 chars, leave room for header/footer)
      const maxLen = 3800
      const truncatedText = text.length > maxLen 
        ? text.slice(0, maxLen) + '\n\n...(truncated)'
        : text
      
      // Add reply hint if session context is provided
      const replyHint = session_id 
        ? '\n\n💬 Reply to this message to continue the conversation'
        : ''
      
      // Build the full message - the convertToTelegramMarkdown function will handle escaping
      // Use plain text header to avoid markdown conflicts
      const fullMessage = `🔔 OpenCode Task Complete\n\n${truncatedText}${replyHint}`
      
      const messageResult = await sendTelegramMessage(chatId, fullMessage)
      textSent = messageResult.success
      sentMessageId = messageResult.messageId
      if (!messageResult.success) {
        textError = messageResult.error
        console.error('Text message failed:', textError)
      }
    }

    // Send voice message
    if (voice_base64) {
      // Validate base64 (rough size check: ~50MB max)
      if (voice_base64.length > 70_000_000) {
        return new Response(
          JSON.stringify({ success: false, error: 'Voice file too large (max 50MB)' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      voiceSent = await sendTelegramVoice(chatId, voice_base64)
    }

    // Update notification stats
    if (textSent || voiceSent) {
      await supabase.rpc('increment_notifications', { row_uuid: uuid })
    }

    // Store reply context if session_id is provided (enables two-way communication)
    // Keep all contexts active - routing is done by message_id matching when user replies
    if (session_id && (textSent || voiceSent)) {
      try {
        // Insert new reply context (don't deactivate previous - allows replying to any notification)
        const { error: contextError } = await supabase
          .from('telegram_reply_contexts')
          .insert({
            chat_id: chatId,
            uuid,
            session_id,
            directory,
            message_id: sentMessageId,
            is_active: true,
            expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48 hours
          })

        if (contextError) {
          console.error('Failed to store reply context:', contextError)
          // Don't fail the request, notification was still sent
        }
      } catch (contextErr) {
        console.error('Error storing reply context:', contextErr)
      }
    }

    return new Response(
      JSON.stringify({ 
        success: textSent || voiceSent, 
        text_sent: textSent, 
        voice_sent: voiceSent,
        reply_enabled: !!session_id,
        text_error: textError,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Send notify error:', error)
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
