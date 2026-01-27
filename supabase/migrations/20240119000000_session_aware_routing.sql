-- Migration: Session-aware Telegram reply routing
-- Issue: #22
-- 
-- This migration adds an index for efficient message_id lookups
-- which is used for routing replies to the correct OpenCode session.

-- Add index for efficient message_id lookups (used by telegram-webhook)
-- The reply_to_message.message_id is matched against this to route replies
CREATE INDEX IF NOT EXISTS idx_reply_contexts_message_id 
  ON public.telegram_reply_contexts(chat_id, message_id) 
  WHERE message_id IS NOT NULL;

-- Note: We no longer deactivate previous contexts (is_active stays true)
-- This allows users to reply to older notifications and still route correctly.
-- Contexts expire after 48 hours via expires_at column.

COMMENT ON INDEX idx_reply_contexts_message_id IS 
  'Index for routing Telegram replies by message_id - see issue #22';
