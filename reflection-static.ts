/**
 * Reflection Static Plugin for OpenCode
 *
 * Simple static question-based reflection: when session idles, ask the agent
 * "What was the task? Are you sure you completed it? If not, why did you stop?"
 * 
 * Uses GenAI to analyze the agent's self-assessment and determine completion.
 * If agent says task is complete, stops. If agent sees improvements, pushes it.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { join } from "path"

const DEBUG = process.env.REFLECTION_DEBUG === "1"
const JUDGE_RESPONSE_TIMEOUT = 120_000
const POLL_INTERVAL = 2_000
const ABORT_COOLDOWN = 10_000 // 10 second cooldown after Esc before allowing reflection

function debug(...args: any[]) {
  if (DEBUG) console.error("[ReflectionStatic]", ...args)
}

const STATIC_QUESTION = `
1. **What was the task?** (Summarize what the user asked you to do)
2. **Are you sure you completed it?** (Yes/No with confidence level)
3. **If you didn't complete it, why did you stop?**
4. **What improvements or next steps could be made?**
Be specific and honest. If you're uncertain about completion, say so.`

/**
 * Load custom reflection prompt from ./reflection.md in the working directory.
 * Falls back to STATIC_QUESTION if file doesn't exist or can't be read.
 */
async function loadReflectionPrompt(directory: string): Promise<string> {
  try {
    const reflectionPath = join(directory, "reflection.md")
    const customPrompt = await readFile(reflectionPath, "utf-8")
    debug("Loaded custom prompt from reflection.md")
    return customPrompt.trim()
  } catch (e) {
    // File doesn't exist or can't be read - use default
    return STATIC_QUESTION
  }
}

export const ReflectionStaticPlugin: Plugin = async ({ client, directory }) => {
  // Track sessions to prevent duplicate reflection
  const reflectedSessions = new Set<string>()
  // Track judge session IDs to skip them
  const judgeSessionIds = new Set<string>()
  // Track sessions where agent confirmed completion
  const confirmedComplete = new Set<string>()
  // Track aborted sessions with timestamps (cooldown-based to handle rapid Esc presses)
  const recentlyAbortedSessions = new Map<string, number>()
  // Count human messages per session
  const lastReflectedMsgId = new Map<string, string>()
  // Active reflections to prevent concurrent processing
  const activeReflections = new Set<string>()

  function getMessageSignature(msg: any): string {
    if (msg.id) return msg.id
    // Fallback signature if ID is missing
    const role = msg.info?.role || "unknown"
    const time = msg.info?.time?.start || 0
    const textPart = msg.parts?.find((p: any) => p.type === "text")?.text?.slice(0, 20) || ""
    return `${role}:${time}:${textPart}`
  }

  function getLastRelevantUserMessageId(messages: any[]): string | null {
    // Iterate backwards to find the last user message that isn't a reflection prompt
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "user") {
        let isReflection = false
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
             // Check for static question
             if (part.text.includes("1. **What was the task?**")) {
               isReflection = true
               break
             }
             // Check for other internal prompts if any (e.g. analysis prompts are usually in judge session, not here)
          }
        }
        if (!isReflection) {
          return getMessageSignature(msg)
        }
      }
    }
    return null
  }

  function isJudgeSession(sessionId: string, messages: any[]): boolean {
    if (judgeSessionIds.has(sessionId)) return true
    
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("ANALYZE AGENT RESPONSE")) {
          return true
        }
      }
    }
    return false
  }

  function isPlanMode(messages: any[]): boolean {
    // 1. Check for System/Developer messages indicating Plan Mode
    const hasSystemPlanMode = messages.some((m: any) => 
      (m.info?.role === "system" || m.info?.role === "developer") && 
      m.parts?.some((p: any) => 
        p.type === "text" && 
        p.text && 
        (p.text.includes("Plan Mode") || 
         p.text.includes("plan mode ACTIVE") ||
         p.text.includes("read-only mode"))
      )
    )
    if (hasSystemPlanMode) {
      debug("Plan Mode detected from system/developer message")
      return true
    }

    // 2. Check user intent for plan-related queries
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "user") {
        let isReflection = false
        let text = ""
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
             text = part.text
             if (part.text.includes("1. **What was the task?**")) {
               isReflection = true
               break
             }
          }
        }
        if (!isReflection && text) {
          if (/plan mode/i.test(text)) return true
          if (/\b(create|make|draft|generate|propose|write|update)\b.{1,30}\bplan\b/i.test(text)) return true
          if (/^plan\b/i.test(text.trim())) return true
          return false
        }
      }
    }
    return false
  }

  async function showToast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      await client.tui.publish({
        query: { directory },
        body: {
          type: "tui.toast.show",
          properties: { title: "Reflection", message, variant, duration: 5000 }
        }
      })
    } catch {}
  }

  async function waitForResponse(sessionId: string): Promise<string | null> {
    const start = Date.now()
    debug("waitForResponse started for session:", sessionId.slice(0, 8))
    let pollCount = 0
    while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      pollCount++
      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        const assistantMsg = [...(messages || [])].reverse().find((m: any) => m.info?.role === "assistant")
        if (!(assistantMsg?.info?.time as any)?.completed) {
          if (pollCount % 5 === 0) debug("waitForResponse poll", pollCount, "- not completed yet")
          continue
        }
        for (const part of assistantMsg?.parts || []) {
          if (part.type === "text" && part.text) {
            debug("waitForResponse got response after", pollCount, "polls")
            return part.text
          }
        }
      } catch (e) {
        debug("waitForResponse poll error:", e)
      }
    }
    debug("waitForResponse TIMEOUT after", pollCount, "polls")
    return null
  }

  /**
   * Analyze the agent's self-assessment using GenAI
   * Returns: { complete: boolean, shouldContinue: boolean, reason: string }
   */
  async function analyzeResponse(selfAssessment: string): Promise<{
    complete: boolean
    shouldContinue: boolean
    reason: string
  }> {
    const { data: judgeSession } = await client.session.create({
      query: { directory }
    })
    if (!judgeSession?.id) {
      return { complete: false, shouldContinue: false, reason: "Failed to create judge session" }
    }

    judgeSessionIds.add(judgeSession.id)

    try {
      const analyzePrompt = `ANALYZE AGENT RESPONSE

You are analyzing an agent's self-assessment of task completion.

## Agent's Self-Assessment:
${selfAssessment.slice(0, 3000)}

## Analysis Instructions:
Evaluate the agent's response and determine:
1. Did the agent confirm the task is FULLY COMPLETE with 100% confidence?
2. Did the agent identify ANY remaining work, improvements, or uncommitted changes?
3. Should the agent continue working?

Return JSON only:
{
  "complete": true/false,      // Agent believes task is 100% fully complete with NO remaining work
  "shouldContinue": true/false, // Agent identified ANY improvements or work they can do
  "reason": "brief explanation"
}

Rules:
- complete: true ONLY if agent explicitly says task is 100% done with nothing remaining
- If confidence is below 100% (e.g., "85% confident") -> complete: false, shouldContinue: true
- If agent asks "should I do X?" -> that means X is NOT done -> shouldContinue: true
- If agent says "I did NOT commit" or mentions uncommitted changes -> shouldContinue: true (agent should commit)
- If agent lists "next steps" or "improvements" -> shouldContinue: true
- If agent explicitly says they need user input to proceed -> complete: false, shouldContinue: false
- When in doubt, shouldContinue: true (push agent to finish)`

      debug("Sending analysis prompt to judge session:", judgeSession.id.slice(0, 8))
      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body: { parts: [{ type: "text", text: analyzePrompt }] }
      })

      debug("Waiting for judge response...")
      const response = await waitForResponse(judgeSession.id)
      
      if (!response) {
        debug("Judge timeout - no response received")
        return { complete: false, shouldContinue: false, reason: "Judge timeout" }
      }

      debug("Judge response received, length:", response.length)
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        debug("No JSON found in response:", response.slice(0, 200))
        return { complete: false, shouldContinue: false, reason: "No JSON in response" }
      }

      try {
        const result = JSON.parse(jsonMatch[0])
        debug("Parsed analysis result:", JSON.stringify(result))
        return {
          complete: !!result.complete,
          shouldContinue: !!result.shouldContinue,
          reason: result.reason || "No reason provided"
        }
      } catch (parseError) {
        debug("JSON parse error:", parseError, "text:", jsonMatch[0].slice(0, 100))
        return { complete: false, shouldContinue: false, reason: "JSON parse error" }
      }
    } finally {
      // Cleanup judge session
      try {
        await client.session.delete({ 
          path: { id: judgeSession.id },
          query: { directory }
        })
      } catch {}
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  async function runReflection(sessionId: string): Promise<void> {
    debug("runReflection called for session:", sessionId.slice(0, 8))
    
    // Capture when this reflection started - used to detect aborts during judge evaluation
    const reflectionStartTime = Date.now()
    
    if (activeReflections.has(sessionId)) {
      debug("SKIP: active reflection in progress")
      return
    }
    activeReflections.add(sessionId)

    try {
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) {
        debug("SKIP: not enough messages")
        return
      }

      // Check if last assistant message was aborted/incomplete
      const lastAssistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
      if (lastAssistantMsg) {
        const metadata = lastAssistantMsg.info?.time as any
        // Skip if message was not completed properly
        if (!metadata?.completed) {
          debug("SKIP: last message not completed")
          return
        }
        // Skip if message has an error (including abort)
        const error = (lastAssistantMsg.info as any)?.error
        if (error) {
          debug("SKIP: last message has error:", error?.name || error?.message)
          return
        }
      }

      if (isJudgeSession(sessionId, messages)) {
        debug("SKIP: is judge session")
        return
      }

      if (isPlanMode(messages)) {
        debug("SKIP: plan mode detected")
        return
      }

      const lastUserMsgId = getLastRelevantUserMessageId(messages)
      if (!lastUserMsgId) {
        debug("SKIP: no relevant human messages")
        return
      }

      // Skip if already reflected for this message ID
      const lastReflectedId = lastReflectedMsgId.get(sessionId)
      if (lastUserMsgId === lastReflectedId) {
        debug("SKIP: already reflected for this task ID:", lastUserMsgId)
        return
      }

      // Reset confirmedComplete if we have a NEW user message
      if (lastUserMsgId !== lastReflectedId && confirmedComplete.has(sessionId)) {
        debug("New human message detected, resetting confirmedComplete status")
        confirmedComplete.delete(sessionId)
      }

      // Skip if already confirmed complete for this session
      if (confirmedComplete.has(sessionId)) {
        debug("SKIP: agent already confirmed complete")
        return
      }

      // Step 1: Ask the static question (or custom prompt from reflection.md)
      debug("Asking static self-assessment question...")
      await showToast("Asking for self-assessment...", "info")

      const reflectionPrompt = await loadReflectionPrompt(directory)

      await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: reflectionPrompt }] }
      })

      // Wait for agent's self-assessment
      const selfAssessment = await waitForResponse(sessionId)
      
      if (!selfAssessment) {
        debug("SKIP: no self-assessment response")
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        return
      }
      debug("Got self-assessment, length:", selfAssessment.length)

      // Step 2: Analyze the response with GenAI
      debug("Analyzing self-assessment with GenAI...")
      const analysis = await analyzeResponse(selfAssessment)
      debug("Analysis result:", JSON.stringify(analysis))

      // Step 3: Act on the analysis
      if (analysis.complete) {
        // Agent says task is complete - stop here
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        confirmedComplete.add(sessionId)
        await showToast("Task confirmed complete", "success")
        debug("Agent confirmed task complete, stopping")
      } else if (analysis.shouldContinue) {
        // Agent identified improvements - push them to continue
        // NOTE: We do NOT update lastReflectedMsgId here.
        // This ensures that when the agent finishes the pushed work (and idles),
        // we re-run reflection to verify the new state (which will still map to the same user Msg ID,
        // or a new one if we consider the push as a user message).
        
        // Actually, if "Push" is a user message, getLastRelevantUserMessageId will return IT next time.
        // So we don't need to manually block the update.
        // BUT, if we want to reflect on the RESULT of the push, we should let the loop happen.
        // If we update lastReflectedMsgId here, and next time getLastRelevantUserMessageId returns the SAME id (because push is the last one),
        // we would skip.
        // Wait, "Please continue..." IS a user message.
        // So next time, lastUserMsgId will be the ID of "Please continue...".
        // It will differ from the current lastUserMsgId (which is the original request).
        // So we will reflect again.
        // So it is SAFE to update lastReflectedMsgId here?
        // No, if we update it here to "Original Request ID", and next time we see "Push ID", we reflect. Correct.
        // What if we DON'T update it?
        // Next time we see "Push ID". "Push ID" != "Original Request ID". We reflect. Correct.
        
        // The only risk is if "Push" message is NOT considered a relevant user message (e.g. if we filter it out).
        // My filter is `!part.text.includes("1. **What was the task?**")`.
        // "Please continue..." passes this filter. So it IS a relevant user message.
        
        // So we can just let the natural logic handle it.
        // I will NOT update it here just to be safe and consistent with previous logic
        // (treating the "Push" phase as part of the same transaction until completion).
        
        await showToast("Pushing agent to continue...", "info")
        debug("Pushing agent to continue improvements")
        
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { 
            parts: [{ 
              type: "text", 
              text: `Please continue with the improvements and next steps you identified. Complete the remaining work.`
            }] 
          }
        })
      } else {
        // Agent stopped for valid reason (needs user input, etc.)
        lastReflectedMsgId.set(sessionId, lastUserMsgId)
        await showToast(`Stopped: ${analysis.reason}`, "warning")
        debug("Agent stopped for valid reason:", analysis.reason)
      }

    } catch (e) {
      debug("ERROR in runReflection:", e)
    } finally {
      activeReflections.delete(sessionId)
    }
  }

  return {
    tool: {
      reflection: {
        name: 'reflection-static',
        description: 'Simple static question reflection - asks agent to self-assess completion',
        execute: async () => 'Reflection-static plugin active - triggers on session idle'
      }
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type)

      // Track aborts from session.error (Esc key press) with timestamp for cooldown
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionId, Date.now())
          debug("Session aborted (Esc), cooldown started:", sessionId.slice(0, 8))
        }
      }

      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        debug("session.idle for:", sessionId?.slice(0, 8))
        
        if (sessionId && typeof sessionId === "string") {
          // Skip judge sessions
          if (judgeSessionIds.has(sessionId)) {
            debug("SKIP: is judge session ID")
            return
          }

          // Skip recently aborted sessions (cooldown-based to handle race conditions)
          const abortTime = recentlyAbortedSessions.get(sessionId)
          if (abortTime) {
            const elapsed = Date.now() - abortTime
            if (elapsed < ABORT_COOLDOWN) {
              debug("SKIP: session was recently aborted (Esc)", elapsed, "ms ago, cooldown:", ABORT_COOLDOWN)
              return  // Don't delete - cooldown still active
            }
            // Cooldown expired, clean up
            recentlyAbortedSessions.delete(sessionId)
            debug("Abort cooldown expired, allowing reflection")
          }

          await runReflection(sessionId)
        }
      }
    }
  }
}

export default ReflectionStaticPlugin
