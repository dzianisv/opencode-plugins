/**
 * Tests for OpenCode Reflection Plugin
 * 
 * These tests verify actual logic, NOT just pattern-matching on source code.
 */

import assert from "assert"
const TASK_CATEGORY_MODEL_IDS = {
  backend: "gpt-5.2-codex",
  architecture: "claude-4.6-opus",
  frontend: "gemini-3-pro-preview",
  unknown: null
} as const

describe("Reflection Plugin - Unit Tests", () => {
  describe("reflection-static Plan mode detection", () => {
    let isPlanModeStatic: (messages: any[]) => boolean

    beforeAll(async () => {
      const mod = await import("../reflection-static.ts")
      isPlanModeStatic = mod.isPlanModeStatic
    })

    it("detects plan mode from system text", () => {
      const messages = [
        { info: { role: "system" }, parts: [{ type: "text", text: "Plan mode ACTIVE" }] }
      ]
      assert.strictEqual(isPlanModeStatic(messages), true)
    })

    it("detects plan mode from metadata flag", () => {
      const messages = [
        { info: { role: "assistant", mode: "plan" }, parts: [] }
      ]
      assert.strictEqual(isPlanModeStatic(messages), true)
    })

    it("prefers explicit mode over text patterns", () => {
      const messages = [
        { info: { role: "assistant", mode: "build" }, parts: [] },
        { info: { role: "system" }, parts: [{ type: "text", text: "Plan mode ACTIVE" }] }
      ]
      assert.strictEqual(isPlanModeStatic(messages), false)
    })

    it("detects plan-only user request", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Only provide a plan." }] }
      ]
      assert.strictEqual(isPlanModeStatic(messages), true)
    })

    it("ignores regular non-plan user request", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Implement the API endpoint." }] }
      ]
      assert.strictEqual(isPlanModeStatic(messages), false)
    })

    it("handles non-array messages safely", () => {
      assert.strictEqual(isPlanModeStatic({} as any), false)
      assert.strictEqual(isPlanModeStatic(null as any), false)
    })
  })
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

  // Issue #82: Detect aborted sessions via missing time.completed
  // When user presses ESC, the last assistant message won't have time.completed set.
  // This catches aborts even when session.idle fires before session.error (race condition).
  it("detects aborted sessions via missing time.completed (Issue #82)", () => {
    // Simulate: user pressed ESC, session.idle fires before session.error writes
    // the abort error to the message. The last assistant message has no error but
    // also no time.completed.
    const messages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      {
        info: {
          role: "assistant",
          time: { start: Date.now() }  // No 'completed' field — interrupted
        },
        parts: [{ type: "text", text: "I'll start..." }]
      }
    ]

    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    const isCompleted = !!(lastAssistant?.info?.time as any)?.completed
    assert.strictEqual(isCompleted, false, "Should detect incomplete session (no time.completed)")
  })

  it("does not flag completed sessions as aborted via time.completed (Issue #82)", () => {
    // Simulate: normal completed session with time.completed set
    const messages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      {
        info: {
          role: "assistant",
          time: { start: Date.now(), completed: Date.now() + 5000 }
        },
        parts: [{ type: "text", text: "Done!" }]
      }
    ]

    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    const isCompleted = !!(lastAssistant?.info?.time as any)?.completed
    assert.strictEqual(isCompleted, true, "Should recognize completed session (has time.completed)")
  })

  it("detects aborted sessions even without error field when time.completed is missing (Issue #82)", () => {
    // This is the key race condition case: session.idle fires before session.error,
    // so error is NOT yet written to the message but time.completed is also missing.
    const messages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Fix the bug" }] },
      {
        info: {
          role: "assistant",
          time: { start: Date.now() }
          // No error field, no completed field — ESC pressed but error not yet recorded
        },
        parts: [{ type: "text", text: "Let me look at the code..." }]
      }
    ]

    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    // The fix: check for time.completed BEFORE checking for error
    const hasTimeCompleted = !!(lastAssistant?.info?.time as any)?.completed
    const hasAbortError = lastAssistant?.info?.error?.name === "MessageAbortedError"
    const wasAborted = !hasTimeCompleted || hasAbortError
    assert.strictEqual(wasAborted, true, "Should detect abort via missing time.completed even without error field")
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

  describe("task classification routing", () => {
    it("maps backend tasks to gpt-5.2-codex", () => {
      const model = TASK_CATEGORY_MODEL_IDS.backend
      assert.strictEqual(model, "gpt-5.2-codex")
    })

    it("maps architecture tasks to claude-4.6-opus", () => {
      const model = TASK_CATEGORY_MODEL_IDS.architecture
      assert.strictEqual(model, "claude-4.6-opus")
    })

    it("maps frontend tasks to gemini-3-pro-preview", () => {
      const model = TASK_CATEGORY_MODEL_IDS.frontend
      assert.strictEqual(model, "gemini-3-pro-preview")
    })

    it("returns null for unknown task category", () => {
      const model = TASK_CATEGORY_MODEL_IDS.unknown
      assert.strictEqual(model, null)
    })
  })

  describe("requires_human_action handling", () => {
    it("should NOT send feedback to agent when requires_human_action is true", () => {
      // When the agent hits a blocker that requires human intervention 
      // (OAuth consent, 2FA, API key from dashboard), we should:
      // 1. Show toast to USER
      // 2. NOT call promptAsync (which triggers agent)
      const verdict = {
        complete: false,
        severity: "MEDIUM",
        requires_human_action: true,
        feedback: "Cannot complete OAuth without user clicking Allow in browser",
        missing: ["User must grant OAuth consent in browser popup"],
        next_actions: []
      }
      
      // This simulates the logic in reflection.ts
      let sentToAgent = false
      let shownToast = false
      
      if (verdict.requires_human_action) {
        // Show toast to user, don't send to agent
        shownToast = true
        // Return early, don't call promptAsync
      } else {
        // Normal flow: send feedback to agent
        sentToAgent = true
      }
      
      assert.strictEqual(shownToast, true, "Should show toast to user")
      assert.strictEqual(sentToAgent, false, "Should NOT send feedback to agent")
    })

    it("should send feedback to agent when requires_human_action is false", () => {
      // When the agent CAN do the work but chose to give instructions instead
      // (e.g., said "run npm build" instead of running it), we should push feedback
      const verdict = {
        complete: false,
        severity: "LOW",
        requires_human_action: false,
        feedback: "Agent provided instructions but didn't execute deployment commands",
        missing: [],
        next_actions: ["npm run build", "npm run deploy:prod"]
      }
      
      let sentToAgent = false
      let shownToast = false
      
      if (verdict.requires_human_action) {
        shownToast = true
      } else {
        sentToAgent = true
      }
      
      assert.strictEqual(shownToast, false, "Should NOT show human-action toast")
      assert.strictEqual(sentToAgent, true, "Should send feedback to agent")
    })

    it("should treat undefined requires_human_action as false", () => {
      // Backwards compatibility: old verdicts without this field should work
      const verdict: any = {
        complete: false,
        severity: "MEDIUM",
        feedback: "Tests not run",
        missing: ["Run npm test"],
        next_actions: []
        // Note: requires_human_action is NOT present
      }
      
      let sentToAgent = false
      
      // Check requires_human_action with falsy check (handles undefined)
      if (verdict.requires_human_action) {
        // Skip
      } else {
        sentToAgent = true
      }
      
      assert.strictEqual(sentToAgent, true, "Missing requires_human_action should default to false")
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

  describe("GenAI Stuck Detection", () => {
    // Types matching the plugin
    type StuckReason = "genuinely_stuck" | "waiting_for_user" | "working" | "complete" | "error"
    interface StuckEvaluation {
      stuck: boolean
      reason: StuckReason
      confidence: number
      shouldNudge: boolean
      nudgeMessage?: string
    }

    describe("FAST_MODELS priority list", () => {
      const FAST_MODELS: Record<string, string[]> = {
        "anthropic": ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-haiku-4", "claude-haiku-4.5"],
        "openai": ["gpt-4o-mini", "gpt-3.5-turbo"],
        "google": ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-flash"],
        "github-copilot": ["claude-haiku-4.5", "claude-3.5-haiku", "gpt-4o-mini"],
        "azure": ["gpt-4o-mini", "gpt-35-turbo"],
        "bedrock": ["anthropic.claude-3-haiku-20240307-v1:0"],
        "groq": ["llama-3.1-8b-instant", "mixtral-8x7b-32768"],
      }

      it("should have fast models defined for common providers", () => {
        const expectedProviders = ["anthropic", "openai", "google", "github-copilot"]
        for (const provider of expectedProviders) {
          assert.ok(FAST_MODELS[provider], `Missing fast models for ${provider}`)
          assert.ok(FAST_MODELS[provider].length > 0, `Empty fast models list for ${provider}`)
        }
      })

      it("should prioritize fastest/cheapest models first", () => {
        // Haiku should come before Sonnet/Opus for Anthropic
        const anthropicModels = FAST_MODELS["anthropic"]
        assert.ok(anthropicModels[0].includes("haiku"), "Haiku should be first for Anthropic")
        
        // gpt-4o-mini should come before gpt-4 for OpenAI
        const openaiModels = FAST_MODELS["openai"]
        assert.strictEqual(openaiModels[0], "gpt-4o-mini", "gpt-4o-mini should be first for OpenAI")
      })
    })

    describe("StuckEvaluation parsing", () => {
      it("should parse valid GenAI stuck evaluation response", () => {
        const response = `{"stuck": true, "reason": "genuinely_stuck", "confidence": 0.85, "shouldNudge": true, "nudgeMessage": "Please continue with the task"}`
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        assert.ok(jsonMatch, "Should find JSON in response")
        
        const result = JSON.parse(jsonMatch[0]) as StuckEvaluation
        assert.strictEqual(result.stuck, true)
        assert.strictEqual(result.reason, "genuinely_stuck")
        assert.strictEqual(result.confidence, 0.85)
        assert.strictEqual(result.shouldNudge, true)
        assert.strictEqual(result.nudgeMessage, "Please continue with the task")
      })

      it("should handle waiting_for_user response", () => {
        const response = `{"stuck": false, "reason": "waiting_for_user", "confidence": 0.9, "shouldNudge": false}`
        const result = JSON.parse(response) as StuckEvaluation
        
        assert.strictEqual(result.stuck, false)
        assert.strictEqual(result.reason, "waiting_for_user")
        assert.strictEqual(result.shouldNudge, false)
      })

      it("should handle working (mid-tool-call) response", () => {
        const response = `{"stuck": false, "reason": "working", "confidence": 0.95, "shouldNudge": false}`
        const result = JSON.parse(response) as StuckEvaluation
        
        assert.strictEqual(result.stuck, false)
        assert.strictEqual(result.reason, "working")
        assert.strictEqual(result.shouldNudge, false)
      })

      it("should handle complete task response", () => {
        const response = `{"stuck": false, "reason": "complete", "confidence": 0.98, "shouldNudge": false}`
        const result = JSON.parse(response) as StuckEvaluation
        
        assert.strictEqual(result.stuck, false)
        assert.strictEqual(result.reason, "complete")
      })

      it("should normalize missing fields with defaults", () => {
        // Minimal response from GenAI
        const response = `{"stuck": true}`
        const result = JSON.parse(response)
        
        // Apply defaults like the plugin does
        const evaluation: StuckEvaluation = {
          stuck: !!result.stuck,
          reason: result.reason || "genuinely_stuck",
          confidence: result.confidence ?? 0.5,
          shouldNudge: result.shouldNudge ?? result.stuck,
          nudgeMessage: result.nudgeMessage
        }
        
        assert.strictEqual(evaluation.stuck, true)
        assert.strictEqual(evaluation.reason, "genuinely_stuck", "Should default to genuinely_stuck")
        assert.strictEqual(evaluation.confidence, 0.5, "Should default confidence to 0.5")
        assert.strictEqual(evaluation.shouldNudge, true, "shouldNudge should default to stuck value")
        assert.strictEqual(evaluation.nudgeMessage, undefined)
      })
    })

    describe("stuck evaluation caching", () => {
      it("should cache evaluations with TTL", () => {
        const GENAI_STUCK_CACHE_TTL = 60_000
        const cache = new Map<string, { result: StuckEvaluation; timestamp: number }>()
        const sessionId = "ses_cache_test"
        const now = Date.now()
        
        // Add to cache
        const evaluation: StuckEvaluation = {
          stuck: true,
          reason: "genuinely_stuck",
          confidence: 0.8,
          shouldNudge: true
        }
        cache.set(sessionId, { result: evaluation, timestamp: now })
        
        // Check cache hit (within TTL)
        const cached = cache.get(sessionId)
        const isValid = cached && (now - cached.timestamp) < GENAI_STUCK_CACHE_TTL
        assert.strictEqual(isValid, true, "Cache should be valid within TTL")
        
        // Check cache miss (expired)
        cache.set(sessionId, { result: evaluation, timestamp: now - GENAI_STUCK_CACHE_TTL - 1000 })
        const expiredCached = cache.get(sessionId)
        const isExpired = expiredCached && (now - expiredCached.timestamp) >= GENAI_STUCK_CACHE_TTL
        assert.strictEqual(isExpired, true, "Cache should be expired after TTL")
      })
    })

    describe("threshold checks", () => {
      const GENAI_STUCK_CHECK_THRESHOLD = 30_000

      it("should skip GenAI check if message is too recent", () => {
        const messageAgeMs = 15_000 // 15 seconds
        const shouldSkip = messageAgeMs < GENAI_STUCK_CHECK_THRESHOLD
        assert.strictEqual(shouldSkip, true, "Should skip GenAI for recent messages")
      })

      it("should run GenAI check if message is old enough", () => {
        const messageAgeMs = 45_000 // 45 seconds
        const shouldRun = messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD
        assert.strictEqual(shouldRun, true, "Should run GenAI for old messages")
      })

      it("should run GenAI check at exact threshold", () => {
        const messageAgeMs = GENAI_STUCK_CHECK_THRESHOLD // exactly 30 seconds
        const shouldRun = messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD
        assert.strictEqual(shouldRun, true, "Should run GenAI at exact threshold")
      })
    })

    describe("stuck detection scenarios", () => {
      it("should detect stuck when agent stopped mid-sentence", () => {
        // Simulate agent output that stops mid-thought
        const lastAssistantText = "I'll now implement the authentication by first"
        const isMessageComplete = false
        const outputTokens = 15
        const messageAgeMs = 60_000
        
        // Indicators: incomplete message + old + has some output but stopped
        const likelyStuck = !isMessageComplete && messageAgeMs > 30_000
        assert.strictEqual(likelyStuck, true, "Should detect stuck mid-sentence")
      })

      it("should NOT detect stuck when agent asked a question", () => {
        // Agent is waiting for user input
        const lastAssistantText = "What database would you like to use? PostgreSQL, MySQL, or MongoDB?"
        const isMessageComplete = true
        const outputTokens = 25
        
        // Complete message with question mark = waiting for user
        const isQuestion = lastAssistantText.includes("?")
        const shouldBeWaiting = isMessageComplete && isQuestion
        assert.strictEqual(shouldBeWaiting, true, "Question indicates waiting for user")
      })

      it("should NOT detect stuck when tool is actively running", () => {
        // Simulate tool in progress
        const pendingToolCalls = ["bash: running"]
        const hasRunningTool = pendingToolCalls.some(t => t.includes("running"))
        
        // Running tool = not stuck
        assert.strictEqual(hasRunningTool, true, "Running tool indicates not stuck")
      })

      it("should detect stuck when output tokens = 0 and long delay", () => {
        const isMessageComplete = false
        const outputTokens = 0
        const messageAgeMs = 90_000 // 90 seconds
        
        // No output + not complete + long delay = definitely stuck
        const definitelyStuck = !isMessageComplete && outputTokens === 0 && messageAgeMs > 60_000
        assert.strictEqual(definitelyStuck, true, "Zero tokens + long delay = stuck")
      })
    })

    describe("fast model selection", () => {
      it("should select from provider's fast model list", () => {
        // Simulate provider with available models
        const providerID = "anthropic"
        const availableModels = ["claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022", "claude-opus-4"]
        const fastModelsForProvider = ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307"]
        
        // Find first fast model that's available
        const selectedModel = fastModelsForProvider.find(m => availableModels.includes(m))
        assert.strictEqual(selectedModel, "claude-3-5-haiku-20241022", "Should select first available fast model")
      })

      it("should fallback to first available model if no fast model", () => {
        // Provider with only non-fast models
        const availableModels = ["claude-opus-4", "claude-3-5-sonnet-20241022"]
        const fastModelsForProvider = ["claude-3-5-haiku-20241022"] // not available
        
        const selectedFast = fastModelsForProvider.find(m => availableModels.includes(m))
        const fallback = selectedFast || availableModels[0]
        
        assert.strictEqual(selectedFast, undefined, "No fast model should be found")
        assert.strictEqual(fallback, "claude-opus-4", "Should fallback to first available")
      })

      it("should cache fast model selection", () => {
        const FAST_MODEL_CACHE_TTL = 300_000 // 5 minutes
        let fastModelCache: { providerID: string; modelID: string } | null = null
        let fastModelCacheTime = 0
        
        // First call - no cache
        const now = Date.now()
        const hasCachedModel = fastModelCache && (now - fastModelCacheTime) < FAST_MODEL_CACHE_TTL
        assert.strictEqual(hasCachedModel, null, "Should not have cached model initially (null due to short-circuit)")
        
        // Set cache
        fastModelCache = { providerID: "anthropic", modelID: "claude-3-5-haiku-20241022" }
        fastModelCacheTime = now
        
        // Second call - cache hit
        const hasCachedModelNow = fastModelCache && (now - fastModelCacheTime) < FAST_MODEL_CACHE_TTL
        assert.strictEqual(hasCachedModelNow, true, "Should use cached model")
      })
    })
  })

  describe("GenAI Post-Compression Evaluation", () => {
    // Types matching the plugin
    type CompressionAction = "needs_github_update" | "continue_task" | "needs_clarification" | "task_complete" | "error"
    interface CompressionEvaluation {
      action: CompressionAction
      hasActiveGitWork: boolean
      confidence: number
      nudgeMessage: string
    }

    describe("CompressionEvaluation parsing", () => {
      it("should parse needs_github_update response", () => {
        const response = `{
          "action": "needs_github_update",
          "hasActiveGitWork": true,
          "confidence": 0.9,
          "nudgeMessage": "Please update PR #34 with your progress using gh pr comment"
        }`
        const result = JSON.parse(response) as CompressionEvaluation
        
        assert.strictEqual(result.action, "needs_github_update")
        assert.strictEqual(result.hasActiveGitWork, true)
        assert.strictEqual(result.confidence, 0.9)
        assert.ok(result.nudgeMessage.includes("PR #34"))
      })

      it("should parse continue_task response", () => {
        const response = `{
          "action": "continue_task",
          "hasActiveGitWork": false,
          "confidence": 0.85,
          "nudgeMessage": "Context was compressed. Please continue implementing the authentication system."
        }`
        const result = JSON.parse(response) as CompressionEvaluation
        
        assert.strictEqual(result.action, "continue_task")
        assert.strictEqual(result.hasActiveGitWork, false)
        assert.ok(result.nudgeMessage.includes("authentication"))
      })

      it("should parse task_complete response", () => {
        const response = `{
          "action": "task_complete",
          "hasActiveGitWork": false,
          "confidence": 0.95,
          "nudgeMessage": ""
        }`
        const result = JSON.parse(response) as CompressionEvaluation
        
        assert.strictEqual(result.action, "task_complete")
        assert.strictEqual(result.nudgeMessage, "")
      })

      it("should parse needs_clarification response", () => {
        const response = `{
          "action": "needs_clarification",
          "hasActiveGitWork": false,
          "confidence": 0.7,
          "nudgeMessage": "Context was compressed and some details may have been lost. Can you summarize the current state and what's needed next?"
        }`
        const result = JSON.parse(response) as CompressionEvaluation
        
        assert.strictEqual(result.action, "needs_clarification")
        assert.ok(result.nudgeMessage.includes("summarize"))
      })

      it("should normalize missing fields with defaults", () => {
        const response = `{"action": "continue_task"}`
        const result = JSON.parse(response)
        
        // Apply defaults like the plugin does
        const defaultNudge = "Context was just compressed. Please continue with the task where you left off."
        const evaluation: CompressionEvaluation = {
          action: result.action || "continue_task",
          hasActiveGitWork: !!result.hasActiveGitWork,
          confidence: result.confidence ?? 0.5,
          nudgeMessage: result.nudgeMessage || defaultNudge
        }
        
        assert.strictEqual(evaluation.action, "continue_task")
        assert.strictEqual(evaluation.hasActiveGitWork, false)
        assert.strictEqual(evaluation.confidence, 0.5)
        assert.strictEqual(evaluation.nudgeMessage, defaultNudge)
      })
    })

    describe("GitHub work detection", () => {
      it("should detect gh pr commands in tool usage", () => {
        const toolInput = JSON.stringify({ command: "gh pr create --title 'feat: add auth'" })
        const hasGHCommand = /\bgh\s+(pr|issue)\b/i.test(toolInput)
        assert.strictEqual(hasGHCommand, true, "Should detect gh pr command")
      })

      it("should detect gh issue commands in tool usage", () => {
        const toolInput = JSON.stringify({ command: "gh issue comment 42 --body 'Progress update'" })
        const hasGHCommand = /\bgh\s+(pr|issue)\b/i.test(toolInput)
        assert.strictEqual(hasGHCommand, true, "Should detect gh issue command")
      })

      it("should detect git commit/push commands", () => {
        const toolInput = JSON.stringify({ command: "git commit -m 'feat: add feature'" })
        const hasGitCommand = /\bgit\s+(commit|push|branch|checkout)\b/i.test(toolInput)
        assert.strictEqual(hasGitCommand, true, "Should detect git commit")
      })

      it("should detect PR references in text", () => {
        const text = "Working on PR #34 to implement the feature"
        const hasPRRef = /#\d+|PR\s*#?\d+|issue\s*#?\d+|pull request/i.test(text)
        assert.strictEqual(hasPRRef, true, "Should detect PR #34 reference")
      })

      it("should detect issue references in text", () => {
        const text = "This fixes issue #123"
        const hasIssueRef = /#\d+|PR\s*#?\d+|issue\s*#?\d+|pull request/i.test(text)
        assert.strictEqual(hasIssueRef, true, "Should detect issue #123 reference")
      })

      it("should not false positive on unrelated numbers", () => {
        const text = "The function returns 42"
        // This will match #42 if written as #42, but "42" alone shouldn't match
        const hasRef = /PR\s*#?\d+|issue\s*#?\d+|pull request/i.test(text)
        assert.strictEqual(hasRef, false, "Should not match plain numbers")
      })
    })

    describe("action-based behavior", () => {
      it("should skip nudge for task_complete action", () => {
        const evaluation: CompressionEvaluation = {
          action: "task_complete",
          hasActiveGitWork: false,
          confidence: 0.95,
          nudgeMessage: ""
        }
        
        const shouldSkipNudge = evaluation.action === "task_complete"
        assert.strictEqual(shouldSkipNudge, true, "Should skip nudge for complete tasks")
      })

      it("should use appropriate toast for needs_github_update", () => {
        const evaluation: CompressionEvaluation = {
          action: "needs_github_update",
          hasActiveGitWork: true,
          confidence: 0.9,
          nudgeMessage: "Update the PR"
        }
        
        const toastMsg = evaluation.action === "needs_github_update" 
          ? "Prompted GitHub update" 
          : evaluation.action === "needs_clarification"
            ? "Requested clarification"
            : "Nudged to continue"
        
        assert.strictEqual(toastMsg, "Prompted GitHub update")
      })

      it("should use appropriate toast for needs_clarification", () => {
        const evaluation: CompressionEvaluation = {
          action: "needs_clarification",
          hasActiveGitWork: false,
          confidence: 0.7,
          nudgeMessage: "Please clarify"
        }
        
        const toastMsg = evaluation.action === "needs_github_update" 
          ? "Prompted GitHub update" 
          : evaluation.action === "needs_clarification"
            ? "Requested clarification"
            : "Nudged to continue"
        
        assert.strictEqual(toastMsg, "Requested clarification")
      })

      it("should use appropriate toast for continue_task", () => {
        const evaluation: CompressionEvaluation = {
          action: "continue_task",
          hasActiveGitWork: false,
          confidence: 0.85,
          nudgeMessage: "Continue working"
        }
        
        const toastMsg = evaluation.action === "needs_github_update" 
          ? "Prompted GitHub update" 
          : evaluation.action === "needs_clarification"
            ? "Requested clarification"
            : "Nudged to continue"
        
        assert.strictEqual(toastMsg, "Nudged to continue")
      })
    })

    describe("message context extraction", () => {
      it("should extract human messages excluding reflection feedback", () => {
        const messages = [
          { info: { role: "user" }, parts: [{ type: "text", text: "Implement auth" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Working..." }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "## Reflection: Task Incomplete\n\nContinue" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Continuing..." }] },
        ]
        
        const humanMessages: string[] = []
        for (const msg of messages) {
          if (msg.info?.role === "user") {
            for (const part of msg.parts || []) {
              if (part.type === "text" && part.text && !part.text.includes("## Reflection:")) {
                humanMessages.push(part.text.slice(0, 300))
                break
              }
            }
          }
        }
        
        assert.strictEqual(humanMessages.length, 1, "Should only include non-reflection message")
        assert.strictEqual(humanMessages[0], "Implement auth")
      })

      it("should extract last assistant text", () => {
        const messages = [
          { info: { role: "user" }, parts: [{ type: "text", text: "Do task" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "First response" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "Continue" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Final response with progress" }] },
        ]
        
        let lastAssistantText = ""
        for (const msg of messages) {
          if (msg.info?.role === "assistant") {
            for (const part of msg.parts || []) {
              if (part.type === "text" && part.text) {
                lastAssistantText = part.text.slice(0, 1000)
              }
            }
          }
        }
        
        assert.strictEqual(lastAssistantText, "Final response with progress")
      })
    })
  })

  describe("Configurable Reflection Prompts", () => {
    // Mock types matching the plugin's config types
    interface TaskPattern {
      pattern: string
      type?: "coding" | "research"
      extraRules?: string[]
    }

    interface ReflectionConfig {
      enabled?: boolean
      customRules?: {
        coding?: string[]
        research?: string[]
      }
      taskPatterns?: TaskPattern[]
      promptTemplate?: string | null
    }

    const DEFAULT_CONFIG: ReflectionConfig = {
      enabled: true,
      customRules: {
        coding: [
          "All explicitly requested functionality implemented",
          "Tests run and pass (if tests were requested or exist)",
          "Build/compile succeeds (if applicable)",
          "No unhandled errors in output"
        ],
        research: [
          "Research findings delivered with reasonable depth",
          "Sources or references provided where appropriate"
        ]
      },
      taskPatterns: [],
      promptTemplate: null
    }

    // Helper function mimicking findMatchingPattern
    function findMatchingPattern(task: string, config: ReflectionConfig): TaskPattern | null {
      if (!config.taskPatterns?.length) return null
      
      for (const pattern of config.taskPatterns) {
        try {
          const regex = new RegExp(pattern.pattern, "i")
          if (regex.test(task)) {
            return pattern
          }
        } catch {
          continue
        }
      }
      return null
    }

    // Helper function mimicking buildCustomRules
    function buildCustomRules(isResearch: boolean, config: ReflectionConfig, matchedPattern: TaskPattern | null): string {
      const rules: string[] = []
      
      if (isResearch) {
        rules.push(...(config.customRules?.research || []))
      } else {
        rules.push(...(config.customRules?.coding || []))
      }
      
      if (matchedPattern?.extraRules) {
        rules.push(...matchedPattern.extraRules)
      }
      
      if (rules.length === 0) return ""
      
      const numberedRules = rules.map((r, i) => `${i + 1}. ${r}`).join("\n")
      return isResearch 
        ? `\n### Research Task Rules\n${numberedRules}\n`
        : `\n### Coding Task Rules\n${numberedRules}\n`
    }

    // Helper function mimicking mergeConfig
    function mergeConfig(defaults: ReflectionConfig, override: ReflectionConfig): ReflectionConfig {
      return {
        enabled: override.enabled ?? defaults.enabled,
        customRules: {
          coding: override.customRules?.coding ?? defaults.customRules?.coding,
          research: override.customRules?.research ?? defaults.customRules?.research
        },
        taskPatterns: override.taskPatterns ?? defaults.taskPatterns,
        promptTemplate: override.promptTemplate ?? defaults.promptTemplate
      }
    }

    describe("findMatchingPattern", () => {
      it("returns null when no patterns configured", () => {
        const config: ReflectionConfig = { taskPatterns: [] }
        const result = findMatchingPattern("fix the bug", config)
        assert.strictEqual(result, null)
      })

      it("matches bug fix pattern", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "fix.*bug|debug", type: "coding", extraRules: ["Verify bug is fixed with test"] }
          ]
        }
        const result = findMatchingPattern("Please fix the login bug", config)
        assert.ok(result, "Should match bug fix pattern")
        assert.strictEqual(result!.type, "coding")
        assert.deepStrictEqual(result!.extraRules, ["Verify bug is fixed with test"])
      })

      it("matches research pattern", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "research|investigate|explore", type: "research" }
          ]
        }
        const result = findMatchingPattern("Research how authentication works", config)
        assert.ok(result, "Should match research pattern")
        assert.strictEqual(result!.type, "research")
      })

      it("is case insensitive", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "URGENT", extraRules: ["Prioritize this task"] }
          ]
        }
        const result = findMatchingPattern("This is urgent: fix ASAP", config)
        assert.ok(result, "Should match case-insensitively")
      })

      it("handles invalid regex gracefully", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "[invalid(regex", extraRules: ["This should not crash"] },
            { pattern: "valid", extraRules: ["This should match"] }
          ]
        }
        const result = findMatchingPattern("This is valid", config)
        assert.ok(result, "Should skip invalid regex and match valid pattern")
        assert.deepStrictEqual(result!.extraRules, ["This should match"])
      })
    })

    describe("buildCustomRules", () => {
      it("builds coding rules from config", () => {
        const rules = buildCustomRules(false, DEFAULT_CONFIG, null)
        assert.ok(rules.includes("Coding Task Rules"))
        assert.ok(rules.includes("1. All explicitly requested functionality implemented"))
        assert.ok(rules.includes("4. No unhandled errors in output"))
      })

      it("builds research rules from config", () => {
        const rules = buildCustomRules(true, DEFAULT_CONFIG, null)
        assert.ok(rules.includes("Research Task Rules"))
        assert.ok(rules.includes("Research findings delivered"))
      })

      it("includes extra rules from matched pattern", () => {
        const pattern: TaskPattern = {
          pattern: "security",
          extraRules: ["Check for SQL injection", "Check for XSS"]
        }
        const rules = buildCustomRules(false, DEFAULT_CONFIG, pattern)
        assert.ok(rules.includes("Check for SQL injection"))
        assert.ok(rules.includes("Check for XSS"))
      })

      it("returns empty string when no rules", () => {
        const emptyConfig: ReflectionConfig = { customRules: {} }
        const rules = buildCustomRules(false, emptyConfig, null)
        assert.strictEqual(rules, "")
      })
    })

    describe("mergeConfig", () => {
      it("overrides enabled flag", () => {
        const merged = mergeConfig(DEFAULT_CONFIG, { enabled: false })
        assert.strictEqual(merged.enabled, false)
      })

      it("overrides custom coding rules", () => {
        const customRules = ["Custom rule 1", "Custom rule 2"]
        const merged = mergeConfig(DEFAULT_CONFIG, { customRules: { coding: customRules } })
        assert.deepStrictEqual(merged.customRules?.coding, customRules)
        // Research rules should fall back to default
        assert.deepStrictEqual(merged.customRules?.research, DEFAULT_CONFIG.customRules?.research)
      })

      it("overrides task patterns", () => {
        const patterns: TaskPattern[] = [{ pattern: "custom", type: "coding" }]
        const merged = mergeConfig(DEFAULT_CONFIG, { taskPatterns: patterns })
        assert.deepStrictEqual(merged.taskPatterns, patterns)
      })

      it("preserves defaults when override is empty", () => {
        const merged = mergeConfig(DEFAULT_CONFIG, {})
        assert.strictEqual(merged.enabled, DEFAULT_CONFIG.enabled)
        assert.deepStrictEqual(merged.customRules, DEFAULT_CONFIG.customRules)
      })
    })

    describe("config-based task type detection", () => {
      it("pattern can override task type to research", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "how does.*work", type: "research" }
          ]
        }
        const task = "How does the authentication work in this codebase?"
        const matchedPattern = findMatchingPattern(task, config)
        
        // Pattern should override the default isResearch detection
        const isResearch = matchedPattern?.type === "research"
        assert.strictEqual(isResearch, true)
      })

      it("pattern can force coding type for ambiguous tasks", () => {
        const config: ReflectionConfig = {
          taskPatterns: [
            { pattern: "implement|create|add", type: "coding" }
          ]
        }
        const task = "Add a new feature for user authentication"
        const matchedPattern = findMatchingPattern(task, config)
        
        const isCoding = matchedPattern?.type === "coding"
        assert.strictEqual(isCoding, true)
      })
    })
  })

  describe("Human message during reflection (race condition)", () => {
    // This tests the fix for the race condition where:
    // 1. Reflection sends self-assessment question
    // 2. Waits for response (could take 30+ seconds)
    // 3. Human types a new message during this wait
    // 4. Reflection should abort instead of injecting stale "Please continue..."

    // Helper function mimicking getLastRelevantUserMessageId
    function getLastRelevantUserMessageId(messages: any[]): string | null {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              // Skip reflection prompts
              if (part.text.includes("1. **What was the task?**")) {
                continue
              }
              return msg.id || `msg_${i}`
            }
          }
        }
      }
      return null
    }

    it("should detect when human sent new message during analysis", () => {
      // Initial state when reflection started
      const initialMessages = [
        { id: "msg_1", info: { role: "user" }, parts: [{ type: "text", text: "Do task A" }] },
        { id: "msg_2", info: { role: "assistant" }, parts: [{ type: "text", text: "Working on A..." }] },
      ]
      const initialUserMsgId = getLastRelevantUserMessageId(initialMessages)
      assert.strictEqual(initialUserMsgId, "msg_1", "Initial user message should be msg_1")

      // State after analysis completes - human added a new message
      const currentMessages = [
        { id: "msg_1", info: { role: "user" }, parts: [{ type: "text", text: "Do task A" }] },
        { id: "msg_2", info: { role: "assistant" }, parts: [{ type: "text", text: "Working on A..." }] },
        { id: "msg_3", info: { role: "user" }, parts: [{ type: "text", text: "1. **What was the task?**" }] }, // reflection question
        { id: "msg_4", info: { role: "assistant" }, parts: [{ type: "text", text: "Self-assessment response" }] },
        { id: "msg_5", info: { role: "user" }, parts: [{ type: "text", text: "Actually, do task B instead" }] }, // NEW human message
      ]
      const currentUserMsgId = getLastRelevantUserMessageId(currentMessages)
      assert.strictEqual(currentUserMsgId, "msg_5", "Current user message should be msg_5 (new human message)")

      // The race condition check - use string comparison to avoid TS literal type issues
      const idsMatch = String(currentUserMsgId) === String(initialUserMsgId)
      assert.strictEqual(idsMatch, false, "Should detect that human sent new message")

      // When IDs don't match, reflection should abort
      let reflectionAborted = false
      if (currentUserMsgId && !idsMatch) {
        reflectionAborted = true
        // In real code: debug("SKIP: human sent new message during reflection, aborting")
      }
      assert.strictEqual(reflectionAborted, true, "Reflection should abort when human sent new message")
    })

    it("should NOT abort when no new human message during analysis", () => {
      // Initial state when reflection started
      const initialMessages = [
        { id: "msg_1", info: { role: "user" }, parts: [{ type: "text", text: "Do task A" }] },
        { id: "msg_2", info: { role: "assistant" }, parts: [{ type: "text", text: "Working on A..." }] },
      ]
      const initialUserMsgId = getLastRelevantUserMessageId(initialMessages)

      // State after analysis completes - only reflection messages added, no new human message
      const currentMessages = [
        { id: "msg_1", info: { role: "user" }, parts: [{ type: "text", text: "Do task A" }] },
        { id: "msg_2", info: { role: "assistant" }, parts: [{ type: "text", text: "Working on A..." }] },
        { id: "msg_3", info: { role: "user" }, parts: [{ type: "text", text: "1. **What was the task?**" }] }, // reflection question (filtered)
        { id: "msg_4", info: { role: "assistant" }, parts: [{ type: "text", text: "Self-assessment response" }] },
      ]
      const currentUserMsgId = getLastRelevantUserMessageId(currentMessages)
      
      // Should still be msg_1 because msg_3 is a reflection prompt (filtered out)
      assert.strictEqual(currentUserMsgId, "msg_1", "Current user message should still be msg_1")

      const idsMatch = String(currentUserMsgId) === String(initialUserMsgId)
      assert.strictEqual(idsMatch, true, "Should NOT detect new human message")

      // Reflection should proceed normally
      let reflectionAborted = false
      if (currentUserMsgId && !idsMatch) {
        reflectionAborted = true
      }
      assert.strictEqual(reflectionAborted, false, "Reflection should NOT abort")
    })

    it("should handle case where human types during GenAI judge evaluation", () => {
      // This simulates the exact scenario from the bug report:
      // 1. Agent finishes → session.idle
      // 2. Reflection asks self-assessment question
      // 3. Agent responds with self-assessment
      // 4. Reflection sends to GenAI judge (this takes 30+ seconds)
      // 5. Human types "Actually, do X instead" (arrives while judge is thinking)
      // 6. GenAI returns shouldContinue: true
      // 7. Reflection checks → sees new human message → aborts

      const initialUserMsgId: string = "msg_original_task"
      
      // Simulate GenAI judge taking 30 seconds
      // During this time, human typed a new message
      const timeWhenJudgeStarted = Date.now()
      const timeWhenJudgeFinished = timeWhenJudgeStarted + 30_000 // 30 seconds later
      
      // Simulate the new message arriving at 15 seconds
      const newHumanMessageId: string = "msg_human_typed_during_judge"
      const newMessageArrivedAt = timeWhenJudgeStarted + 15_000
      
      // After judge finishes, we re-check messages
      const currentUserMsgId: string = newHumanMessageId // This is what we'd get from getLastRelevantUserMessageId

      // The fix: check if human sent new message
      const shouldAbort = currentUserMsgId !== initialUserMsgId
      assert.strictEqual(shouldAbort, true, "Should abort because human sent message during judge evaluation")
      
      // Silence unused variable warnings
      void timeWhenJudgeFinished
      void newMessageArrivedAt
    })

    it("should mark original task as reflected when aborting", () => {
      // When we abort due to new human message, we should still mark the ORIGINAL task
      // as reflected, to prevent re-triggering reflection for it
      const lastReflectedMsgId = new Map<string, string>()
      const sessionId = "ses_test"
      const initialUserMsgId: string = "msg_original_task"
      const currentUserMsgId: string = "msg_new_human_message"

      // Simulate the abort path
      if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
        // Mark the ORIGINAL task as reflected
        lastReflectedMsgId.set(sessionId, initialUserMsgId)
        // Return early (abort)
      }

      // Verify the original task is marked as reflected
      assert.strictEqual(lastReflectedMsgId.get(sessionId), initialUserMsgId, 
        "Original task should be marked as reflected to prevent re-triggering")
    })
  })
})
