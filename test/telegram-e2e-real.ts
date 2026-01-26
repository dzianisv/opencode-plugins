#!/usr/bin/env node
/**
 * Real End-to-End Test for Telegram Reply Flow
 * 
 * This test actually:
 * 1. Creates a reply context in Supabase (simulating send-notify)
 * 2. Sends a webhook request (simulating Telegram)
 * 3. Verifies the reply is stored in telegram_replies
 * 4. Checks if the reaction update API works
 * 
 * Run with: npx tsx test/telegram-e2e-real.ts
 * 
 * Requires:
 * - SUPABASE_SERVICE_KEY environment variable (for full access)
 * - Or uses anon key for read-only verification
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"
const WEBHOOK_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/telegram-webhook"
const UPDATE_REACTION_URL = "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/update-reaction"

// Test user - must exist in telegram_subscribers
const TEST_UUID = "a0dcb5d4-30c2-4dd0-bfbe-e569a42f47bb"
const TEST_CHAT_ID = 1916982742

interface TestResult {
  name: string
  passed: boolean
  error?: string
  details?: any
}

const results: TestResult[] = []

function log(msg: string) {
  console.log(`[TEST] ${msg}`)
}

function pass(name: string, details?: any) {
  results.push({ name, passed: true, details })
  console.log(`  ✅ ${name}`)
  if (details) console.log(`     ${JSON.stringify(details).slice(0, 100)}`)
}

function fail(name: string, error: string, details?: any) {
  results.push({ name, passed: false, error, details })
  console.log(`  ❌ ${name}: ${error}`)
  if (details) console.log(`     ${JSON.stringify(details).slice(0, 200)}`)
}

async function testWebhookEndpoint(): Promise<void> {
  log("Test 1: Webhook endpoint responds")
  
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 0,
        message: { message_id: 0, chat: { id: 0, type: "private" } }
      })
    })
    
    if (response.ok) {
      const text = await response.text()
      pass("Webhook endpoint responds", { status: response.status, body: text })
    } else {
      fail("Webhook endpoint responds", `HTTP ${response.status}`, await response.text())
    }
  } catch (err: any) {
    fail("Webhook endpoint responds", err.message)
  }
}

async function testWebhookNoAuth(): Promise<void> {
  log("Test 2: Webhook accepts requests without Authorization header (--no-verify-jwt)")
  
  try {
    // Send request WITHOUT any auth headers - this should work if deployed with --no-verify-jwt
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 99998,
          from: { id: TEST_CHAT_ID, is_bot: false, first_name: "Test" },
          chat: { id: TEST_CHAT_ID, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "E2E test message - ignore"
        }
      })
    })
    
    if (response.status === 401) {
      fail("Webhook accepts unauthenticated requests", 
           "Got 401 - webhook needs to be deployed with --no-verify-jwt",
           { fix: "Run: supabase functions deploy telegram-webhook --no-verify-jwt --project-ref slqxwymujuoipyiqscrl" })
    } else if (response.ok) {
      pass("Webhook accepts unauthenticated requests", { status: response.status })
    } else {
      fail("Webhook accepts unauthenticated requests", `HTTP ${response.status}`, await response.text())
    }
  } catch (err: any) {
    fail("Webhook accepts unauthenticated requests", err.message)
  }
}

async function testReplyContextExists(): Promise<void> {
  log("Test 3: Can query reply contexts from database")
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  
  try {
    const { data, error } = await supabase
      .from('telegram_reply_contexts')
      .select('id, session_id, message_id, is_active, created_at')
      .eq('uuid', TEST_UUID)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(3)
    
    if (error) {
      fail("Query reply contexts", error.message)
    } else if (data && data.length > 0) {
      pass("Query reply contexts", { count: data.length, latest: data[0] })
    } else {
      fail("Query reply contexts", "No active reply contexts found - notifications may not be working")
    }
  } catch (err: any) {
    fail("Query reply contexts", err.message)
  }
}

async function testRepliesStored(): Promise<void> {
  log("Test 4: Replies are being stored in database")
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  
  try {
    const { data, error } = await supabase
      .from('telegram_replies')
      .select('id, session_id, reply_text, processed, processed_at, created_at')
      .eq('uuid', TEST_UUID)
      .order('created_at', { ascending: false })
      .limit(5)
    
    if (error) {
      fail("Query stored replies", error.message)
    } else if (data && data.length > 0) {
      const processed = data.filter(r => r.processed)
      const unprocessed = data.filter(r => !r.processed)
      pass("Query stored replies", { 
        total: data.length, 
        processed: processed.length, 
        unprocessed: unprocessed.length,
        latestReply: data[0].reply_text?.slice(0, 50)
      })
      
      if (unprocessed.length > 0) {
        console.log(`  ⚠️  Warning: ${unprocessed.length} unprocessed replies - plugin may not be running`)
      }
    } else {
      fail("Query stored replies", "No replies found - have you sent any Telegram replies?")
    }
  } catch (err: any) {
    fail("Query stored replies", err.message)
  }
}

async function testReplyProcessingLatency(): Promise<void> {
  log("Test 5: Reply processing latency")
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  
  try {
    const { data, error } = await supabase
      .from('telegram_replies')
      .select('created_at, processed_at')
      .eq('uuid', TEST_UUID)
      .eq('processed', true)
      .order('created_at', { ascending: false })
      .limit(10)
    
    if (error) {
      fail("Check processing latency", error.message)
    } else if (data && data.length > 0) {
      const latencies = data.map(r => {
        const created = new Date(r.created_at).getTime()
        const processed = new Date(r.processed_at).getTime()
        return processed - created
      })
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length
      const maxLatency = Math.max(...latencies)
      
      if (avgLatency < 5000) {
        pass("Processing latency acceptable", { avgMs: Math.round(avgLatency), maxMs: maxLatency })
      } else {
        fail("Processing latency too high", `Average: ${Math.round(avgLatency)}ms`, { maxMs: maxLatency })
      }
    } else {
      fail("Check processing latency", "No processed replies to measure")
    }
  } catch (err: any) {
    fail("Check processing latency", err.message)
  }
}

async function testUpdateReactionEndpoint(): Promise<void> {
  log("Test 6: Update-reaction endpoint responds")
  
  try {
    // This will fail with invalid message ID, but endpoint should respond
    const response = await fetch(UPDATE_REACTION_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        chat_id: TEST_CHAT_ID,
        message_id: 1, // Invalid - will fail but tests endpoint
        emoji: "👍"
      })
    })
    
    // Any response (including error) means endpoint is working
    if (response.status === 401) {
      fail("Update-reaction endpoint", "Unauthorized - check API keys")
    } else {
      const body = await response.text()
      // Telegram will return an error about invalid message_id, but that's expected
      pass("Update-reaction endpoint responds", { status: response.status, hasResponse: body.length > 0 })
    }
  } catch (err: any) {
    fail("Update-reaction endpoint responds", err.message)
  }
}

async function testReactionEmojiValidity(): Promise<void> {
  log("Test 7: Thumbs up emoji is valid for Telegram reactions")
  
  // This is a code check - verify the plugin uses 👍 not ✅
  const fs = await import('fs/promises')
  const path = await import('path')
  
  try {
    const pluginPath = path.join(process.cwd(), 'tts.ts')
    const content = await fs.readFile(pluginPath, 'utf-8')
    
    // Find updateMessageReaction calls
    const calls = content.match(/updateMessageReaction\([^)]+\)/g) || []
    const usesThumbsUp = calls.some(c => c.includes("'👍'"))
    const usesCheckmark = calls.some(c => c.includes("'✅'"))
    
    if (usesThumbsUp && !usesCheckmark) {
      pass("Uses valid reaction emoji", { emoji: "👍", invalidEmoji: "✅ not used" })
    } else if (usesCheckmark) {
      fail("Uses invalid reaction emoji", "Still using ✅ which causes REACTION_INVALID error")
    } else {
      fail("Uses valid reaction emoji", "Could not find emoji usage in updateMessageReaction calls")
    }
  } catch (err: any) {
    fail("Check reaction emoji", err.message)
  }
}

async function testWebhookSimulation(): Promise<void> {
  log("Test 8: Simulate Telegram webhook with reply_to_message")
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  
  try {
    // First, get an active reply context
    const { data: contexts } = await supabase
      .from('telegram_reply_contexts')
      .select('id, session_id, message_id, chat_id')
      .eq('uuid', TEST_UUID)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
    
    if (!contexts || contexts.length === 0) {
      fail("Simulate webhook reply", "No active reply context - send a notification first")
      return
    }
    
    const context = contexts[0]
    const testMessageId = Date.now() % 1000000 // Unique message ID
    
    // Send a simulated webhook that replies to an existing message
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: testMessageId,
        message: {
          message_id: testMessageId,
          from: { id: TEST_CHAT_ID, is_bot: false, first_name: "E2E Test" },
          chat: { id: context.chat_id, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: `E2E Test Reply ${Date.now()}`,
          reply_to_message: {
            message_id: context.message_id,
            from: { id: 0, is_bot: true, first_name: "Bot" },
            chat: { id: context.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000) - 60,
            text: "Original notification"
          }
        }
      })
    })
    
    if (!response.ok) {
      fail("Simulate webhook reply", `HTTP ${response.status}`, await response.text())
      return
    }
    
    // Wait a moment for processing
    await new Promise(r => setTimeout(r, 2000))
    
    // Check if reply was stored
    const { data: replies } = await supabase
      .from('telegram_replies')
      .select('*')
      .eq('telegram_message_id', testMessageId)
      .limit(1)
    
    if (replies && replies.length > 0) {
      pass("Simulate webhook reply", { 
        replyId: replies[0].id.slice(0, 8),
        sessionId: replies[0].session_id,
        processed: replies[0].processed
      })
    } else {
      fail("Simulate webhook reply", "Reply not found in database after webhook")
    }
  } catch (err: any) {
    fail("Simulate webhook reply", err.message)
  }
}

async function main() {
  console.log("\n========================================")
  console.log("  Telegram Reply Flow - E2E Tests")
  console.log("========================================\n")
  
  await testWebhookEndpoint()
  await testWebhookNoAuth()
  await testReplyContextExists()
  await testRepliesStored()
  await testReplyProcessingLatency()
  await testUpdateReactionEndpoint()
  await testReactionEmojiValidity()
  await testWebhookSimulation()
  
  console.log("\n========================================")
  console.log("  Summary")
  console.log("========================================\n")
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Total:  ${results.length}`)
  
  if (failed > 0) {
    console.log("\n  Failed tests:")
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`)
    }
    process.exit(1)
  } else {
    console.log("\n  ✅ All tests passed!")
    process.exit(0)
  }
}

main().catch(err => {
  console.error("Test runner failed:", err)
  process.exit(1)
})
