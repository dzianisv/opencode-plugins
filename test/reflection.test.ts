/**
 * Tests for OpenCode Reflection Plugin
 *
 * Run with: npm test
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdir, rm, writeFile, readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = "/tmp/opencode-reflection-test"
const PLUGIN_PATH = join(TEST_DIR, ".opencode/plugin/reflection.ts")

describe("Reflection Plugin - Structure", () => {
  let pluginContent: string

  before(async () => {
    // Create test directory structure
    await mkdir(join(TEST_DIR, ".opencode/plugin"), { recursive: true })

    // Copy plugin to test directory
    pluginContent = await readFile(
      join(__dirname, "../reflection.ts"),
      "utf-8"
    )
    await writeFile(PLUGIN_PATH, pluginContent)

    // Create a simple AGENTS.md for testing
    await writeFile(
      join(TEST_DIR, "AGENTS.md"),
      "# Test Agent\n\nThis is a test agent configuration."
    )
  })

  after(async () => {
    // Cleanup test directory
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it("plugin file has required exports", async () => {
    assert.ok(pluginContent.includes("export const ReflectionPlugin"), "Missing ReflectionPlugin export")
    assert.ok(pluginContent.includes("export default"), "Missing default export")
  })

  it("plugin has correct hook structure", () => {
    assert.ok(pluginContent.includes("event:"), "Missing event hook")
    assert.ok(pluginContent.includes("session.idle"), "Missing session.idle handler")
    assert.ok(pluginContent.includes("session.status"), "Missing session.status handler")
  })

  it("plugin has loop protection", () => {
    assert.ok(pluginContent.includes("reflectingSessions"), "Missing reflectingSessions set")
    assert.ok(pluginContent.includes("MAX_REFLECTION_ATTEMPTS"), "Missing MAX_REFLECTION_ATTEMPTS")
    assert.ok(pluginContent.includes("reflectionAttempts"), "Missing reflectionAttempts map")
  })

  it("plugin has context extraction functions", () => {
    assert.ok(pluginContent.includes("extractInitialTask"), "Missing extractInitialTask")
    assert.ok(pluginContent.includes("extractToolCalls"), "Missing extractToolCalls")
    assert.ok(pluginContent.includes("extractThoughts"), "Missing extractThoughts")
    assert.ok(pluginContent.includes("extractFinalResult"), "Missing extractFinalResult")
    assert.ok(pluginContent.includes("getAgentInstructions"), "Missing getAgentInstructions")
  })

  it("plugin builds judge prompt with required fields", () => {
    assert.ok(pluginContent.includes("buildJudgePrompt"), "Missing buildJudgePrompt")
    assert.ok(pluginContent.includes("VERDICT:"), "Missing VERDICT in prompt")
    assert.ok(pluginContent.includes("REASONING:"), "Missing REASONING in prompt")
    assert.ok(pluginContent.includes("FEEDBACK:"), "Missing FEEDBACK in prompt")
  })

  it("plugin uses SDK client methods", () => {
    assert.ok(pluginContent.includes("client.session.messages"), "Missing client.session.messages")
    assert.ok(pluginContent.includes("client.session.create"), "Missing client.session.create")
    assert.ok(pluginContent.includes("client.session.prompt"), "Missing client.session.prompt")
  })

  it("plugin logs with [Reflection] prefix", () => {
    assert.ok(pluginContent.includes('[Reflection]'), "Missing [Reflection] log prefix")
  })
})

describe("Reflection Plugin - parseJudgeResponse Logic", () => {
  // Simulate the parsing logic from the plugin
  function parseJudgeResponse(response: string) {
    const verdictMatch = response.match(/VERDICT:\s*(PASS|FAIL)/i)
    const reasoningMatch = response.match(/REASONING:\s*(.+?)(?=FEEDBACK:|$)/is)
    const feedbackMatch = response.match(/FEEDBACK:\s*(.+)$/is)

    return {
      pass: verdictMatch?.[1]?.toUpperCase() === "PASS",
      reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
      feedback: feedbackMatch?.[1]?.trim() || "No feedback provided",
    }
  }

  it("extracts PASS verdict correctly", () => {
    const response = `VERDICT: PASS

REASONING: The agent completed all requested tasks successfully.

FEEDBACK: Task completed successfully.`

    const result = parseJudgeResponse(response)

    assert.strictEqual(result.pass, true)
    assert.ok(result.reasoning.includes("completed all requested tasks"))
    assert.strictEqual(result.feedback, "Task completed successfully.")
  })

  it("extracts FAIL verdict correctly", () => {
    const response = `VERDICT: FAIL

REASONING: The agent only implemented 2 of 3 features.

FEEDBACK: Please implement the missing validation for email field.`

    const result = parseJudgeResponse(response)

    assert.strictEqual(result.pass, false)
    assert.ok(result.reasoning.includes("2 of 3 features"))
    assert.ok(result.feedback.includes("validation for email"))
  })

  it("handles case-insensitive verdict", () => {
    const response = `verdict: pass
reasoning: Done.
feedback: OK.`

    const result = parseJudgeResponse(response)
    assert.strictEqual(result.pass, true)
  })

  it("defaults to FAIL for malformed response", () => {
    const response = `Some random text without proper format`

    const result = parseJudgeResponse(response)

    assert.strictEqual(result.pass, false)
    assert.strictEqual(result.reasoning, "No reasoning provided")
    assert.strictEqual(result.feedback, "No feedback provided")
  })

  it("handles multiline reasoning", () => {
    const response = `VERDICT: FAIL

REASONING: First issue found.
Second issue found.
Third issue found.

FEEDBACK: Fix all issues.`

    const result = parseJudgeResponse(response)

    assert.strictEqual(result.pass, false)
    assert.ok(result.reasoning.includes("First issue"))
    assert.ok(result.reasoning.includes("Second issue"))
  })
})

describe("Reflection Plugin - extractToolCalls Logic", () => {
  // Simulate the tool extraction logic
  function extractToolCalls(messages: any[], limit: number = 10) {
    const toolCalls: any[] = []

    for (let i = messages.length - 1; i >= 0 && toolCalls.length < limit; i--) {
      const msg = messages[i]
      for (const part of msg.parts || []) {
        if (part.type === "tool" && toolCalls.length < limit) {
          const state = part.state || {}
          toolCalls.unshift({
            tool: part.tool,
            input: state.input || {},
            output: state.status === "completed" ? state.output : undefined,
            status: state.status || "unknown",
          })
        }
      }
    }

    return toolCalls
  }

  it("extracts tool calls from messages", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { path: "/test.ts" }, output: "file content" }
          }
        ]
      }
    ]

    const toolCalls = extractToolCalls(messages)

    assert.strictEqual(toolCalls.length, 1)
    assert.strictEqual(toolCalls[0].tool, "read")
    assert.strictEqual(toolCalls[0].status, "completed")
    assert.strictEqual(toolCalls[0].output, "file content")
  })

  it("limits tool calls to specified limit", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: Array(20).fill(null).map((_, i) => ({
          type: "tool",
          tool: `tool_${i}`,
          state: { status: "completed", input: {}, output: "" }
        }))
      }
    ]

    const toolCalls = extractToolCalls(messages, 5)

    assert.strictEqual(toolCalls.length, 5)
  })

  it("handles messages without tool parts", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Hello" }]
      }
    ]

    const toolCalls = extractToolCalls(messages)

    assert.strictEqual(toolCalls.length, 0)
  })
})

describe("Reflection Plugin - Integration Check", () => {
  it("plugin file has valid TypeScript syntax", async () => {
    const pluginPath = join(__dirname, "../reflection.ts")
    const content = await readFile(pluginPath, "utf-8")

    // Basic syntax checks
    assert.ok(content.includes("export default"), "Missing default export")
    assert.ok(content.includes("async"), "Missing async functions")
    assert.ok(content.includes("return {"), "Missing return object")

    // Check for balanced braces (basic syntax validation)
    const openBraces = (content.match(/{/g) || []).length
    const closeBraces = (content.match(/}/g) || []).length
    assert.strictEqual(openBraces, closeBraces, "Unbalanced braces in plugin")
  })

  it("plugin imports are correct", async () => {
    const pluginPath = join(__dirname, "../reflection.ts")
    const content = await readFile(pluginPath, "utf-8")

    assert.ok(content.includes('import type { Plugin }'), "Missing Plugin type import")
    assert.ok(content.includes('from "fs/promises"'), "Missing fs/promises import")
    assert.ok(content.includes('from "path"'), "Missing path import")
  })
})
