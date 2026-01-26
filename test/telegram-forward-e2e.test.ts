/**
 * E2E Test: Telegram Reply Forwarding to OpenCode Session
 *
 * Tests the COMPLETE flow:
 * 1. Start OpenCode server with TTS/Telegram plugin
 * 2. Create a session
 * 3. Insert a reply into telegram_replies table (simulating webhook)
 * 4. Verify the reply appears as a user message in the session
 *
 * This closes the testing gap where we only verified database state,
 * not actual forwarding to the session.
 *
 * Run with: OPENCODE_E2E=1 npm run test:telegram:forward
 */

import { describe, it, before, after, skip } from "node:test"
import assert from "node:assert"
import { mkdir, rm, writeFile, readFile } from "fs/promises"
import { spawn, type ChildProcess } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { randomUUID } from "crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Config
const SUPABASE_URL = "https://slqxwymujuoipyiqscrl.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjExODA0NSwiZXhwIjoyMDgxNjk0MDQ1fQ.iXPpNU_utY2deVrUVPIfwOiz2XjQI06JZ_I_hJawR8c"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscXh3eW11anVvaXB5aXFzY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMTgwNDUsImV4cCI6MjA4MTY5NDA0NX0.cW79nLOdKsUhZaXIvgY4gGcO4Y4R0lDGNg7SE_zEfb8"
const TEST_UUID = "a0dcb5d4-30c2-4dd0-bfbe-e569a42f47bb"
const TEST_CHAT_ID = 1916982742

const PORT = 3300
const TIMEOUT = 120_000
const MODEL = process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"

// Only run in E2E mode
const RUN_E2E = process.env.OPENCODE_E2E === "1"

async function waitForServer(port: number, timeout: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/session`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Wait for a message containing specific text to appear in session
 */
async function waitForMessage(
  client: OpencodeClient,
  sessionId: string,
  containsText: string,
  timeout: number
): Promise<{ found: boolean; message?: any; allMessages?: any[] }> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const { data: messages } = await client.session.messages({
      path: { id: sessionId }
    })

    if (messages) {
      for (const msg of messages) {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text?.includes(containsText)) {
            return { found: true, message: msg, allMessages: messages }
          }
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  // Return last state for debugging
  const { data: messages } = await client.session.messages({
    path: { id: sessionId }
  })
  return { found: false, allMessages: messages }
}

describe("E2E: Telegram Reply Forwarding", { timeout: TIMEOUT * 2 }, () => {
  const testDir = "/tmp/opencode-telegram-forward-e2e"
  let server: ChildProcess | null = null
  let client: OpencodeClient
  let supabase: SupabaseClient
  let sessionId: string
  let testReplyId: string

  before(async () => {
    if (!RUN_E2E) {
      console.log("Skipping E2E test (set OPENCODE_E2E=1 to run)")
      return
    }

    console.log("\n=== Setup ===\n")

    // Clean and create test directory
    await rm(testDir, { recursive: true, force: true })
    await mkdir(testDir, { recursive: true })

    // The test relies on the GLOBAL TTS plugin at ~/.config/opencode/plugin/tts.ts
    // This is intentional - we want to test the actual deployed plugin, not a copy
    // The global plugin uses ~/.config/opencode/tts.json for config
    
    // Verify global plugin exists
    const globalPluginPath = join(process.env.HOME!, ".config", "opencode", "plugin", "tts.ts")
    const globalConfigPath = join(process.env.HOME!, ".config", "opencode", "tts.json")
    
    try {
      await readFile(globalPluginPath)
      console.log("Global TTS plugin found")
    } catch {
      throw new Error("Global TTS plugin not found at ~/.config/opencode/plugin/tts.ts. Run: npm run install:global")
    }
    
    try {
      const configContent = await readFile(globalConfigPath, "utf-8")
      const config = JSON.parse(configContent)
      if (!config.telegram?.receiveReplies) {
        console.warn("Warning: telegram.receiveReplies is not enabled in global config")
      }
      console.log(`Global TTS config: telegram.enabled=${config.telegram?.enabled}, receiveReplies=${config.telegram?.receiveReplies}`)
    } catch (e) {
      console.warn("Could not read global TTS config - test may fail if not configured")
    }

    // Create opencode.json in test directory (model config only)
    const opencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      model: MODEL
    }
    await writeFile(
      join(testDir, "opencode.json"),
      JSON.stringify(opencodeConfig, null, 2)
    )

    console.log("Test directory configured:")
    console.log(`  - Using global plugin from: ${globalPluginPath}`)
    console.log(`  - Model: ${MODEL}`)

    // Initialize Supabase client
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Start OpenCode server
    console.log("\nStarting OpenCode server...")
    server = spawn("opencode", ["serve", "--port", String(PORT)], {
      cwd: testDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    server.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.log(`[server] ${line}`)
    })
    server.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.error(`[server:err] ${line}`)
    })

    // Wait for server
    const ready = await waitForServer(PORT, 30_000)
    if (!ready) {
      throw new Error("OpenCode server failed to start")
    }

    // Create client
    client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
      directory: testDir
    })

    console.log("Server ready\n")
  })

  after(async () => {
    console.log("\n=== Cleanup ===")

    // Clean up test reply from database
    if (testReplyId && supabase) {
      console.log(`Cleaning up test reply: ${testReplyId}`)
      await supabase.from("telegram_replies").delete().eq("id", testReplyId)
    }

    // Kill server
    if (server) {
      server.kill("SIGTERM")
      await new Promise((r) => setTimeout(r, 2000))
    }
  })

  it("should forward Telegram reply to session", async function () {
    if (!RUN_E2E) {
      skip("E2E tests disabled")
      return
    }

    console.log("\n=== Test: Reply Forwarding ===\n")

    // 1. Create a session
    const { data: session } = await client.session.create({})
    assert.ok(session?.id, "Failed to create session")
    sessionId = session.id
    console.log(`Session created: ${sessionId}`)

    // 2. Send an initial task (to make session active)
    // Using promptAsync to avoid blocking
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: "Hello, please wait for my next message."
          }
        ]
      }
    })

    // Wait a bit for the session to become active
    console.log("Waiting for session to stabilize...")
    await new Promise((r) => setTimeout(r, 5000))

    // 3. Insert a reply directly into the database
    // This simulates what the telegram-webhook does
    testReplyId = randomUUID()
    const testReplyText = `E2E Test Reply ${Date.now()}`
    const testMessageId = Math.floor(Math.random() * 1000000)

    console.log(`Inserting test reply: "${testReplyText}"`)

    const { error: insertError } = await supabase.from("telegram_replies").insert({
      id: testReplyId,
      uuid: TEST_UUID,
      session_id: sessionId,
      reply_text: testReplyText,
      telegram_chat_id: TEST_CHAT_ID,
      telegram_message_id: testMessageId,
      processed: false,
      is_voice: false
    })

    if (insertError) {
      console.error("Insert error:", insertError)
      throw new Error(`Failed to insert test reply: ${insertError.message}`)
    }

    console.log(`Reply inserted: ${testReplyId}`)

    // 4. Wait for the reply to appear in the session
    console.log("Waiting for reply to appear in session...")

    const result = await waitForMessage(
      client,
      sessionId,
      testReplyText,
      30_000 // 30 second timeout
    )

    // Debug: print all messages if not found
    if (!result.found) {
      console.log("\nSession messages:")
      for (const msg of result.allMessages || []) {
        const role = msg.info?.role || "unknown"
        for (const part of msg.parts || []) {
          if (part.type === "text") {
            console.log(`  [${role}] ${part.text?.slice(0, 100)}...`)
          }
        }
      }

      // Check if reply was marked as processed
      const { data: reply } = await supabase
        .from("telegram_replies")
        .select("processed, processed_at")
        .eq("id", testReplyId)
        .single()

      console.log(`\nReply state: processed=${reply?.processed}, processed_at=${reply?.processed_at}`)
    }

    assert.ok(
      result.found,
      `Reply "${testReplyText}" not found in session messages after 30s`
    )

    console.log("Reply found in session!")

    // Verify the message has the correct format
    const messageText = result.message?.parts?.find((p: any) => p.type === "text")?.text
    assert.ok(
      messageText?.includes("[User via Telegram]"),
      "Reply should have Telegram prefix"
    )

    console.log("Reply format verified")
  })

  it("should mark reply as processed after forwarding", async function () {
    if (!RUN_E2E) {
      skip("E2E tests disabled")
      return
    }

    // This test depends on the previous test inserting a reply
    if (!testReplyId) {
      skip("No test reply created")
      return
    }

    console.log("\n=== Test: Reply Processed Flag ===\n")

    // Check if the reply was marked as processed
    const { data: reply, error } = await supabase
      .from("telegram_replies")
      .select("processed, processed_at")
      .eq("id", testReplyId)
      .single()

    if (error) {
      throw new Error(`Failed to query reply: ${error.message}`)
    }

    console.log(`Reply processed: ${reply?.processed}`)
    console.log(`Processed at: ${reply?.processed_at}`)

    assert.ok(reply?.processed, "Reply should be marked as processed")
    assert.ok(reply?.processed_at, "Reply should have processed_at timestamp")
  })

  it("should not process already-processed replies", async function () {
    if (!RUN_E2E) {
      skip("E2E tests disabled")
      return
    }

    if (!sessionId) {
      skip("No session created")
      return
    }

    console.log("\n=== Test: Deduplication ===\n")

    // Insert a reply that's already marked as processed
    const dupReplyId = randomUUID()
    const dupReplyText = `Duplicate Test ${Date.now()}`

    const { error: insertError } = await supabase.from("telegram_replies").insert({
      id: dupReplyId,
      uuid: TEST_UUID,
      session_id: sessionId,
      reply_text: dupReplyText,
      telegram_chat_id: TEST_CHAT_ID,
      telegram_message_id: Math.floor(Math.random() * 1000000),
      processed: true, // Already processed
      processed_at: new Date().toISOString(),
      is_voice: false
    })

    if (insertError) {
      throw new Error(`Failed to insert duplicate reply: ${insertError.message}`)
    }

    console.log(`Inserted already-processed reply: ${dupReplyId}`)

    // Wait a bit
    await new Promise((r) => setTimeout(r, 3000))

    // Verify it doesn't appear in session
    const result = await waitForMessage(client, sessionId, dupReplyText, 5000)

    assert.ok(
      !result.found,
      "Already-processed reply should NOT appear in session"
    )

    console.log("Deduplication verified - processed reply was skipped")

    // Clean up
    await supabase.from("telegram_replies").delete().eq("id", dupReplyId)
  })

  it("should forward reply via webhook simulation (full flow)", async function () {
    if (!RUN_E2E) {
      skip("E2E tests disabled")
      return
    }

    if (!sessionId) {
      skip("No session created")
      return
    }

    console.log("\n=== Test: Webhook Simulation (Full Flow) ===\n")

    // This tests the complete path:
    // 1. Create a reply context (like send-notify does)
    // 2. Send a simulated webhook request (like Telegram does)
    // 3. Verify the reply appears in the session

    // Step 1: Create a reply context
    const contextId = randomUUID()
    const fakeNotificationMessageId = Math.floor(Math.random() * 1000000)

    console.log("Creating reply context...")
    const { error: contextError } = await supabase.from("telegram_reply_contexts").insert({
      id: contextId,
      uuid: TEST_UUID,
      session_id: sessionId,
      message_id: fakeNotificationMessageId,
      chat_id: TEST_CHAT_ID,
      is_active: true
    })

    if (contextError) {
      throw new Error(`Failed to create reply context: ${contextError.message}`)
    }

    console.log(`Reply context created: ${contextId}`)

    // Step 2: Send a simulated webhook request (like Telegram would)
    const webhookMessageId = Math.floor(Math.random() * 1000000)
    const webhookReplyText = `Webhook Test ${Date.now()}`

    console.log(`Sending webhook with reply: "${webhookReplyText}"`)

    const webhookPayload = {
      update_id: webhookMessageId,
      message: {
        message_id: webhookMessageId,
        from: {
          id: TEST_CHAT_ID,
          is_bot: false,
          first_name: "E2E Test"
        },
        chat: {
          id: TEST_CHAT_ID,
          type: "private"
        },
        date: Math.floor(Date.now() / 1000),
        text: webhookReplyText,
        reply_to_message: {
          message_id: fakeNotificationMessageId,
          from: { id: 0, is_bot: true, first_name: "Bot" },
          chat: { id: TEST_CHAT_ID, type: "private" },
          date: Math.floor(Date.now() / 1000) - 60,
          text: "Original notification"
        }
      }
    }

    const webhookResponse = await fetch(
      "https://slqxwymujuoipyiqscrl.supabase.co/functions/v1/telegram-webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload)
      }
    )

    assert.ok(webhookResponse.ok, `Webhook failed: ${webhookResponse.status}`)
    console.log(`Webhook response: ${webhookResponse.status}`)

    // Step 3: Wait for reply to appear in session
    console.log("Waiting for reply to appear in session...")

    const result = await waitForMessage(client, sessionId, webhookReplyText, 30_000)

    // Debug if not found
    if (!result.found) {
      console.log("\nSession messages:")
      for (const msg of result.allMessages || []) {
        const role = msg.info?.role || "unknown"
        for (const part of msg.parts || []) {
          if (part.type === "text") {
            console.log(`  [${role}] ${part.text?.slice(0, 100)}...`)
          }
        }
      }

      // Check if reply was stored and processed
      const { data: replies } = await supabase
        .from("telegram_replies")
        .select("id, processed, processed_at, reply_text")
        .eq("telegram_message_id", webhookMessageId)
        .limit(1)

      console.log("\nReply in database:", replies?.[0])
    }

    // Clean up context
    await supabase.from("telegram_reply_contexts").delete().eq("id", contextId)

    assert.ok(
      result.found,
      `Webhook reply "${webhookReplyText}" not found in session`
    )

    console.log("Full webhook flow verified!")

    // Verify prefix
    const messageText = result.message?.parts?.find((p: any) => p.type === "text")?.text
    assert.ok(
      messageText?.includes("[User via Telegram]"),
      "Reply should have Telegram prefix"
    )

    console.log("Webhook simulation test passed")
  })
})
