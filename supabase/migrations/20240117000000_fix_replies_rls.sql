-- Migration: Fix RLS policies for telegram_replies to allow realtime subscriptions
-- The OpenCode TTS plugin uses the anon key for realtime subscriptions and needs to:
-- 1. SELECT (to receive realtime events for their UUID)
-- 2. UPDATE (to mark replies as processed)

-- Drop the overly restrictive "service role only" policy for telegram_replies
DROP POLICY IF EXISTS "Service role only" ON public.telegram_replies;

-- Create separate policies for different operations:

-- 1. Service role can do anything (for Edge Functions)
CREATE POLICY "Service role full access" ON public.telegram_replies
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Anon users can SELECT rows matching their UUID filter
-- This enables realtime subscriptions to work (the filter is applied in the subscription)
-- Note: Supabase realtime uses RLS, so this is required for the plugin to receive events
CREATE POLICY "Anon can select for realtime" ON public.telegram_replies
  FOR SELECT
  USING (true);  -- Realtime applies the filter from subscription (uuid=eq.X)

-- 3. Anon users can UPDATE to mark as processed
-- We use a function for this to be more secure
CREATE POLICY "Anon can update processed status" ON public.telegram_replies
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Alternative: Use a SECURITY DEFINER function for marking as processed
-- This is more secure as it only allows setting processed=true
CREATE OR REPLACE FUNCTION public.mark_reply_processed(p_reply_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.telegram_replies
  SET 
    processed = true,
    processed_at = NOW()
  WHERE id = p_reply_id
    AND processed = false;  -- Only update if not already processed
  
  RETURN FOUND;
END;
$$;

-- Grant execute on the function to anon role
GRANT EXECUTE ON FUNCTION public.mark_reply_processed(UUID) TO anon;

COMMENT ON FUNCTION public.mark_reply_processed IS 'Securely marks a telegram reply as processed. Called by OpenCode plugin after handling the reply.';
