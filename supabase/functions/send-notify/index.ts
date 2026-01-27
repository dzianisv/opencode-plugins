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
 * Escape special characters for HTML
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert common markdown to Telegram HTML format
 * HTML is more forgiving than MarkdownV2 and handles special characters better
 */
function convertToTelegramHtml(text: string): string {
  try {
    let processed = text
    
    // Use UUID-like placeholders that won't appear in normal text
    const PLACEHOLDER_PREFIX = '___PLACEHOLDER_'
    const PLACEHOLDER_SUFFIX = '___'
    const codeBlocks: string[] = []
    const inlineCode: string[] = []
    
    // Step 1: Extract fenced code blocks (```lang\ncode```)
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g
    let match
    while ((match = codeBlockRegex.exec(processed)) !== null) {
      const idx = codeBlocks.length
      const lang = match[1] || ''
      const code = match[2] || ''
      const langAttr = lang ? ` class="language-${lang}"` : ''
      codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`)
    }
    // Replace all matches
    let cbIdx = 0
    processed = processed.replace(/```(\w*)\n?([\s\S]*?)```/g, () => {
      return `${PLACEHOLDER_PREFIX}CB${cbIdx++}${PLACEHOLDER_SUFFIX}`
    })
    
    // Step 2: Extract inline code (`code`)
    const inlineCodeRegex = /`([^`]+)`/g
    while ((match = inlineCodeRegex.exec(processed)) !== null) {
      const code = match[1] || ''
      inlineCode.push(`<code>${escapeHtml(code)}</code>`)
    }
    // Replace all matches
    let icIdx = 0
    processed = processed.replace(/`([^`]+)`/g, () => {
      return `${PLACEHOLDER_PREFIX}IC${icIdx++}${PLACEHOLDER_SUFFIX}`
    })
    
    // Step 3: Escape HTML in remaining text
    processed = escapeHtml(processed)
    
    // Step 4: Convert markdown formatting
    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    processed = processed.replace(/_([^_]+)_/g, '<i>$1</i>')
    processed = processed.replace(/^###\s+(.+)$/gm, '<b>$1</b>')
    processed = processed.replace(/^##\s+(.+)$/gm, '<b>$1</b>')
    processed = processed.replace(/^#\s+(.+)$/gm, '<b>$1</b>')
    
    // Step 5: Restore code blocks and inline code
    for (let i = 0; i < codeBlocks.length; i++) {
      processed = processed.replace(`${PLACEHOLDER_PREFIX}CB${i}${PLACEHOLDER_SUFFIX}`, codeBlocks[i])
    }
    for (let i = 0; i < inlineCode.length; i++) {
      processed = processed.replace(`${PLACEHOLDER_PREFIX}IC${i}${PLACEHOLDER_SUFFIX}`, inlineCode[i])
    }
    
    return processed
  } catch (error) {
    console.error('Error converting to Telegram HTML:', error)
    // Fallback: just escape HTML
    return escapeHtml(text)
  }
}

async function sendTelegramMessage(chatId: number, text: string, useHtml: boolean = true): Promise<{ success: boolean; messageId?: number; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: useHtml ? convertToTelegramHtml(text) : text,
    }
    
    if (useHtml) {
      body.parse_mode = 'HTML'
    }
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error('Telegram sendMessage failed:', errorText)
      
      // If HTML parsing failed, retry without formatting
      if (useHtml && (errorText.includes("can't parse") || errorText.includes("Bad Request"))) {
        console.log('Retrying without HTML formatting...')
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
