/**
 * Test for Esc Abort Race Condition (Issue #18)
 * 
 * This test simulates the exact race condition scenario:
 * 1. session.error fires with MessageAbortedError
 * 2. session.idle fires immediately after
 * 3. Verify reflection does NOT run
 * 
 * Updated to test the cooldown-based approach (Map with timestamps)
 */

import assert from "assert"

describe("Esc Abort Race Condition - Issue #18", () => {
  
  // Simulate the plugin's state (now using Map with timestamps for cooldown)
  let recentlyAbortedSessions: Map<string, number>
  let reflectionRanCount: number
  let debugLogs: string[]
  const ABORT_COOLDOWN = 10_000  // Match the plugin's cooldown
  
  // Allow tests to mock Date.now()
  let mockNow: number
  
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
  
  // Simulate the event handler from reflection-3.ts (updated for Map + cooldown)
  async function handleEvent(event: { type: string; properties?: any }) {
    const sessionId = event.properties?.sessionID
    const error = event.properties?.error
    
    if (event.type === "session.error") {
      if (sessionId && error?.name === "MessageAbortedError") {
        recentlyAbortedSessions.set(sessionId, mockNow)
        cancelNudge(sessionId)
        debug("Session aborted, added to recentlyAbortedSessions:", sessionId)
      }
    }
    
    if (event.type === "session.idle") {
      if (sessionId) {
        // Fast path: skip recently aborted sessions (with cooldown)
        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          const elapsed = mockNow - abortTime
          if (elapsed < ABORT_COOLDOWN) {
            debug("SKIP: session was recently aborted (Esc)", elapsed, "ms ago")
            return  // Don't delete yet - cooldown still active
          }
          // Cooldown expired, clean up and allow reflection
          recentlyAbortedSessions.delete(sessionId)
          debug("Abort cooldown expired, allowing reflection")
        }
        await runReflection(sessionId)
      }
    }
  }
  
  beforeEach(() => {
    recentlyAbortedSessions = new Map()
    reflectionRanCount = 0
    debugLogs = []
    mockNow = Date.now()
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
    
    // 2. session.idle fires immediately after (same time)
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    // Verify reflection did NOT run
    assert.strictEqual(reflectionRanCount, 0, "Reflection should NOT have run after abort")
    assert.ok(debugLogs.some(log => log.includes("SKIP: session was recently aborted")), 
      "Should log skip reason")
  })
  
  it("event handler allows runReflection when session.idle fires BEFORE session.error", async () => {
    // This tests if events can arrive in opposite order.
    // The EVENT HANDLER can't catch this case (it has no message data).
    // However, runReflection() now checks time.completed on the last assistant
    // message (Issue #82), so the abort IS caught inside runReflection.
    // This test documents the event handler's limitation only.
    const sessionId = "ses_test_abort_2"
    
    await handleEvent({
      type: "session.idle", 
      properties: { sessionID: sessionId }
    })
    
    // Event handler calls runReflection because it doesn't know about abort yet.
    // In production, runReflection itself will detect the incomplete message
    // via the time.completed check (Issue #82 fix).
    assert.strictEqual(reflectionRanCount, 1, 
      "Event handler calls runReflection (abort caught inside runReflection via time.completed check)")
  })
  
  it("blocks reflection during cooldown period (multiple rapid Esc presses)", async () => {
    const sessionId = "ses_test_abort_cooldown"
    
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
    
    assert.strictEqual(reflectionRanCount, 0, "First idle should be skipped")
    
    // Simulate 5 seconds passing (still within 10s cooldown)
    mockNow += 5000
    
    // Another session.idle (e.g., from in-flight reflection feedback)
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 0, "Second idle within cooldown should also be skipped")
    assert.ok(debugLogs.some(log => log.includes("5000 ms ago")), 
      "Should log elapsed time")
  })
  
  it("allows reflection after cooldown expires", async () => {
    const sessionId = "ses_test_abort_expired"
    
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
    
    // Simulate 15 seconds passing (beyond 10s cooldown)
    mockNow += 15000
    
    // Task 2: user sends new message, agent responds, session.idle fires
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 1, "Should allow reflection after cooldown expires")
    assert.ok(debugLogs.some(log => log.includes("cooldown expired")), 
      "Should log cooldown expired")
  })
  
  it("handles multiple rapid aborts on same session (all within cooldown)", async () => {
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
    
    // 1 second later, another abort
    mockNow += 1000
    await handleEvent({
      type: "session.error", 
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError" } }
    })
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    // 1 second later, yet another abort
    mockNow += 1000
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
  
  it("each abort resets the cooldown timer", async () => {
    const sessionId = "ses_test_cooldown_reset"
    
    // First abort
    await handleEvent({
      type: "session.error",
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError" } }
    })
    
    // 8 seconds later (still within 10s cooldown)
    mockNow += 8000
    
    // Second abort - should reset the timer
    await handleEvent({
      type: "session.error",
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError" } }
    })
    
    // 5 seconds after second abort (13s after first, but only 5s after second)
    mockNow += 5000
    
    // Should still be blocked (5s < 10s from most recent abort)
    await handleEvent({
      type: "session.idle",
      properties: { sessionID: sessionId }
    })
    
    assert.strictEqual(reflectionRanCount, 0, "Should still be blocked - cooldown reset by second abort")
  })
})
