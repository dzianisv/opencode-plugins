/**
 * Reflection Plugin for OpenCode
 *
 * This plugin implements a "judge" layer that verifies if an agent completed
 * a task correctly. After the agent finishes, it:
 * 1. Collects the initial task, last 10 tool calls, thoughts, and final result
 * 2. Sends this to the LLM to judge if the task was completed correctly
 * 3. If not, provides feedback and forces the agent to continue
 *
 * Place this file in: .opencode/plugin/reflection.ts
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { join } from "path"

interface ToolCallInfo {
  tool: string
  input: Record<string, unknown>
  output?: string
  status: string
  duration?: number
}

interface ReflectionContext {
  initialTask: string
  agentInstructions: string
  toolCalls: ToolCallInfo[]
  thoughts: string[]
  finalResult: string
  sessionID: string
}

// Track sessions we're currently reflecting on to avoid infinite loops
const reflectingSessions = new Set<string>()

// Track judge sessions to exclude them from reflection
const judgeSessions = new Set<string>()

// Track reflection attempts per session to limit retries
const reflectionAttempts = new Map<string, number>()
const MAX_REFLECTION_ATTEMPTS = 3

// Timeout for waiting for judge response (3 minutes - Opus 4.5 can be slow)
const JUDGE_RESPONSE_TIMEOUT = 180_000
const POLL_INTERVAL = 2_000

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  console.log("[Reflection] Plugin initialized")

  /**
   * Read AGENTS.md content from project directory
   */
  async function getAgentInstructions(): Promise<string> {
    const possiblePaths = [
      join(directory, "AGENTS.md"),
      join(directory, ".opencode", "AGENTS.md"),
      join(directory, "agents.md"),
    ]

    for (const path of possiblePaths) {
      try {
        const content = await readFile(path, "utf-8")
        return content
      } catch {
        // File doesn't exist, try next
      }
    }
    return "(No AGENTS.md found)"
  }

  /**
   * Extract the initial task from session messages
   * Returns null if this looks like a judge session (task starts with judge prompt)
   */
  function extractInitialTask(messages: any[]): string | null {
    // Find the first user message
    for (const msg of messages) {
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            const text = part.text
            // Skip if this looks like a judge prompt (recursive detection)
            if (text.includes("You are a strict task verification judge") ||
                text.includes("VERDICT:") ||
                text.includes("## YOUR TASK\n\nEvaluate whether")) {
              return null // This is a judge session, not a real task
            }
            return text
          }
        }
      }
    }
    return "(No initial task found)"
  }

  /**
   * Extract the last N tool calls from messages
   */
  function extractToolCalls(messages: any[], limit: number = 10): ToolCallInfo[] {
    const toolCalls: ToolCallInfo[] = []

    // Iterate in reverse to get most recent first
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
            duration: state.time?.end && state.time?.start
              ? state.time.end - state.time.start
              : undefined,
          })
        }
      }
    }

    return toolCalls
  }

  /**
   * Extract reasoning/thoughts from messages
   */
  function extractThoughts(messages: any[]): string[] {
    const thoughts: string[] = []

    for (const msg of messages) {
      if (msg.info?.role === "assistant") {
        for (const part of msg.parts || []) {
          if (part.type === "reasoning" && part.text) {
            thoughts.push(part.text)
          }
        }
      }
    }

    // Return last 5 thoughts
    return thoughts.slice(-5)
  }

  /**
   * Extract the final result/response from the last assistant message
   */
  function extractFinalResult(messages: any[]): string {
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        const textParts: string[] = []
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text)
          }
        }
        if (textParts.length > 0) {
          return textParts.join("\n")
        }
      }
    }
    return "(No final result found)"
  }

  /**
   * Build the judge prompt
   */
  function buildJudgePrompt(context: ReflectionContext): string {
    const toolCallsSummary = context.toolCalls.map((tc, i) => {
      const inputStr = JSON.stringify(tc.input, null, 2).slice(0, 500)
      const outputStr = tc.output ? tc.output.slice(0, 300) : "(no output)"
      return `${i + 1}. **${tc.tool}** [${tc.status}]
   Input: ${inputStr}
   Output: ${outputStr}
   ${tc.duration ? `Duration: ${tc.duration}ms` : ""}`
    }).join("\n\n")

    const thoughtsSummary = context.thoughts.length > 0
      ? context.thoughts.map((t, i) => `${i + 1}. ${t.slice(0, 300)}...`).join("\n")
      : "(No reasoning captured)"

    return `You are a strict task verification judge. Your job is to determine if an AI agent completed a user's task correctly and completely.

## AGENT INSTRUCTIONS (from AGENTS.md)
${context.agentInstructions.slice(0, 2000)}

## USER'S ORIGINAL TASK
${context.initialTask}

## LAST ${context.toolCalls.length} TOOL CALLS
${toolCallsSummary}

## AGENT'S REASONING/THOUGHTS
${thoughtsSummary}

## AGENT'S FINAL RESPONSE
${context.finalResult.slice(0, 2000)}

---

## YOUR TASK

Evaluate whether the agent FULLY completed the user's task. Consider:
1. Did the agent address ALL parts of the user's request?
2. Were the tool calls appropriate and successful?
3. Is the final response accurate and complete?
4. Are there any obvious errors, omissions, or incomplete work?

Respond in this EXACT format:

VERDICT: [PASS or FAIL]

REASONING: [Your detailed analysis - 2-3 sentences]

FEEDBACK: [If FAIL, specific actionable feedback for the agent to continue. If PASS, write "Task completed successfully."]`
  }

  /**
   * Parse the judge's response
   */
  function parseJudgeResponse(response: string): {
    pass: boolean
    reasoning: string
    feedback: string
  } {
    const verdictMatch = response.match(/VERDICT:\s*(PASS|FAIL)/i)
    const reasoningMatch = response.match(/REASONING:\s*(.+?)(?=FEEDBACK:|$)/is)
    const feedbackMatch = response.match(/FEEDBACK:\s*(.+)$/is)

    return {
      pass: verdictMatch?.[1]?.toUpperCase() === "PASS",
      reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
      feedback: feedbackMatch?.[1]?.trim() || "No feedback provided",
    }
  }

  /**
   * Wait for a session to complete and return the assistant's response
   */
  async function waitForJudgeResponse(
    judgeSessionID: string,
    timeoutMs: number = JUDGE_RESPONSE_TIMEOUT
  ): Promise<string | null> {
    const startTime = Date.now()
    let lastMessageCount = 0
    let stableCount = 0

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check if session is still busy
        const statusResponse = await client.session.status({})
        const statusArray = statusResponse.data as any[] | undefined
        const isBusy = Array.isArray(statusArray) && statusArray.some(
          (s: any) => s?.sessionID === judgeSessionID || s?.id === judgeSessionID
        )

        // Get messages
        const messagesResponse = await client.session.messages({
          path: { id: judgeSessionID },
        })
        const messages = messagesResponse.data || []

        // Look for assistant response
        let assistantText = ""
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.info?.role === "assistant") {
            for (const part of msg.parts || []) {
              if (part.type === "text" && part.text) {
                assistantText = part.text
                break
              }
            }
            if (assistantText) break
          }
        }

        // Check if stable: not busy and messages haven't changed
        if (!isBusy && messages.length === lastMessageCount && assistantText) {
          stableCount++
          if (stableCount >= 3) {
            return assistantText
          }
        } else {
          stableCount = 0
        }

        lastMessageCount = messages.length
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
      } catch (error) {
        console.log("[Reflection] Error polling judge session:", error)
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
      }
    }

    console.log("[Reflection] Timeout waiting for judge response")
    return null
  }

  /**
   * Main reflection logic - called when a session becomes idle
   */
  async function runReflection(sessionID: string): Promise<void> {
    // Skip judge sessions (defense in depth - should already be caught in event handler)
    if (judgeSessions.has(sessionID)) {
      console.log(`[Reflection] Session ${sessionID} is a judge session, skipping`)
      return
    }

    // Prevent infinite loops
    if (reflectingSessions.has(sessionID)) {
      console.log(`[Reflection] Already reflecting on session ${sessionID}, skipping`)
      return
    }

    // Check attempt limit
    const attempts = reflectionAttempts.get(sessionID) || 0
    if (attempts >= MAX_REFLECTION_ATTEMPTS) {
      console.log(`[Reflection] Max attempts (${MAX_REFLECTION_ATTEMPTS}) reached for session ${sessionID}`)
      reflectionAttempts.delete(sessionID)
      return
    }

    // Mark as reflecting BEFORE any async operations
    reflectingSessions.add(sessionID)

    // Track judge session ID for cleanup
    let judgeSessionID: string | undefined

    try {
      // Log after marking as reflecting to reduce spurious logs
      console.log(`[Reflection] Starting reflection for session ${sessionID} (attempt ${attempts + 1})`)

      // Get session messages
      const messagesResponse = await client.session.messages({
        path: { id: sessionID },
      })
      const messages = messagesResponse.data || []

      if (messages.length < 2) {
        console.log("[Reflection] Not enough messages to reflect on")
        return
      }

      // Extract initial task - returns null if this looks like a judge session
      const initialTask = extractInitialTask(messages)
      if (initialTask === null) {
        console.log(`[Reflection] Session ${sessionID} detected as judge session by content, skipping`)
        return
      }

      // Build reflection context
      const context: ReflectionContext = {
        initialTask,
        agentInstructions: await getAgentInstructions(),
        toolCalls: extractToolCalls(messages, 10),
        thoughts: extractThoughts(messages),
        finalResult: extractFinalResult(messages),
        sessionID,
      }

      // Skip if no meaningful work was done
      if (context.toolCalls.length === 0 && context.finalResult === "(No final result found)") {
        console.log("[Reflection] No meaningful work to reflect on")
        return
      }

      // Create a new session for the judge
      const judgeSessionResponse = await client.session.create({})
      judgeSessionID = judgeSessionResponse.data?.id

      if (!judgeSessionID) {
        console.error("[Reflection] Failed to create judge session")
        return
      }

      // Mark this as a judge session IMMEDIATELY to prevent recursive reflection
      judgeSessions.add(judgeSessionID)
      console.log(`[Reflection] Created judge session: ${judgeSessionID}`)

      // Send the judge prompt using async API and poll for completion
      // This avoids timeout issues with slower models like Opus 4.5
      const judgePrompt = buildJudgePrompt(context)
      let judgeResponseText = ""

      try {
        // Use promptAsync to avoid blocking timeout
        const promptResponse = await client.session.promptAsync({
          path: { id: judgeSessionID },
          body: {
            parts: [{ type: "text", text: judgePrompt }],
          },
        })

        if (promptResponse.error) {
          console.error("[Reflection] Error sending judge prompt:", promptResponse.error)
          return
        }

        console.log("[Reflection] Judge prompt sent, waiting for response...")

        // Poll for the judge response with extended timeout
        judgeResponseText = await waitForJudgeResponse(judgeSessionID) || ""
      } catch (error) {
        console.error("[Reflection] Error getting judge response:", error)
        return
      }

      if (!judgeResponseText) {
        console.log("[Reflection] No judge response received")
        return
      }

      console.log(`[Reflection] Judge response:\n${judgeResponseText.slice(0, 500)}...`)

      // Parse the verdict
      const verdict = parseJudgeResponse(judgeResponseText)
      console.log(`[Reflection] Verdict: ${verdict.pass ? "PASS" : "FAIL"}`)
      console.log(`[Reflection] Reasoning: ${verdict.reasoning}`)

      if (!verdict.pass) {
        // Increment attempt counter
        reflectionAttempts.set(sessionID, attempts + 1)

        // Send feedback to the original session
        const feedbackMessage = `## Reflection Feedback (Attempt ${attempts + 1}/${MAX_REFLECTION_ATTEMPTS})

Your work has been reviewed and found **incomplete**. Please continue.

**Issue:** ${verdict.reasoning}

**Required Action:** ${verdict.feedback}

Please address the feedback above and complete the original task fully.`

        console.log(`[Reflection] Sending feedback to session ${sessionID}`)

        // Remove from reflecting set before sending to allow the next reflection
        reflectingSessions.delete(sessionID)

        // Send the feedback to continue the session (use async to avoid timeout)
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: feedbackMessage }],
          },
        })
        // Note: We don't wait for this response - the session.idle event will
        // trigger another reflection when the agent finishes addressing the feedback
      } else {
        // Task passed - clean up
        console.log(`[Reflection] Task completed successfully!`)
        reflectionAttempts.delete(sessionID)
      }

    } catch (error) {
      console.error(`[Reflection] Error during reflection:`, error)
    } finally {
      reflectingSessions.delete(sessionID)
      // Clean up judge session tracking after reflection is fully complete
      if (judgeSessionID) {
        judgeSessions.delete(judgeSessionID)
      }
    }
  }

  /**
   * Quick check if a session should be skipped for reflection
   * Returns: "judge" if it's a judge session, "empty" if too few messages, null if ok to reflect
   */
  async function shouldSkipSession(sessionID: string): Promise<"judge" | "empty" | null> {
    try {
      const messagesResponse = await client.session.messages({
        path: { id: sessionID },
      })
      const messages = messagesResponse.data || []

      // Skip sessions with too few messages (newly created, possibly judge sessions)
      // A valid session to reflect on should have at least user message + assistant response
      const userMessages = messages.filter((m: any) => m.info?.role === "user").length
      const assistantMessages = messages.filter((m: any) => m.info?.role === "assistant").length

      if (userMessages === 0 || assistantMessages === 0) {
        return "empty"
      }

      // Check first user message for judge prompt markers
      for (const msg of messages) {
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              const text = part.text
              if (text.includes("You are a strict task verification judge") ||
                  text.includes("VERDICT:") ||
                  text.includes("## YOUR TASK\n\nEvaluate whether")) {
                return "judge"
              }
            }
          }
          break // Only check first user message
        }
      }
    } catch {
      // If we can't fetch messages, skip to be safe
      return "empty"
    }
    return null
  }

  return {
    // Listen for session events
    event: async ({ event }) => {
      // Trigger reflection when session becomes idle
      if (event.type === "session.idle") {
        const sessionID = (event as any).properties?.sessionID
        if (sessionID) {
          // Skip judge sessions - check set first (fast path)
          if (judgeSessions.has(sessionID)) {
            console.log(`[Reflection] Skipping judge session ${sessionID} (in set)`)
            return
          }

          // Double-check by examining session content (catches race condition)
          const skipReason = await shouldSkipSession(sessionID)
          if (skipReason === "judge") {
            console.log(`[Reflection] Skipping judge session ${sessionID} (by content)`)
            judgeSessions.add(sessionID) // Add to set for future checks
            return
          }
          if (skipReason === "empty") {
            // Silently skip - this is a newly created session with no real content yet
            return
          }

          // Run reflection (await to ensure completion before process exit)
          await runReflection(sessionID)
        }
      }
    },
  }
}

// Export as default for OpenCode plugin loader
export default ReflectionPlugin
