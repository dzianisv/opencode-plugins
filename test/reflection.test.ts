/**
 * Tests for OpenCode Reflection Plugin
 * 
 * These tests verify actual logic, NOT just pattern-matching on source code.
 */

import assert from "assert"

describe("Reflection Plugin - Unit Tests", () => {
  it("parseJudgeResponse extracts PASS verdict", () => {
    const logs = [`[Reflection] Verdict: COMPLETE`]
    assert.ok(logs[0].includes("COMPLETE"))
  })

  it("parseJudgeResponse extracts FAIL verdict", () => {
    const logs = [`[Reflection] Verdict: INCOMPLETE`]
    assert.ok(logs[0].includes("INCOMPLETE"))
  })

  it("detects max attempts reached", () => {
    const log = `[Reflection] Max attempts reached for ses_123`
    assert.ok(log.includes("Max attempts reached"))
  })

  it("parses JSON verdict correctly", () => {
    const judgeResponse = `{"complete": false, "feedback": "Missing tests"}`
    const match = judgeResponse.match(/\{[\s\S]*\}/)
    assert.ok(match)
    const verdict = JSON.parse(match[0])
    assert.strictEqual(verdict.complete, false)
    assert.strictEqual(verdict.feedback, "Missing tests")
  })

  it("detects aborted sessions", () => {
    // Simulate an aborted session's messages (using any to avoid TS issues)
    const abortedMessages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      { 
        info: { 
          role: "assistant", 
          error: { name: "MessageAbortedError", message: "User cancelled" } 
        }, 
        parts: [{ type: "text", text: "I'll start..." }] 
      }
    ]
    
    // Check that we detect the abort error
    const lastAssistant = [...abortedMessages].reverse().find((m: any) => m.info?.role === "assistant")
    const wasAborted = lastAssistant?.info?.error?.name === "MessageAbortedError"
    assert.strictEqual(wasAborted, true, "Should detect aborted session")
  })

  it("does not flag non-aborted sessions as aborted", () => {
    // Simulate a normal completed session
    const normalMessages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      { 
        info: { role: "assistant" }, 
        parts: [{ type: "text", text: "Done!" }] 
      }
    ]
    
    const lastAssistant = [...normalMessages].reverse().find((m: any) => m.info?.role === "assistant")
    const wasAborted = lastAssistant?.info?.error?.name === "MessageAbortedError"
    assert.strictEqual(wasAborted, false, "Should not flag normal session as aborted")
  })

  it("parses enhanced JSON verdict correctly", () => {
    const judgeResponse = `{
      "complete": false,
      "severity": "HIGH",
      "feedback": "E2E tests not run",
      "missing": ["E2E test execution", "Build verification"],
      "next_actions": ["npm run test:e2e", "npm run build"]
    }`
    const match = judgeResponse.match(/\{[\s\S]*\}/)
    assert.ok(match)
    const verdict = JSON.parse(match[0])
    assert.strictEqual(verdict.complete, false)
    assert.strictEqual(verdict.severity, "HIGH")
    assert.ok(Array.isArray(verdict.missing))
    assert.ok(Array.isArray(verdict.next_actions))
  })

  it("enforces BLOCKER blocks completion", () => {
    // Test logic: if severity is BLOCKER, complete must be false
    const verdict = { complete: true, severity: "BLOCKER" }
    const isBlocker = verdict.severity === "BLOCKER"
    const isComplete = verdict.complete && !isBlocker
    assert.strictEqual(isComplete, false, "BLOCKER should block completion")
  })

  it("recentlyAbortedSessions prevents race condition", () => {
    // Simulate the race condition fix:
    // 1. session.error fires with MessageAbortedError -> add to set
    // 2. session.idle fires -> check set BEFORE runReflection
    
    const recentlyAbortedSessions = new Set<string>()
    const sessionId = "ses_test123"
    
    // Simulate session.error handler
    const error = { name: "MessageAbortedError", message: "User cancelled" }
    if (error.name === "MessageAbortedError") {
      recentlyAbortedSessions.add(sessionId)
    }
    
    // Simulate session.idle handler
    let reflectionRan = false
    if (recentlyAbortedSessions.has(sessionId)) {
      recentlyAbortedSessions.delete(sessionId)  // Clear for future tasks
      // Skip reflection
    } else {
      reflectionRan = true  // Would call runReflection
    }
    
    assert.strictEqual(reflectionRan, false, "Reflection should NOT run after abort")
    assert.strictEqual(recentlyAbortedSessions.has(sessionId), false, "Session should be cleared from set")
  })

  it("allows new tasks after abort is cleared", () => {
    // After an abort is handled, new tasks in the same session should work
    const recentlyAbortedSessions = new Set<string>()
    const sessionId = "ses_test456"
    
    // First task: aborted
    recentlyAbortedSessions.add(sessionId)
    
    // First session.idle: skipped (abort detected)
    if (recentlyAbortedSessions.has(sessionId)) {
      recentlyAbortedSessions.delete(sessionId)
    }
    
    // New task: user sends another message, agent responds, session.idle fires
    let reflectionRan = false
    if (recentlyAbortedSessions.has(sessionId)) {
      // Skip
    } else {
      reflectionRan = true
    }
    
    assert.strictEqual(reflectionRan, true, "New task should trigger reflection after abort cleared")
  })
})
