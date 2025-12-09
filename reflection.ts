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

// Track reflection attempts per session to limit retries
const reflectionAttempts = new Map<string, number>()
const MAX_REFLECTION_ATTEMPTS = 3

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
   */
  function extractInitialTask(messages: any[]): string {
    // Find the first user message
    for (const msg of messages) {
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            return part.text
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
   * Main reflection logic - called when a session becomes idle
   */
  async function runReflection(sessionID: string): Promise<void> {
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

    try {
      reflectingSessions.add(sessionID)
      console.log(`[Reflection] Starting reflection for session ${sessionID} (attempt ${attempts + 1})`)

      // Get session messages
      const messagesResponse = await client.session.messages({
        path: { sessionID },
      })
      const messages = messagesResponse.data || []

      if (messages.length < 2) {
        console.log("[Reflection] Not enough messages to reflect on")
        return
      }

      // Build reflection context
      const context: ReflectionContext = {
        initialTask: extractInitialTask(messages),
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
      const judgeSessionID = judgeSessionResponse.data?.id

      if (!judgeSessionID) {
        console.error("[Reflection] Failed to create judge session")
        return
      }

      console.log(`[Reflection] Created judge session: ${judgeSessionID}`)

      // Send the judge prompt
      const judgePrompt = buildJudgePrompt(context)
      const judgeResponse = await client.session.prompt({
        path: { id: judgeSessionID },
        body: {
          parts: [{ type: "text", text: judgePrompt }],
        },
      })

      // Extract judge's response
      const judgeMessages = await client.session.messages({
        path: { sessionID: judgeSessionID },
      })

      let judgeResponseText = ""
      const judgeData = judgeMessages.data || []
      for (let i = judgeData.length - 1; i >= 0; i--) {
        const msg = judgeData[i]
        if (msg.info?.role === "assistant") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              judgeResponseText = part.text
              break
            }
          }
          if (judgeResponseText) break
        }
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

        // Send the feedback to continue the session
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: feedbackMessage }],
          },
        })
      } else {
        // Task passed - clean up
        console.log(`[Reflection] Task completed successfully!`)
        reflectionAttempts.delete(sessionID)
      }

    } catch (error) {
      console.error(`[Reflection] Error during reflection:`, error)
    } finally {
      reflectingSessions.delete(sessionID)
    }
  }

  return {
    // Listen for session events
    event: async ({ event }) => {
      // Trigger reflection when session becomes idle
      if (event.type === "session.idle") {
        const sessionID = (event as any).properties?.sessionID
        if (sessionID) {
          // Small delay to ensure all messages are persisted
          setTimeout(() => runReflection(sessionID), 1000)
        }
      }

      // Alternative: trigger on session.status change to idle
      if (event.type === "session.status") {
        const props = (event as any).properties
        if (props?.status?.type === "idle" && props?.sessionID) {
          setTimeout(() => runReflection(props.sessionID), 1000)
        }
      }
    },
  }
}

// Export as default for OpenCode plugin loader
export default ReflectionPlugin
