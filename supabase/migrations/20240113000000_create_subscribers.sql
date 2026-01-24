-- Create subscribers table for Telegram notification service
-- Maps user UUID to Telegram chat_id

CREATE TABLE IF NOT EXISTS public.telegram_subscribers (
  uuid UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_notified_at TIMESTAMPTZ,
  notifications_sent INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE
);

-- Index for quick lookup by chat_id (to check existing subscription)
CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_chat_id ON public.telegram_subscribers(chat_id);

-- Index for active subscribers
CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_active ON public.telegram_subscribers(is_active) WHERE is_active = TRUE;

-- Add comment for documentation
COMMENT ON TABLE public.telegram_subscribers IS 'Maps OpenCode user UUIDs to Telegram chat IDs for notifications';
COMMENT ON COLUMN public.telegram_subscribers.uuid IS 'User-generated UUID secret, shared between OpenCode plugin and Telegram bot';
COMMENT ON COLUMN public.telegram_subscribers.chat_id IS 'Telegram chat ID where notifications are sent';
COMMENT ON COLUMN public.telegram_subscribers.username IS 'Telegram username (optional, for display)';
COMMENT ON COLUMN public.telegram_subscribers.is_active IS 'Whether the subscription is active (set to false on /stop)';

-- Enable Row Level Security
ALTER TABLE public.telegram_subscribers ENABLE ROW LEVEL SECURITY;

-- Only service role can access this table (no public access)
-- This ensures the table is only accessible via Edge Functions with service_role key
CREATE POLICY "Service role only" ON public.telegram_subscribers
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Function to increment notification count atomically
CREATE OR REPLACE FUNCTION public.increment_notifications(row_uuid UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE public.telegram_subscribers
  SET 
    notifications_sent = notifications_sent + 1,
    last_notified_at = NOW()
  WHERE uuid = row_uuid
  RETURNING notifications_sent INTO new_count;
  
  RETURN new_count;
END;
$$;
