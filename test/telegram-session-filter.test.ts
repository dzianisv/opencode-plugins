/**
 * Telegram Plugin Session Filtering Tests
 *
 * Verifies that internal reflection/judge/classification sessions are correctly
 * filtered out and never posted to Telegram. Covers issue #73.
 *
 * Run with: npx jest test/telegram-session-filter.test.ts
 */
import { describe, it, expect } from "@jest/globals"
import {
  isJudgeSession,
  isSessionComplete,
  extractFinalResponse,
  findStaticReflectionPromptIndex,
  INTERNAL_SESSION_MARKERS,
} from "../telegram.test-helpers.ts"

// Helper to create a mock message
function msg(role: string, text: string, opts?: { completed?: boolean; error?: boolean }): any {
  const m: any = {
    info: { role },
    parts: [{ type: "text", text }],
  }
  if (opts?.completed !== undefined) {
    m.info.time = { completed: opts.completed ? Date.now() : undefined }
  }
  if (opts?.error) {
    m.info.error = "some error"
  }
  return m
}

// ============================================================================
// isJudgeSession — internal session detection
// ============================================================================
describe("isJudgeSession", () => {
  it("returns false for a normal user session", () => {
    const messages = [
      msg("user", "Fix the login bug in auth.ts"),
      msg("assistant", "I'll fix the login bug.", { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(false)
  })

  it("returns false for empty messages", () => {
    expect(isJudgeSession([])).toBe(false)
  })

  it("detects reflection-3 judge sessions (ANALYZE REFLECTION-3)", () => {
    const messages = [
      msg("user", "ANALYZE REFLECTION-3\n\nYou are validating an agent's self-assessment..."),
      msg("assistant", '{"complete": true, "severity": "NONE"}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects reflection-3 self-assessment sessions (SELF-ASSESS REFLECTION-3)", () => {
    const messages = [
      msg("user", "SELF-ASSESS REFLECTION-3\n\nPlease evaluate your own work..."),
      msg("assistant", '{"status": "complete", "confidence": 0.9}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects reflection-3 cross-model review sessions (REVIEW REFLECTION-3 COMPLETION)", () => {
    const messages = [
      msg("user", "REVIEW REFLECTION-3 COMPLETION\n\nYou are reviewing another model's completion verdict..."),
      msg("assistant", "The self-assessment appears justified. No gaps found.", { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects reflection-3 routing classifier sessions (CLASSIFY TASK ROUTING)", () => {
    const messages = [
      msg("user", "CLASSIFY TASK ROUTING\n\nYou are classifying a task into one routing category.\n\nTask summary: Fix the login bug"),
      msg("assistant", '{"category": "backend"}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects legacy judge sessions (TASK VERIFICATION)", () => {
    const messages = [
      msg("user", "TASK VERIFICATION\n\nEvaluate whether the agent completed what the user asked for."),
      msg("assistant", '{"complete": true}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects legacy judge sessions (You are a judge)", () => {
    const messages = [
      msg("user", "You are a judge evaluating an agent's work."),
      msg("assistant", '{"verdict": "pass"}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects legacy judge sessions (Task to evaluate)", () => {
    const messages = [
      msg("user", "Task to evaluate: Fix the login bug\n\nAgent response: ..."),
      msg("assistant", '{"verdict": "pass"}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects markers in ANY message, not just the first user message", () => {
    // Marker appears in the second user message (e.g. after context injection)
    const messages = [
      msg("user", "Some initial context setup"),
      msg("assistant", "OK, ready."),
      msg("user", "ANALYZE REFLECTION-3\n\nEvaluate..."),
      msg("assistant", '{"complete": true}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("detects markers in assistant messages too", () => {
    // Edge case: marker echoed by assistant
    const messages = [
      msg("user", "Do something"),
      msg("assistant", "I see you want TASK VERIFICATION..."),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("does not false-positive on similar but different text", () => {
    const messages = [
      msg("user", "Can you analyze reflection patterns in this code?"),
      msg("assistant", "Sure, let me look at the reflection patterns.", { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(false)
  })

  it("handles messages without text parts", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "tool", tool: "bash" }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash" }] },
    ]
    expect(isJudgeSession(messages)).toBe(false)
  })

  it("handles messages with no parts", () => {
    const messages = [
      { info: { role: "user" }, parts: [] },
      { info: { role: "assistant" } },
    ]
    expect(isJudgeSession(messages)).toBe(false)
  })

  // Verify all markers are covered
  it("covers all INTERNAL_SESSION_MARKERS", () => {
    for (const marker of INTERNAL_SESSION_MARKERS) {
      const messages = [msg("user", `${marker}\n\nSome prompt text`)]
      expect(isJudgeSession(messages)).toBe(true)
    }
  })
})

// ============================================================================
// isSessionComplete
// ============================================================================
describe("isSessionComplete", () => {
  it("returns true when last assistant has completed timestamp", () => {
    const messages = [
      msg("user", "Hello"),
      msg("assistant", "Hi there!", { completed: true }),
    ]
    expect(isSessionComplete(messages)).toBe(true)
  })

  it("returns false when last assistant has no completed timestamp", () => {
    const messages = [
      msg("user", "Hello"),
      msg("assistant", "Hi there!", { completed: false }),
    ]
    expect(isSessionComplete(messages)).toBe(false)
  })

  it("returns false when last assistant has error", () => {
    const messages = [
      msg("user", "Hello"),
      msg("assistant", "Partial response...", { completed: true, error: true }),
    ]
    expect(isSessionComplete(messages)).toBe(false)
  })

  it("returns false when no assistant messages", () => {
    const messages = [msg("user", "Hello")]
    expect(isSessionComplete(messages)).toBe(false)
  })
})

// ============================================================================
// extractFinalResponse — skip reflection artifacts
// ============================================================================
describe("extractFinalResponse", () => {
  it("extracts the last assistant text from a normal session", () => {
    const messages = [
      msg("user", "Fix the bug"),
      msg("assistant", "I've fixed the bug in auth.ts."),
    ]
    expect(extractFinalResponse(messages)).toBe("I've fixed the bug in auth.ts.")
  })

  it("skips reflection self-assessment prompt and returns pre-reflection response", () => {
    const messages = [
      msg("user", "Fix the bug"),
      msg("assistant", "I've fixed the bug in auth.ts."),
      msg("user", "## Reflection-3 Self-Assessment\n\nPlease assess your work..."),
      msg("assistant", '{"status": "complete", "confidence": 0.9}'),
    ]
    expect(extractFinalResponse(messages)).toBe("I've fixed the bug in auth.ts.")
  })

  it("skips reflection feedback prompt", () => {
    const messages = [
      msg("user", "Fix the bug"),
      msg("assistant", "I've fixed the bug."),
      msg("user", "## Reflection-3:\n\nYour work is incomplete..."),
      msg("assistant", "OK, I'll continue working..."),
    ]
    expect(extractFinalResponse(messages)).toBe("I've fixed the bug.")
  })

  it("returns empty string when no assistant messages", () => {
    const messages = [msg("user", "Hello")]
    expect(extractFinalResponse(messages)).toBe("")
  })
})

// ============================================================================
// Regression: old markers vs new markers  
// ============================================================================
describe("regression: issue #73 - reflection sessions not filtered", () => {
  it("ANALYZE REFLECTION-3 sessions were NOT caught by old isJudgeSession", () => {
    // This documents the bug: old code only checked first user message for
    // "You are a judge" or "Task to evaluate"
    const messages = [
      msg("user", "ANALYZE REFLECTION-3\n\nEvaluate..."),
      msg("assistant", '{"complete": true}', { completed: true }),
    ]
    // The NEW implementation correctly catches this
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("CLASSIFY TASK ROUTING sessions were NOT caught by old isJudgeSession", () => {
    const messages = [
      msg("user", 'CLASSIFY TASK ROUTING\n\nTask: Fix bug\n\nReturn JSON: {"category": "backend"}'),
      msg("assistant", '{"category": "backend"}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("real-world classification session scenario", () => {
    // Simulates what reflection-3 actually sends
    const messages = [
      msg("user", `CLASSIFY TASK ROUTING\n\nYou are classifying a task into one routing category.\n\nTask summary:\nFix the login bug in auth.ts\n\nTask type: coding\n\nRecent user messages:\nFix the login bug in auth.ts\n\nChoose exactly one category from: backend, architecture, frontend, default.\nReturn JSON only:\n{\n  "category": "backend|architecture|frontend|default"\n}`),
      msg("assistant", '{\n  "category": "backend"\n}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })

  it("real-world judge session scenario", () => {
    // Simulates what reflection-3 actually sends
    const messages = [
      msg("user", `ANALYZE REFLECTION-3\n\nYou are validating an agent's self-assessment against workflow requirements.\n\n## Task Summary\nFix the login bug\n\n## Task Type\ncoding\n\n## Agent Self-Assessment\n{"status":"complete","confidence":0.9}\n\nReturn JSON only:\n{\n  "complete": true/false,\n  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",\n  "feedback": "brief explanation"\n}`),
      msg("assistant", '{\n  "complete": true,\n  "severity": "NONE",\n  "feedback": "Task completed successfully"\n}', { completed: true }),
    ]
    expect(isJudgeSession(messages)).toBe(true)
  })
})
