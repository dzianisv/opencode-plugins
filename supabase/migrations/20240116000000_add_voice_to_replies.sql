-- Migration: Add voice message support to telegram_replies table
-- Voice messages are now stored directly in telegram_replies with audio_base64
-- This simplifies the architecture: one table for all types of replies

-- Add columns for voice message data
ALTER TABLE public.telegram_replies 
  ADD COLUMN IF NOT EXISTS is_voice BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS audio_base64 TEXT,
  ADD COLUMN IF NOT EXISTS voice_file_type TEXT,
  ADD COLUMN IF NOT EXISTS voice_duration_seconds INTEGER;

-- Make reply_text nullable to allow voice-only messages
-- The text will be populated after local transcription
ALTER TABLE public.telegram_replies 
  ALTER COLUMN reply_text DROP NOT NULL;

-- Add index for voice messages that need processing
CREATE INDEX IF NOT EXISTS idx_telegram_replies_voice_unprocessed 
  ON public.telegram_replies(is_voice, processed) 
  WHERE is_voice = TRUE AND processed = FALSE;

-- Add comment explaining voice flow
COMMENT ON COLUMN public.telegram_replies.is_voice IS 'True if this reply is a voice/video message requiring transcription';
COMMENT ON COLUMN public.telegram_replies.audio_base64 IS 'Base64-encoded audio data downloaded by Edge Function from Telegram';
COMMENT ON COLUMN public.telegram_replies.voice_file_type IS 'Type of voice message: voice, video_note, or video';
COMMENT ON COLUMN public.telegram_replies.voice_duration_seconds IS 'Duration of the voice/video message in seconds';

-- Drop the old telegram_voice_messages table as it is no longer needed
-- First remove from realtime publication (if it exists)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE telegram_voice_messages;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'Table not in publication or publication does not exist';
  WHEN undefined_table THEN
    RAISE NOTICE 'Table telegram_voice_messages does not exist';
END $$;

-- Drop the old table if it exists
DROP TABLE IF EXISTS public.telegram_voice_messages;
