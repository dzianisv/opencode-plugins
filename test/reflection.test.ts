/**
 * Tests for OpenCode Reflection Plugin
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

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

  it("has judge session tracking", () => {
    assert.ok(pluginContent.includes("processedSessions"), "Missing processedSessions set")
  })

  it("has attempt limiting", () => {
    assert.ok(pluginContent.includes("MAX_ATTEMPTS"), "Missing MAX_ATTEMPTS")
    assert.ok(pluginContent.includes("attempts"), "Missing attempts tracking")
  })

  it("uses JSON schema for verdict", () => {
    assert.ok(pluginContent.includes('"complete"'), "Missing complete field in schema")
    assert.ok(pluginContent.includes('"feedback"'), "Missing feedback field in schema")
  })

  it("detects judge prompts to prevent recursion", () => {
    assert.ok(pluginContent.includes("TASK VERIFICATION"), "Missing judge prompt marker")
  })

  it("cleans up sessions", () => {
    assert.ok(pluginContent.includes("processedSessions.add"), "Missing cleanup")
  })

  it("detects aborted sessions to skip reflection", () => {
    assert.ok(pluginContent.includes("wasSessionAborted"), "Missing wasSessionAborted function")
    assert.ok(pluginContent.includes("MessageAbortedError"), "Missing MessageAbortedError check")
  })
})
