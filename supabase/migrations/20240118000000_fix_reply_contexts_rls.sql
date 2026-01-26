-- Migration: Fix RLS policies for telegram_reply_contexts
-- The service role key should have full access for Edge Functions to work
-- This complements the fix in 20240117000000_fix_replies_rls.sql

-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Service role only" ON public.telegram_reply_contexts;

-- Create explicit policies:

-- 1. Service role can do anything (for Edge Functions like send-notify)
CREATE POLICY "Service role full access" ON public.telegram_reply_contexts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Allow anon to SELECT their own contexts (for debugging/verification)
-- The filter is applied via UUID in the WHERE clause
CREATE POLICY "Anon can select own contexts" ON public.telegram_reply_contexts
  FOR SELECT
  USING (true);  -- Clients must filter by uuid

COMMENT ON POLICY "Service role full access" ON public.telegram_reply_contexts IS 
  'Allows Edge Functions using service role key to insert/update/delete reply contexts';
