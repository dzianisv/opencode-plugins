/**
 * Update Reaction Edge Function
 * 
 * Updates a Telegram message reaction (e.g., from 👀 to ✅)
 * Called by the TTS plugin after successfully forwarding a reply to OpenCode.
 * 
 * POST body:
 * {
 *   "chat_id": number,
 *   "message_id": number,
 *   "emoji": string  // e.g., "✅", "❌", "👀"
 * }
 */

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!

interface UpdateReactionRequest {
  chat_id: number
  message_id: number
  emoji: string
}

Deno.serve(async (req) => {
  // CORS headers for browser requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  // Verify bot token is configured
  if (!BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN environment variable')
    return new Response('Server configuration error', { status: 500, headers: corsHeaders })
  }

  try {
    const body: UpdateReactionRequest = await req.json()
    
    // Validate required fields
    if (!body.chat_id || !body.message_id || !body.emoji) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: chat_id, message_id, emoji' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Call Telegram API to update reaction
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: body.chat_id,
        message_id: body.message_id,
        reaction: [{ type: 'emoji', emoji: body.emoji }],
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Telegram API error:', error)
      return new Response(
        JSON.stringify({ error: 'Failed to update reaction', details: error }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const result = await response.json()
    return new Response(
      JSON.stringify({ success: true, result }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Update reaction error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
