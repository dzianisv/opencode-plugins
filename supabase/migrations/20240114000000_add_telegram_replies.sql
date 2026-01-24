-- Add tables for Telegram reply support
-- Enables two-way communication: users can reply to notifications and have them forwarded to OpenCode

-- ==================== REPLY CONTEXTS TABLE ====================
-- Tracks active sessions that can receive replies
-- When a notification is sent, the session context is stored here

CREATE TABLE IF NOT EXISTS public.telegram_reply_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL,                    -- Telegram chat ID
  uuid UUID NOT NULL REFERENCES public.telegram_subscribers(uuid) ON DELETE CASCADE,
  session_id TEXT NOT NULL,                   -- OpenCode session ID
  message_id INTEGER,                         -- Telegram message ID sent (for reply matching)
  directory TEXT,                             -- Working directory for context
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  is_active BOOLEAN DEFAULT TRUE
);

-- Index for quick lookup by chat_id (when user replies)
CREATE INDEX IF NOT EXISTS idx_reply_contexts_chat_id ON public.telegram_reply_contexts(chat_id);

-- Index for active contexts lookup
CREATE INDEX IF NOT EXISTS idx_reply_contexts_active ON public.telegram_reply_contexts(is_active, chat_id) 
  WHERE is_active = TRUE;

-- Index for cleanup of expired contexts
CREATE INDEX IF NOT EXISTS idx_reply_contexts_expires ON public.telegram_reply_contexts(expires_at);

-- Comments for documentation
COMMENT ON TABLE public.telegram_reply_contexts IS 'Tracks active OpenCode sessions that can receive Telegram replies';
COMMENT ON COLUMN public.telegram_reply_contexts.session_id IS 'OpenCode session ID where replies will be forwarded';
COMMENT ON COLUMN public.telegram_reply_contexts.message_id IS 'Telegram message ID of the notification, for reply thread tracking';
COMMENT ON COLUMN public.telegram_reply_contexts.expires_at IS 'Context expires after 24 hours to prevent stale sessions';

-- ==================== REPLIES TABLE ====================
-- Stores incoming replies from Telegram users
-- OpenCode plugin subscribes to this table via Supabase Realtime

CREATE TABLE IF NOT EXISTS public.telegram_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uuid UUID NOT NULL REFERENCES public.telegram_subscribers(uuid) ON DELETE CASCADE,
  session_id TEXT NOT NULL,                   -- OpenCode session ID to forward to
  directory TEXT,                             -- Working directory context
  reply_text TEXT NOT NULL,                   -- The user's reply message
  telegram_message_id INTEGER,                -- Telegram message ID of the reply
  telegram_chat_id BIGINT NOT NULL,           -- Chat ID where reply came from
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed BOOLEAN DEFAULT FALSE,            -- Set to true after OpenCode processes it
  processed_at TIMESTAMPTZ                    -- When it was processed
);

-- Index for realtime subscriptions by UUID
CREATE INDEX IF NOT EXISTS idx_telegram_replies_uuid ON public.telegram_replies(uuid);

-- Index for unprocessed replies
CREATE INDEX IF NOT EXISTS idx_telegram_replies_unprocessed ON public.telegram_replies(processed, uuid) 
  WHERE processed = FALSE;

-- Comments for documentation
COMMENT ON TABLE public.telegram_replies IS 'Incoming replies from Telegram users to be forwarded to OpenCode sessions';
COMMENT ON COLUMN public.telegram_replies.processed IS 'Set to true after OpenCode successfully receives and processes the reply';

-- ==================== ROW LEVEL SECURITY ====================

-- Enable RLS on new tables
ALTER TABLE public.telegram_reply_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_replies ENABLE ROW LEVEL SECURITY;

-- Only service role can access these tables (Edge Functions use service role key)
CREATE POLICY "Service role only" ON public.telegram_reply_contexts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role only" ON public.telegram_replies
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ==================== ENABLE REALTIME ====================
-- Enable realtime for telegram_replies so OpenCode plugin can subscribe

-- Note: This requires the supabase_realtime publication to exist
-- If it doesn't, the table will still work, just without realtime subscriptions
DO $$
BEGIN
  -- Try to add table to realtime publication
  ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_replies;
EXCEPTION
  WHEN undefined_object THEN
    -- Publication doesn't exist, that's OK for local dev
    RAISE NOTICE 'supabase_realtime publication not found, skipping realtime setup';
  WHEN duplicate_object THEN
    -- Table already in publication
    RAISE NOTICE 'Table already in supabase_realtime publication';
END $$;

-- ==================== CLEANUP FUNCTION ====================
-- Function to clean up expired reply contexts (can be called by cron job)

CREATE OR REPLACE FUNCTION public.cleanup_expired_reply_contexts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Deactivate expired contexts
  WITH deactivated AS (
    UPDATE public.telegram_reply_contexts
    SET is_active = FALSE
    WHERE is_active = TRUE AND expires_at < NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deactivated;
  
  -- Delete very old contexts (older than 7 days)
  DELETE FROM public.telegram_reply_contexts
  WHERE expires_at < NOW() - INTERVAL '7 days';
  
  -- Delete old processed replies (older than 7 days)
  DELETE FROM public.telegram_replies
  WHERE processed = TRUE AND processed_at < NOW() - INTERVAL '7 days';
  
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_reply_contexts IS 'Cleans up expired reply contexts and old processed replies. Call periodically via cron.';

-- ==================== HELPER FUNCTION ====================
-- Function to get the most recent active context for a chat

CREATE OR REPLACE FUNCTION public.get_active_reply_context(p_chat_id BIGINT)
RETURNS TABLE(
  session_id TEXT,
  directory TEXT,
  uuid UUID,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    rc.session_id,
    rc.directory,
    rc.uuid,
    rc.created_at
  FROM public.telegram_reply_contexts rc
  WHERE rc.chat_id = p_chat_id
    AND rc.is_active = TRUE
    AND rc.expires_at > NOW()
  ORDER BY rc.created_at DESC
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_active_reply_context IS 'Returns the most recent active reply context for a chat, used when user replies to a notification';
