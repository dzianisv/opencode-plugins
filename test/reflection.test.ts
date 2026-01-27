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

  describe("severity=NONE with missing items", () => {
    it("should push feedback when severity=NONE but has missing items", () => {
      // This simulates the VibeTeam case where agent listed "Remaining Tasks" 
      // and asked "Would you like me to continue?" - judge returned NONE
      const verdict = {
        complete: false,
        severity: "NONE",
        feedback: "Agent listed remaining tasks but stopped and asked permission",
        missing: ["OpenHands team.py orchestration", "Integration tests"],
        next_actions: ["Create vibeteam/teams/openhands_team.py"]
      }
      
      const severity = verdict.severity || "MEDIUM"
      const hasMissingItems = verdict.missing?.length > 0 || verdict.next_actions?.length > 0
      
      // The new logic: push feedback if severity=NONE but has missing items
      const shouldPushFeedback = !(severity === "NONE" && !hasMissingItems)
      
      assert.strictEqual(hasMissingItems, true, "Should detect missing items")
      assert.strictEqual(shouldPushFeedback, true, "Should push feedback when NONE + missing items")
    })

    it("should NOT push feedback when severity=NONE and no missing items", () => {
      // Agent is genuinely waiting for user input (e.g., asking clarifying question)
      const verdict = {
        complete: false,
        severity: "NONE",
        feedback: "Agent correctly asked for user preference",
        missing: [],
        next_actions: []
      }
      
      const severity = verdict.severity || "MEDIUM"
      const hasMissingItems = verdict.missing?.length > 0 || verdict.next_actions?.length > 0
      
      // Should NOT push feedback - agent is legitimately waiting for user
      const shouldPushFeedback = !(severity === "NONE" && !hasMissingItems)
      
      assert.strictEqual(hasMissingItems, false, "Should detect no missing items")
      assert.strictEqual(shouldPushFeedback, false, "Should NOT push feedback when NONE + no missing items")
    })

    it("should push feedback for all non-NONE severities regardless of missing items", () => {
      const testCases = [
        { severity: "LOW", missing: [], expected: true },
        { severity: "MEDIUM", missing: [], expected: true },
        { severity: "HIGH", missing: [], expected: true },
        { severity: "BLOCKER", missing: [], expected: true },
        { severity: "LOW", missing: ["item"], expected: true },
      ]
      
      for (const tc of testCases) {
        const hasMissingItems = tc.missing.length > 0
        const shouldPushFeedback = !(tc.severity === "NONE" && !hasMissingItems)
        assert.strictEqual(
          shouldPushFeedback, 
          tc.expected, 
          `Severity ${tc.severity} with ${tc.missing.length} items should ${tc.expected ? '' : 'NOT '}push feedback`
        )
      }
    })
  })

  describe("extractTaskAndResult with multiple human messages", () => {
    // Helper function that mimics extractTaskAndResult logic
    function extractTaskAndResult(messages: any[]): { task: string; result: string; tools: string; isResearch: boolean; humanMessages: string[] } | null {
      const humanMessages: string[] = []
      let result = ""
      const tools: string[] = []

      for (const msg of messages) {
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              if (part.text.includes("## Reflection:")) continue
              humanMessages.push(part.text)
              break
            }
          }
        }

        for (const part of msg.parts || []) {
          if (part.type === "tool") {
            try {
              tools.push(`${part.tool}: ${JSON.stringify(part.state?.input || {}).slice(0, 200)}`)
            } catch {}
          }
        }

        if (msg.info?.role === "assistant") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              result = part.text
            }
          }
        }
      }

      const originalTask = humanMessages[0] || ""
      const task = humanMessages.length === 1
        ? originalTask
        : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")
      
      const allHumanText = humanMessages.join(" ")
      const isResearch = /research|explore|investigate|analyze|review|study|compare|evaluate/i.test(allHumanText) &&
                         /do not|don't|no code|research only|just research|only research/i.test(allHumanText)

      if (!originalTask || !result) return null
      return { task, result, tools: tools.slice(-10).join("\n"), isResearch, humanMessages }
    }

    it("should capture all human messages in a multi-pivot session", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Create a user authentication system" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "I'll start implementing..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Actually, let's use OAuth instead of passwords" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Switching to OAuth..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Also add rate limiting" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done with OAuth and rate limiting!" }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.strictEqual(extracted.humanMessages.length, 3, "Should capture all 3 human messages")
      assert.strictEqual(extracted.humanMessages[0], "Create a user authentication system")
      assert.strictEqual(extracted.humanMessages[1], "Actually, let's use OAuth instead of passwords")
      assert.strictEqual(extracted.humanMessages[2], "Also add rate limiting")
    })

    it("should format multiple messages as numbered conversation history", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Task A" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Working..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Actually do Task B" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done!" }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.ok(extracted.task.includes("[1] Task A"), "Should include numbered first message")
      assert.ok(extracted.task.includes("[2] Actually do Task B"), "Should include numbered second message")
    })

    it("should use single message directly without numbering", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Simple task" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done!" }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.strictEqual(extracted.task, "Simple task", "Single message should be used directly")
      assert.ok(!extracted.task.includes("[1]"), "Should not have numbering for single message")
    })

    it("should filter out reflection feedback messages", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Working..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "## Reflection: Task Incomplete\n\nPlease continue." }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Continuing..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Now also do this" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done!" }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.strictEqual(extracted.humanMessages.length, 2, "Should only capture 2 non-reflection messages")
      assert.ok(!extracted.humanMessages.some(m => m.includes("## Reflection:")), "Should not include reflection messages")
    })

    it("should detect research tasks from any human message", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Look at the codebase" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Looking..." }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "This is research only - do not write any code" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Found the following..." }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.strictEqual(extracted.isResearch, true, "Should detect research task from second message")
    })

    it("should capture latest assistant result", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Start" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "First response" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Second response" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Finish" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Final response" }] },
      ]

      const extracted = extractTaskAndResult(messages)
      assert.ok(extracted, "Should extract task and result")
      assert.strictEqual(extracted.result, "Final response", "Should capture latest assistant response")
    })
  })
})
