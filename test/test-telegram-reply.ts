#!/usr/bin/env npx ts-node
/**
 * Manual test script for Telegram reply processing
 * 
 * This script simulates a Telegram reply by inserting directly into Supabase
 * and verifies the reply processing logic handles it correctly.
 * 
 * Usage:
 *   npx ts-node test/test-telegram-reply.ts
 * 
 * Prerequisites:
 *   - OpenCode must be running with the updated tts.ts plugin
 *   - TTS_DEBUG=1 to see debug logs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"

async function main() {
  console.log("=== Telegram Reply Processing Test ===\n")
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  
  // Generate a unique test reply ID
  const testReplyId = `test-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const testSessionId = `ses_test_${Date.now()}`
  const testChatId = 12345678 // Fake chat ID
  
  console.log(`Test Reply ID: ${testReplyId}`)
  console.log(`Test Session ID: ${testSessionId}`)
  console.log()
  
  // Step 1: Insert a test reply
  console.log("Step 1: Inserting test reply into telegram_replies table...")
  
  const { data: insertData, error: insertError } = await supabase
    .from('telegram_replies')
    .insert({
      id: testReplyId,
      chat_id: testChatId,
      session_id: testSessionId,
      reply_text: `Test reply at ${new Date().toISOString()}`,
      processed: false,
      is_voice: false
    })
    .select()
  
  if (insertError) {
    console.error("Failed to insert test reply:", insertError.message)
    console.log("\nNote: This test requires the telegram_replies table to exist.")
    console.log("Make sure migrations have been run on Supabase.")
    process.exit(1)
  }
  
  console.log("✓ Test reply inserted successfully")
  console.log()
  
  // Step 2: Wait a moment for any subscribers to process
  console.log("Step 2: Waiting 3 seconds for processing...")
  await new Promise(resolve => setTimeout(resolve, 3000))
  
  // Step 3: Check if the reply was marked as processed
  console.log("Step 3: Checking if reply was marked as processed...")
  
  const { data: checkData, error: checkError } = await supabase
    .from('telegram_replies')
    .select('processed')
    .eq('id', testReplyId)
    .single()
  
  if (checkError) {
    console.error("Failed to check reply status:", checkError.message)
    process.exit(1)
  }
  
  if (checkData?.processed) {
    console.log("✓ Reply was marked as processed by an OpenCode instance")
    console.log("\n  This confirms:")
    console.log("  - Supabase Realtime subscription is working")
    console.log("  - Reply processing logic executed")
    console.log("  - markReplyProcessed() was called")
  } else {
    console.log("✗ Reply was NOT processed")
    console.log("\n  Possible causes:")
    console.log("  - No OpenCode instance is running")
    console.log("  - TTS plugin is not enabled")
    console.log("  - Telegram config is not set up")
    console.log("  - Supabase Realtime subscription failed")
  }
  
  // Step 4: Cleanup - delete the test reply
  console.log("\nStep 4: Cleaning up test data...")
  
  const { error: deleteError } = await supabase
    .from('telegram_replies')
    .delete()
    .eq('id', testReplyId)
  
  if (deleteError) {
    console.warn("Warning: Failed to clean up test reply:", deleteError.message)
  } else {
    console.log("✓ Test reply deleted")
  }
  
  console.log("\n=== Test Complete ===")
}

main().catch(err => {
  console.error("Test failed:", err)
  process.exit(1)
})
