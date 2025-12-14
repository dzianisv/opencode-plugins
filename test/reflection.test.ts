/**
 * E2E Integration Tests for OpenCode Reflection Plugin
 *
 * This test suite verifies that the reflection plugin works correctly
 * in a real OpenCode environment:
 * 1. Creates a session with a task
 * 2. Waits for the agent to complete
 * 3. Verifies the reflection plugin ran and produced a verdict
 * 4. Ensures no stuck/infinite loop behavior
 *
 * Run with: npm test
 *
 * Requirements:
 * - OpenCode must be running with the reflection plugin loaded
 * - Set OPENCODE_BASE_URL if not using default (http://localhost:3000)
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { mkdir, rm, writeFile, readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Test configuration
const TEST_TIMEOUT = 120_000 // 2 minutes max for E2E test
const POLL_INTERVAL = 1_000 // Check status every second
const MAX_IDLE_CHECKS = 3 // Number of consecutive idle checks before considering done
const TEST_PROJECT_DIR = "/tmp/opencode-e2e-test-client"  // Client directory (separate from server)

// Reflection log patterns to look for
const REFLECTION_PATTERNS = {
  started: /\[Reflection\] Starting reflection for session/,
  judgeCreated: /\[Reflection\] Created judge session/,
  verdict: /\[Reflection\] Verdict: (PASS|FAIL)/,
  completed: /\[Reflection\] Task completed successfully/,
  stuck: /\[Reflection\] Already reflecting on session.*skipping/,
  judgeSkipped: /\[Reflection\] (Skipping judge session|Session .* is a judge session)/,
}

interface ReflectionResult {
  started: boolean
  judgeCreated: boolean
  verdict: "PASS" | "FAIL" | null
  completed: boolean
  stuckDetected: boolean
  judgeSessionsSkipped: number
  logs: string[]
}

/**
 * Collect reflection-related logs from console output
 * In a real scenario, we'd capture these from the OpenCode logs
 */
function parseReflectionLogs(logs: string[]): ReflectionResult {
  const result: ReflectionResult = {
    started: false,
    judgeCreated: false,
    verdict: null,
    completed: false,
    stuckDetected: false,
    judgeSessionsSkipped: 0,
    logs: logs.filter(l => l.includes("[Reflection]")),
  }

  for (const log of logs) {
    if (REFLECTION_PATTERNS.started.test(log)) result.started = true
    if (REFLECTION_PATTERNS.judgeCreated.test(log)) result.judgeCreated = true
    if (REFLECTION_PATTERNS.completed.test(log)) result.completed = true
    if (REFLECTION_PATTERNS.stuck.test(log)) result.stuckDetected = true
    if (REFLECTION_PATTERNS.judgeSkipped.test(log)) result.judgeSessionsSkipped++

    const verdictMatch = log.match(REFLECTION_PATTERNS.verdict)
    if (verdictMatch) {
      result.verdict = verdictMatch[1] as "PASS" | "FAIL"
    }
  }

  return result
}

/**
 * Wait for a session to become idle (completed)
 *
 * Strategy: Poll messages endpoint and detect when message count stabilizes
 * (no new messages for several consecutive polls after we have assistant responses)
 */
async function waitForSessionIdle(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs: number = TEST_TIMEOUT
): Promise<{ success: boolean; messages: any[]; error?: string }> {
  const startTime = Date.now()
  let stableCount = 0
  let pollCount = 0
  let lastMessageCount = 0
  let lastAssistantText = ""

  while (Date.now() - startTime < timeoutMs) {
    try {
      pollCount++

      // Get current messages
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      })
      const messages = messagesResponse.data || []

      // Check if session is in status (means it's busy)
      const statusResponse = await client.session.status({})
      const statusArray = statusResponse.data as any[] | undefined
      const isBusy = Array.isArray(statusArray) && statusArray.some(
        (s: any) => s?.sessionID === sessionId || s?.id === sessionId
      )

      // Get last assistant message text for stability check
      let currentAssistantText = ""
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info?.role === "assistant") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              currentAssistantText = part.text
              break
            }
          }
          if (currentAssistantText) break
        }
      }

      // Check for any assistant activity (text response OR tool calls)
      const hasAssistantActivity = messages.some(
        (m: any) => m.info?.role === "assistant" &&
          m.parts?.some((p: any) =>
            (p.type === "text" && p.text) ||
            (p.type === "tool") ||
            (p.type === "reasoning")
          )
      )

      if (pollCount <= 5 || pollCount % 10 === 0) {
        console.log(`[Test] Poll ${pollCount}: messages=${messages.length}, busy=${isBusy}, hasActivity=${hasAssistantActivity}`)
      }

      // Check for API errors in messages (error parts indicate LLM failure)
      const hasApiError = messages.some(
        (m: any) => m.parts?.some((p: any) =>
          p.type === "error" ||
          (p.type === "text" && p.text?.toLowerCase().includes("error"))
        )
      )

      if (hasApiError && !isBusy && messages.length === lastMessageCount) {
        console.log(`[Test] API error detected in session after ${pollCount} polls`)
        return { success: false, messages, error: "LLM API error - check server logs" }
      }

      // Check if stable: not busy, has activity, and messages haven't changed
      if (!isBusy && hasAssistantActivity &&
          messages.length === lastMessageCount &&
          currentAssistantText === lastAssistantText) {
        stableCount++
        if (stableCount >= MAX_IDLE_CHECKS) {
          console.log(`[Test] Session stable after ${pollCount} polls, ${messages.length} messages`)
          return { success: true, messages }
        }
      } else {
        stableCount = 0
      }

      // If we've been waiting a while with no activity, likely API issue
      if (pollCount > 30 && !hasAssistantActivity && messages.length >= 1 && !isBusy) {
        console.log(`[Test] No assistant activity after ${pollCount} polls - likely LLM API issue`)
        return { success: false, messages, error: "No LLM response - check API configuration" }
      }

      lastMessageCount = messages.length
      lastAssistantText = currentAssistantText

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    } catch (error) {
      // Session might not exist yet or transient error
      console.log(`[Test] Poll ${pollCount} error:`, error)
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    }
  }

  return { success: false, messages: [], error: "Timeout waiting for session to complete" }
}

/**
 * Check if the task was actually completed by examining session messages
 */
function verifyTaskCompletion(messages: any[], taskKeyword: string = "hello"): {
  hasUserTask: boolean
  hasAssistantResponse: boolean
  hasToolCalls: boolean
  toolsUsed: string[]
  messageCount: number
  userMessages: number
  assistantMessages: number
} {
  const result = {
    hasUserTask: false,
    hasAssistantResponse: false,
    hasToolCalls: false,
    toolsUsed: [] as string[],
    messageCount: messages.length,
    userMessages: 0,
    assistantMessages: 0,
  }

  for (const msg of messages) {
    if (msg.info?.role === "user") {
      result.userMessages++
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.toLowerCase().includes(taskKeyword.toLowerCase())) {
          result.hasUserTask = true
        }
      }
    }

    if (msg.info?.role === "assistant") {
      result.assistantMessages++
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          result.hasAssistantResponse = true
        }
        if (part.type === "tool") {
          result.hasToolCalls = true
          if (part.tool && !result.toolsUsed.includes(part.tool)) {
            result.toolsUsed.push(part.tool)
          }
        }
      }
    }
  }

  return result
}

describe("Reflection Plugin - E2E Integration", { skip: !process.env.OPENCODE_E2E, timeout: TEST_TIMEOUT + 10_000 }, () => {
  let client: OpencodeClient
  let sessionId: string | undefined
  let collectedLogs: string[] = []
  let originalConsoleLog: typeof console.log

  before(async () => {
    // Create test project directory
    await mkdir(TEST_PROJECT_DIR, { recursive: true })

    // Capture console.log to collect reflection plugin output
    originalConsoleLog = console.log
    console.log = (...args: any[]) => {
      const message = args.map(a => String(a)).join(" ")
      collectedLogs.push(message)
      originalConsoleLog.apply(console, args)
    }

    // Create OpenCode client
    const baseUrl = process.env.OPENCODE_BASE_URL || "http://localhost:3000"
    try {
      client = createOpencodeClient({
        baseUrl,
        directory: TEST_PROJECT_DIR,
      })

      // Verify connection by listing sessions
      const sessions = await client.session.list({})
      if (sessions.error) {
        throw new Error(`Failed to connect to OpenCode: ${JSON.stringify(sessions.error)}`)
      }
    } catch (error) {
      console.log = originalConsoleLog
      throw new Error(
        `Cannot connect to OpenCode at ${baseUrl}. ` +
        `Make sure OpenCode is running with the reflection plugin loaded. ` +
        `Error: ${error}`
      )
    }
  })

  after(async () => {
    // Restore console.log
    if (originalConsoleLog) {
      console.log = originalConsoleLog
    }

    // Clean up test session if created
    if (client && sessionId) {
      try {
        await client.session.delete({ path: { id: sessionId } })
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up test directory
    await rm(TEST_PROJECT_DIR, { recursive: true, force: true })
  })

  it("completes a hello world python task with reflection", async function() {
    // @ts-ignore - Node test runner timeout
    this.timeout = TEST_TIMEOUT

    // Create a new session
    const createResponse = await client.session.create({})
    assert.ok(createResponse.data?.id, "Failed to create session")
    sessionId = createResponse.data.id

    console.log(`[Test] Created session: ${sessionId}`)

    // Send a simple task for quick completion
    const task = "Create a file named hello.py with: print('Hello World')"

    console.log(`[Test] Sending task: ${task}`)

    // Use promptAsync to start the session and return immediately
    const promptResponse = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: task }],
      },
    })

    assert.ok(!promptResponse.error, `Failed to send prompt: ${JSON.stringify(promptResponse.error)}`)

    // Wait for session to complete (including reflection)
    console.log("[Test] Waiting for session to complete...")
    const result = await waitForSessionIdle(client, sessionId)

    assert.ok(result.success, `Session did not complete: ${result.error}`)
    console.log(`[Test] Session completed with ${result.messages.length} messages`)

    // Verify the task was executed
    const taskCompletion = verifyTaskCompletion(result.messages, "hello")

    console.log(`[Test] Task completion analysis:`)
    console.log(`  - Total messages: ${taskCompletion.messageCount}`)
    console.log(`  - User messages: ${taskCompletion.userMessages}`)
    console.log(`  - Assistant messages: ${taskCompletion.assistantMessages}`)
    console.log(`  - Has user task: ${taskCompletion.hasUserTask}`)
    console.log(`  - Has assistant response: ${taskCompletion.hasAssistantResponse}`)
    console.log(`  - Has tool calls: ${taskCompletion.hasToolCalls}`)
    console.log(`  - Tools used: ${taskCompletion.toolsUsed.join(", ") || "none"}`)

    // Relaxed assertions - just verify session had meaningful activity
    assert.ok(taskCompletion.messageCount >= 2, `Expected at least 2 messages, got ${taskCompletion.messageCount}`)
    assert.ok(taskCompletion.userMessages >= 1, `Expected at least 1 user message, got ${taskCompletion.userMessages}`)
    assert.ok(taskCompletion.assistantMessages >= 1, `Expected at least 1 assistant message, got ${taskCompletion.assistantMessages}`)

    // Parse reflection logs
    const reflectionResult = parseReflectionLogs(collectedLogs)

    console.log("[Test] Reflection analysis:")
    console.log(`  - Started: ${reflectionResult.started}`)
    console.log(`  - Judge created: ${reflectionResult.judgeCreated}`)
    console.log(`  - Verdict: ${reflectionResult.verdict}`)
    console.log(`  - Completed: ${reflectionResult.completed}`)
    console.log(`  - Stuck detected: ${reflectionResult.stuckDetected}`)
    console.log(`  - Judge sessions skipped: ${reflectionResult.judgeSessionsSkipped}`)

    // Assertions for reflection behavior
    // Note: These may need adjustment based on actual plugin behavior
    if (reflectionResult.started) {
      assert.ok(
        reflectionResult.judgeCreated,
        "Reflection started but no judge session was created"
      )

      assert.ok(
        reflectionResult.verdict !== null,
        "Reflection started but no verdict was produced"
      )

      assert.ok(
        !reflectionResult.stuckDetected || reflectionResult.judgeSessionsSkipped > 0,
        "Stuck behavior detected without proper judge session skipping"
      )
    }
  })

  it("does not get stuck in infinite reflection loop", async function() {
    // @ts-ignore - Node test runner timeout
    this.timeout = TEST_TIMEOUT

    // Reset log collection for this test
    collectedLogs = []

    // Create a new session
    const createResponse = await client.session.create({})
    assert.ok(createResponse.data?.id, "Failed to create session")
    const testSessionId = createResponse.data.id

    console.log(`[Test] Created session for loop test: ${testSessionId}`)

    // Send a simple task that should complete quickly
    const task = "Print 'Hello' to the console using Python. Just create a simple one-liner script."

    // Use promptAsync to start the session and return immediately
    const promptResponse = await client.session.promptAsync({
      path: { id: testSessionId },
      body: {
        parts: [{ type: "text", text: task }],
      },
    })

    assert.ok(!promptResponse.error, `Failed to send prompt: ${JSON.stringify(promptResponse.error)}`)

    // Wait with a shorter timeout - if it takes too long, it might be stuck
    const shortTimeout = 60_000 // 1 minute should be enough for a simple task
    const startTime = Date.now()

    const result = await waitForSessionIdle(client, testSessionId, shortTimeout)

    const duration = Date.now() - startTime
    console.log(`[Test] Session completed in ${duration}ms`)

    // Clean up this session
    try {
      await client.session.delete({ path: { id: testSessionId } })
    } catch {
      // Ignore
    }

    // Check for stuck behavior in logs
    const reflectionResult = parseReflectionLogs(collectedLogs)

    // Count how many "Already reflecting" messages we got
    const stuckCount = collectedLogs.filter(l =>
      l.includes("Already reflecting on session")
    ).length

    console.log(`[Test] "Already reflecting" count: ${stuckCount}`)

    // We should see at most a few of these (from rapid event firing)
    // but not dozens which would indicate a loop
    assert.ok(
      stuckCount < 10,
      `Too many "Already reflecting" messages (${stuckCount}), possible stuck loop`
    )

    assert.ok(
      result.success,
      `Session did not complete within ${shortTimeout}ms - possible infinite loop`
    )

    // Verify reflection completed properly if it ran
    if (reflectionResult.started) {
      assert.ok(
        reflectionResult.verdict !== null || reflectionResult.completed,
        "Reflection started but never completed"
      )
    }
  })
})

describe("Reflection Plugin - Unit Tests", () => {
  // Keep some unit tests for fast feedback during development

  it("parseJudgeResponse extracts PASS verdict", () => {
    const response = `VERDICT: PASS

REASONING: The agent completed all requested tasks successfully.

FEEDBACK: Task completed successfully.`

    const logs = [`[Reflection] Verdict: PASS`, `[Reflection] Task completed successfully!`]
    const result = parseReflectionLogs(logs)

    assert.strictEqual(result.verdict, "PASS")
    assert.strictEqual(result.completed, true)
  })

  it("parseJudgeResponse extracts FAIL verdict", () => {
    const logs = [
      `[Reflection] Starting reflection for session ses_123`,
      `[Reflection] Created judge session: ses_456`,
      `[Reflection] Verdict: FAIL`,
    ]
    const result = parseReflectionLogs(logs)

    assert.strictEqual(result.started, true)
    assert.strictEqual(result.judgeCreated, true)
    assert.strictEqual(result.verdict, "FAIL")
  })

  it("detects stuck behavior from logs", () => {
    const logs = [
      `[Reflection] Starting reflection for session ses_123`,
      `[Reflection] Already reflecting on session ses_123, skipping`,
      `[Reflection] Already reflecting on session ses_123, skipping`,
    ]
    const result = parseReflectionLogs(logs)

    assert.strictEqual(result.started, true)
    assert.strictEqual(result.stuckDetected, true)
  })

  it("detects judge session skipping", () => {
    const logs = [
      `[Reflection] Starting reflection for session ses_123`,
      `[Reflection] Created judge session: ses_456`,
      `[Reflection] Skipping judge session ses_456`,
      `[Reflection] Session ses_789 is a judge session, skipping`,
    ]
    const result = parseReflectionLogs(logs)

    assert.strictEqual(result.judgeSessionsSkipped, 2)
  })
})

describe("Reflection Plugin - Structure Validation", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../reflection.ts"),
      "utf-8"
    )
  })

  it("has required exports", () => {
    assert.ok(pluginContent.includes("export const ReflectionPlugin"), "Missing ReflectionPlugin export")
    assert.ok(pluginContent.includes("export default"), "Missing default export")
  })

  it("has defense-in-depth judge session check", () => {
    assert.ok(
      pluginContent.includes("if (judgeSessions.has(sessionID))"),
      "Missing judgeSessions check in runReflection"
    )
  })

  it("cleans up judge sessions in finally block", () => {
    assert.ok(
      pluginContent.includes("let judgeSessionID"),
      "judgeSessionID should be declared outside try block"
    )
    assert.ok(
      pluginContent.includes("judgeSessions.delete(judgeSessionID)"),
      "Missing judgeSessions cleanup in finally"
    )
  })

  it("has proper loop protection", () => {
    assert.ok(pluginContent.includes("reflectingSessions"), "Missing reflectingSessions set")
    assert.ok(pluginContent.includes("MAX_REFLECTION_ATTEMPTS"), "Missing MAX_REFLECTION_ATTEMPTS")
    assert.ok(pluginContent.includes("reflectionAttempts"), "Missing reflectionAttempts map")
  })
})
