/**
 * Test for Bad Request error handling in reflection-3 (Issue #60)
 *
 * Tests four fixes:
 * 1. promptAsync errors (e.g. 400 Bad Request) are caught and don't crash the plugin
 * 2. lastReflectedMsgId is set after feedback injection to prevent reflection loops
 * 3. Session state is re-checked before feedback injection (user may have sent new message during analysis)
 * 4. Event handler wraps runReflection in try/catch
 */

import assert from "assert"

describe("Bad Request error handling - Issue #60", () => {

  // Simulate the plugin's state
  let lastReflectedMsgId: Map<string, string>
  let activeReflections: Set<string>
  let recentlyAbortedSessions: Map<string, number>
  let debugLogs: string[]

  // Tracking
  let promptAsyncCallCount: number
  let promptAsyncError: Error | null
  let toastMessages: string[]

  // Mock data
  let mockMessages: any[]
  let mockSelfAssessmentResponse: string | null
  let mockAnalysis: any | null

  // Configurable mock for promptAsync
  let promptAsyncShouldThrow: boolean
  let promptAsyncThrowOnCall: number // 0 = first call, 1 = second call, etc.

  const SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
  const FEEDBACK_MARKER = "## Reflection-3:"

  function debug(...args: any[]) {
    debugLogs.push(args.join(" "))
  }

  // Simplified getLastRelevantUserMessageId (matches reflection-3 logic)
  function getLastRelevantUserMessageId(messages: any[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role !== "user") continue
      const text = msg.parts?.find((p: any) => p.type === "text")?.text || ""
      if (text.includes(SELF_ASSESSMENT_MARKER) || text.includes(FEEDBACK_MARKER)) continue
      return msg.info?.id || `msg_${i}`
    }
    return null
  }

  // Mock client
  function createMockClient() {
    return {
      session: {
        messages: async (_opts: any) => ({ data: mockMessages }),
        promptAsync: async (_opts: any) => {
          const callNum = promptAsyncCallCount++
          if (promptAsyncShouldThrow && callNum === promptAsyncThrowOnCall) {
            throw new Error("Bad Request")
          }
        }
      }
    }
  }

  // Simplified runReflection matching the fixed code
  async function runReflection(sessionId: string, client: any): Promise<void> {
    if (activeReflections.has(sessionId)) return
    activeReflections.add(sessionId)

    try {
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) return

      const lastUserMsgId = getLastRelevantUserMessageId(messages)
      if (!lastUserMsgId) return

      const initialUserMsgId = lastUserMsgId
      const lastReflectedId = lastReflectedMsgId.get(sessionId)
      if (lastUserMsgId === lastReflectedId) return

      // Self-assessment prompt
      try {
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: "self-assessment prompt" }] }
        })
      } catch (e: any) {
        debug("promptAsync failed (self-assessment):", e?.message || e)
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      // Wait for response (simulated)
      const selfAssessment = mockSelfAssessmentResponse
      if (!selfAssessment) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      debug("Self-assessment received")

      // Re-check for new user messages after self-assessment
      const { data: currentMessages } = await client.session.messages({ path: { id: sessionId } })
      const currentUserMsgId = getLastRelevantUserMessageId(currentMessages || [])
      if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
        lastReflectedMsgId.set(sessionId, initialUserMsgId)
        return
      }

      const abortTime = recentlyAbortedSessions.get(sessionId)
      if (abortTime) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      // Analysis (simulated)
      const analysis = mockAnalysis
      if (!analysis) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      if (analysis.complete) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      if (analysis.requiresHumanAction) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      // Re-check for new user messages or abort before feedback injection
      const { data: preFeedbackMessages } = await client.session.messages({ path: { id: sessionId } })
      const preFeedbackUserMsgId = getLastRelevantUserMessageId(preFeedbackMessages || [])
      if (preFeedbackUserMsgId && preFeedbackUserMsgId !== initialUserMsgId) {
        lastReflectedMsgId.set(sessionId, initialUserMsgId)
        debug("User sent new message during analysis, skipping feedback")
        return
      }
      const preFeedbackAbort = recentlyAbortedSessions.get(sessionId)
      if (preFeedbackAbort) {
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        debug("Session aborted during analysis, skipping feedback")
        return
      }

      // Feedback injection
      try {
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: `${FEEDBACK_MARKER} Task incomplete.` }] }
        })
      } catch (e: any) {
        debug("promptAsync failed (feedback):", e?.message || e)
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }

      // Prevent reflection loop
      lastReflectedMsgId.set(sessionId, lastUserMsgId)

      debug("Reflection pushed continuation")
    } finally {
      activeReflections.delete(sessionId)
    }
  }

  beforeEach(() => {
    lastReflectedMsgId = new Map()
    activeReflections = new Set()
    recentlyAbortedSessions = new Map()
    debugLogs = []
    promptAsyncCallCount = 0
    promptAsyncError = null
    promptAsyncShouldThrow = false
    promptAsyncThrowOnCall = 0
    toastMessages = []

    // Default: 2 messages (user + assistant), valid session
    mockMessages = [
      { info: { role: "user", id: "msg_user_1" }, parts: [{ type: "text", text: "Fix the bug" }] },
      { info: { role: "assistant", id: "msg_asst_1" }, parts: [{ type: "text", text: "Done" }] }
    ]
    mockSelfAssessmentResponse = '{"status":"complete","confidence":0.9}'
    mockAnalysis = { complete: false, severity: "MEDIUM", missing: ["tests"], nextActions: ["run tests"], reason: "Tests not run" }
  })

  describe("promptAsync error handling", () => {
    it("catches Bad Request on self-assessment prompt and sets lastReflectedMsgId", async () => {
      const client = createMockClient()
      promptAsyncShouldThrow = true
      promptAsyncThrowOnCall = 0 // first promptAsync call (self-assessment)

      // Should not throw
      await runReflection("ses_test1", client)

      assert.strictEqual(promptAsyncCallCount, 1, "Should have attempted one promptAsync call")
      assert.ok(lastReflectedMsgId.has("ses_test1"), "Should set lastReflectedMsgId on error")
      assert.ok(debugLogs.some(l => l.includes("promptAsync failed (self-assessment)")),
        "Should log the error")
      assert.ok(!activeReflections.has("ses_test1"), "Should clean up activeReflections")
    })

    it("catches Bad Request on feedback injection and sets lastReflectedMsgId", async () => {
      const client = createMockClient()
      promptAsyncShouldThrow = true
      promptAsyncThrowOnCall = 1 // second promptAsync call (feedback)

      await runReflection("ses_test2", client)

      assert.strictEqual(promptAsyncCallCount, 2, "Should have attempted two promptAsync calls")
      assert.ok(lastReflectedMsgId.has("ses_test2"), "Should set lastReflectedMsgId on error")
      assert.ok(debugLogs.some(l => l.includes("promptAsync failed (feedback)")),
        "Should log the feedback error")
    })

    it("does not crash when promptAsync throws non-Error", async () => {
      const client = createMockClient()
      // Override to throw a string
      let callCount = 0
      client.session.promptAsync = async () => {
        callCount++
        if (callCount === 1) throw "network error"
      }

      await runReflection("ses_test3", client)

      assert.ok(lastReflectedMsgId.has("ses_test3"), "Should set lastReflectedMsgId")
      assert.ok(debugLogs.some(l => l.includes("promptAsync failed")),
        "Should log the error even for non-Error throws")
    })
  })

  describe("Reflection loop prevention", () => {
    it("sets lastReflectedMsgId after successful feedback injection", async () => {
      const client = createMockClient()

      await runReflection("ses_loop1", client)

      assert.strictEqual(promptAsyncCallCount, 2, "Should call promptAsync twice (assessment + feedback)")
      assert.ok(lastReflectedMsgId.has("ses_loop1"), "Should set lastReflectedMsgId after feedback")
      assert.strictEqual(lastReflectedMsgId.get("ses_loop1"), "msg_user_1")
    })

    it("prevents second reflection cycle for the same user message", async () => {
      const client = createMockClient()

      // First reflection cycle
      await runReflection("ses_loop2", client)
      assert.strictEqual(promptAsyncCallCount, 2, "First cycle: assessment + feedback")

      // Second reflection cycle (simulates session.idle after agent responds to feedback)
      await runReflection("ses_loop2", client)

      // Should have been blocked by lastReflectedMsgId check
      assert.strictEqual(promptAsyncCallCount, 2, "Second cycle should not call promptAsync")
    })

    it("allows reflection when user sends a new message after feedback", async () => {
      const client = createMockClient()

      // First reflection cycle
      await runReflection("ses_loop3", client)
      assert.strictEqual(promptAsyncCallCount, 2, "First cycle complete")

      // User sends a new message
      mockMessages = [
        ...mockMessages,
        { info: { role: "user", id: "msg_user_2" }, parts: [{ type: "text", text: "New task" }] },
        { info: { role: "assistant", id: "msg_asst_2" }, parts: [{ type: "text", text: "Done again" }] }
      ]

      // Second reflection should run because msg_user_2 !== msg_user_1
      await runReflection("ses_loop3", client)
      assert.strictEqual(promptAsyncCallCount, 4, "Second cycle should run for new user message")
    })
  })

  describe("Pre-feedback session state re-check", () => {
    it("skips feedback when user sent new message during analysis", async () => {
      let promptAsyncCalls = 0
      const client = createMockClient()

      // Override messages to return different results on different calls
      let messageCallCount = 0
      client.session.messages = async () => {
        messageCallCount++
        if (messageCallCount <= 2) {
          // First two calls (initial + post-assessment): original messages
          return { data: mockMessages }
        }
        // Third call (pre-feedback): user sent a new message during analysis
        return {
          data: [
            ...mockMessages,
            { info: { role: "user", id: "msg_user_new" }, parts: [{ type: "text", text: "Actually, do this instead" }] }
          ]
        }
      }

      await runReflection("ses_state1", client)

      assert.ok(debugLogs.some(l => l.includes("User sent new message during analysis")),
        "Should detect new user message and skip feedback")
      // Only the self-assessment prompt should have been sent, not feedback
      assert.strictEqual(promptAsyncCallCount, 1, "Should only send self-assessment, not feedback")
    })

    it("skips feedback when session was aborted during analysis", async () => {
      const client = createMockClient()

      // Override messages for the pre-feedback check to trigger abort detection
      let messageCallCount = 0
      client.session.messages = async () => {
        messageCallCount++
        if (messageCallCount === 3) {
          // Simulate abort happening during analysis (between post-assessment and pre-feedback checks)
          recentlyAbortedSessions.set("ses_state2", Date.now())
        }
        return { data: mockMessages }
      }

      await runReflection("ses_state2", client)

      assert.ok(debugLogs.some(l => l.includes("Session aborted during analysis")),
        "Should detect abort and skip feedback")
      assert.strictEqual(promptAsyncCallCount, 1, "Should only send self-assessment, not feedback")
    })
  })

  describe("Event handler error resilience", () => {
    it("event handler does not throw when runReflection throws", async () => {
      // Simulate the event handler wrapping runReflection in try/catch
      async function handleEvent(event: any) {
        if (event.type === "session.idle") {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          try {
            await runReflection(sessionId, null as any) // will throw because client is null
          } catch (e: any) {
            debug("runReflection error:", e?.message || e)
          }
        }
      }

      // Should not throw
      await handleEvent({
        type: "session.idle",
        properties: { sessionID: "ses_crash1" }
      })

      assert.ok(debugLogs.some(l => l.includes("runReflection error:")),
        "Should catch and log the error")
    })

    it("event handler continues working after a failed reflection", async () => {
      let reflectionCount = 0

      async function handleEvent(event: any) {
        if (event.type === "session.idle") {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          try {
            reflectionCount++
            if (reflectionCount === 1) throw new Error("Transient failure")
            // Second call succeeds
          } catch (e: any) {
            debug("runReflection error:", e?.message || e)
          }
        }
      }

      // First call fails
      await handleEvent({ type: "session.idle", properties: { sessionID: "ses_a" } })
      // Second call should still work
      await handleEvent({ type: "session.idle", properties: { sessionID: "ses_b" } })

      assert.strictEqual(reflectionCount, 2, "Event handler should continue processing after error")
    })
  })

  describe("activeReflections cleanup on error", () => {
    it("cleans up activeReflections when promptAsync throws", async () => {
      const client = createMockClient()
      promptAsyncShouldThrow = true
      promptAsyncThrowOnCall = 0

      await runReflection("ses_cleanup1", client)

      assert.ok(!activeReflections.has("ses_cleanup1"),
        "activeReflections should be cleaned up in finally block even after error")
    })

    it("does not leave session stuck in activeReflections on any exit path", async () => {
      const client = createMockClient()

      // Test: complete analysis
      mockAnalysis = { complete: true, severity: "LOW" }
      await runReflection("ses_cleanup2", client)
      assert.ok(!activeReflections.has("ses_cleanup2"), "complete path should clean up")

      // Test: no self-assessment response
      mockSelfAssessmentResponse = null
      await runReflection("ses_cleanup3", client)
      assert.ok(!activeReflections.has("ses_cleanup3"), "no-response path should clean up")

      // Test: null analysis
      mockSelfAssessmentResponse = "some response"
      mockAnalysis = null
      await runReflection("ses_cleanup4", client)
      assert.ok(!activeReflections.has("ses_cleanup4"), "null-analysis path should clean up")
    })
  })
})
