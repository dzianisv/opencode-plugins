-- Add processed_error column to track delivery failures
-- This allows us to mark messages as processed (preventing duplicates)
-- while still tracking which ones failed to deliver

ALTER TABLE telegram_replies
ADD COLUMN IF NOT EXISTS processed_error TEXT DEFAULT NULL;

-- Add comment explaining the field
COMMENT ON COLUMN telegram_replies.processed_error IS 
  'Error message when reply processing failed (e.g., session_not_found). NULL means success.';

-- Create index for finding failed deliveries
CREATE INDEX IF NOT EXISTS idx_telegram_replies_processed_error 
  ON telegram_replies(processed_error) 
  WHERE processed_error IS NOT NULL;

-- Create function to set error on a reply
-- Used when reply processing fails (e.g., session no longer exists)
CREATE OR REPLACE FUNCTION public.set_reply_error(p_reply_id UUID, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.telegram_replies
  SET 
    processed_error = p_error
  WHERE id = p_reply_id;
  
  RETURN FOUND;
END;
$$;

-- Grant execute on the function to anon role
GRANT EXECUTE ON FUNCTION public.set_reply_error(UUID, TEXT) TO anon;

COMMENT ON FUNCTION public.set_reply_error IS 'Records an error for a telegram reply that failed to process. Called by OpenCode plugin when session is not found.';
