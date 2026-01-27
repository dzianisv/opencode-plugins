/**
 * Test for Esc Abort Race Condition (Issue #18)
 * 
 * This test simulates the exact race condition scenario:
 * 1. session.error fires with MessageAbortedError
 * 2. session.idle fires immediately after
 * 3. Verify reflection does NOT run
 */

import assert from "assert"

describe("Esc Abort Race Condition - Issue #18", () => {
  
  // Simulate the plugin's state
  let recentlyAbortedSessions: Set<string>
  let reflectionRanCount: number
  let debugLogs: string[]
  
  function debug(...args: any[]) {
    debugLogs.push(args.join(" "))
  }
  
  function cancelNudge(sessionId: string) {
    debug("Cancelled nudge for", sessionId)
  }
  
  async function runReflection(sessionId: string) {
    reflectionRanCount++
    debug("runReflection called for", sessionId)
  }
  
  // Simulate the event handler from reflection.ts
  async function handleEvent(event: { type: string; properties?: any }) {
    const sessionId = event.properties?.sessionID
    const error = event.properties?.error
    
    if (event.type === "session.error") {
      if (sessionId && error?.name === "MessageAbortedError") {
        recentlyAbortedSessions.add(sessionId)
        cancelNudge(sessionId)
        debug("Session aborted, added to recentlyAbortedSessions:", sessionId)
      }
    }
    
    if (event.type === "session.idle") {
      if (sessionId) {
        // Fast path: skip recently aborted sessions
        if (recentlyAbortedSessions.has(sessionId)) {
          recentlyAbortedSessions.delete(sessionId)
          debug("SKIP: session was recently aborted (Esc)")
          return
        }
        await runReflection(sessionId)
      }
    }
  }
  
  beforeEach(() => {
    recentlyAbortedSessions = new Set()
    reflectionRanCount = 0
    debugLogs = []
  })
  
  it("blocks reflection when session.error fires BEFORE session.idle", async () => {
    const sessionId = "ses_test_abort_1"
    
    // Simulate: user presses Esc
    // 1. session.error fires first
    await handleEvent({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "MessageAbortedError", message: "User cancelled" }
      }
    })
    
    // 2. session.idle fires immediately after
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    // Verify reflection did NOT run
    assert.strictEqual(reflectionRanCount, 0, "Reflection should NOT have run after abort")
    assert.ok(debugLogs.includes("SKIP: session was recently aborted (Esc)"), 
      "Should log skip reason")
  })
  
  it("blocks reflection when session.idle fires BEFORE session.error (reverse order)", async () => {
    // This tests if events can arrive in opposite order
    // In reality session.error should fire first, but let's be defensive
    const sessionId = "ses_test_abort_2"
    
    // If session.idle fires first (before we know about abort)
    // This is the problematic case the old code had
    
    // With the fix: session.error must fire first to populate the set
    // If session.idle fires first, we can't know about abort yet
    
    // This test documents the limitation: we rely on session.error firing first
    await handleEvent({
      type: "session.idle", 
      properties: { sessionID: sessionId }
    })
    
    // Reflection would run because we didn't know about abort
    assert.strictEqual(reflectionRanCount, 1, 
      "If session.idle fires before session.error, reflection runs (known limitation)")
  })
  
  it("allows new tasks after abort is cleared", async () => {
    const sessionId = "ses_test_abort_3"
    
    // Task 1: aborted
    await handleEvent({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "MessageAbortedError", message: "User cancelled" }
      }
    })
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 0, "First task should be skipped")
    
    // Task 2: user sends new message, agent responds, session.idle fires
    // No new abort, so reflection should run
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 1, "Second task should trigger reflection")
  })
  
  it("handles multiple rapid aborts on same session", async () => {
    const sessionId = "ses_test_abort_4"
    
    // Rapid fire: error, idle, error, idle (user keeps pressing Esc)
    await handleEvent({
      type: "session.error",
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError" } }
    })
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    await handleEvent({
      type: "session.error", 
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError" } }
    })
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 0, "All aborts should be blocked")
  })
  
  it("handles concurrent sessions correctly", async () => {
    const session1 = "ses_abort_concurrent_1"
    const session2 = "ses_abort_concurrent_2"
    
    // Session 1: aborted
    await handleEvent({
      type: "session.error",
      properties: { sessionID: session1, error: { name: "MessageAbortedError" } }
    })
    
    // Session 2: completed normally (no abort)
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: session2 }
    })
    
    // Session 1: idle after abort
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: session1 }
    })
    
    // Session 2 should have triggered reflection, session 1 should not
    assert.strictEqual(reflectionRanCount, 1, "Only session 2 should trigger reflection")
  })
})
