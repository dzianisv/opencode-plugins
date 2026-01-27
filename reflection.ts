/**
 * Reflection Plugin for OpenCode
 *
 * Simple judge layer: when session idles, ask LLM if task is complete.
 * If not, send feedback to continue.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join } from "path"

const MAX_ATTEMPTS = 16
const JUDGE_RESPONSE_TIMEOUT = 180_000
const POLL_INTERVAL = 2_000
const DEBUG = process.env.REFLECTION_DEBUG === "1"
const SESSION_CLEANUP_INTERVAL = 300_000 // Clean old sessions every 5 minutes
const SESSION_MAX_AGE = 1800_000 // Sessions older than 30 minutes can be cleaned
const STUCK_CHECK_DELAY = 30_000 // Check if agent is stuck 30 seconds after prompt

// Debug logging (only when REFLECTION_DEBUG=1)
function debug(...args: any[]) {
  if (DEBUG) console.error("[Reflection]", ...args)
}

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  
  // Track attempts per (sessionId, humanMsgCount) - resets automatically for new messages
  const attempts = new Map<string, number>()
  // Track which human message count we last completed reflection on
  const lastReflectedMsgCount = new Map<string, number>()
  const activeReflections = new Set<string>()
  // Track aborted message counts per session - only skip reflection for the aborted task, not future tasks
  const abortedMsgCounts = new Map<string, Set<number>>()
  const judgeSessionIds = new Set<string>() // Track judge session IDs to skip them
  // Track session last-seen timestamps for cleanup
  const sessionTimestamps = new Map<string, number>()
  // Track sessions that have pending nudge timers (to avoid duplicate nudges)
  const pendingNudges = new Map<string, { timer: NodeJS.Timeout; reason: "reflection" | "compression" }>()
  // Track sessions that were recently compacted (to prompt GitHub update)
  const recentlyCompacted = new Set<string>()
  // Track sessions that were recently aborted (Esc key) - prevents race condition
  // where session.idle fires before abort error is written to message
  // Maps sessionId -> timestamp of abort (for cooldown-based cleanup)
  const recentlyAbortedSessions = new Map<string, number>()
  const ABORT_COOLDOWN = 10_000 // 10 second cooldown before allowing reflection again
  
  // Periodic cleanup of old session data to prevent memory leaks
  const cleanupOldSessions = () => {
    const now = Date.now()
    for (const [sessionId, timestamp] of sessionTimestamps) {
      if (now - timestamp > SESSION_MAX_AGE) {
        // Clean up all data for this old session
        sessionTimestamps.delete(sessionId)
        lastReflectedMsgCount.delete(sessionId)
        abortedMsgCounts.delete(sessionId)
        // Clean attempt keys for this session
        for (const key of attempts.keys()) {
          if (key.startsWith(sessionId)) attempts.delete(key)
        }
        // Clean pending nudges for this session
        const nudgeData = pendingNudges.get(sessionId)
        if (nudgeData) {
          clearTimeout(nudgeData.timer)
          pendingNudges.delete(sessionId)
        }
        recentlyCompacted.delete(sessionId)
        recentlyAbortedSessions.delete(sessionId)
        debug("Cleaned up old session:", sessionId.slice(0, 8))
      }
    }
  }
  setInterval(cleanupOldSessions, SESSION_CLEANUP_INTERVAL)

  // Directory for storing reflection input/output
  const reflectionDir = join(directory, ".reflection")
  
  // Cache for AGENTS.md content (avoid re-reading on every reflection)
  let agentsFileCache: { content: string; timestamp: number } | null = null
  const AGENTS_CACHE_TTL = 60_000 // Cache for 1 minute

  async function ensureReflectionDir(): Promise<void> {
    try {
      await mkdir(reflectionDir, { recursive: true })
    } catch {}
  }

  async function saveReflectionData(sessionId: string, data: {
    task: string
    result: string
    tools: string
    prompt: string
    verdict: { 
      complete: boolean
      severity: string
      feedback: string
      missing?: string[]
      next_actions?: string[]
    } | null
    timestamp: string
  }): Promise<void> {
    await ensureReflectionDir()
    const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
    const filepath = join(reflectionDir, filename)
    try {
      await writeFile(filepath, JSON.stringify(data, null, 2))
    } catch {}
  }

  /**
   * Write a verdict signal file for TTS/Telegram coordination.
   * This allows TTS to know whether to speak/notify after reflection completes.
   * File format: { sessionId, complete, severity, timestamp }
   */
  async function writeVerdictSignal(sessionId: string, complete: boolean, severity: string): Promise<void> {
    await ensureReflectionDir()
    const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
    const signal = {
      sessionId: sessionId.slice(0, 8),
      complete,
      severity,
      timestamp: Date.now()
    }
    try {
      await writeFile(signalPath, JSON.stringify(signal))
      debug("Wrote verdict signal:", signalPath, signal)
    } catch (e) {
      debug("Failed to write verdict signal:", e)
    }
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

  async function getAgentsFile(): Promise<string> {
    // Return cached content if still valid
    if (agentsFileCache && Date.now() - agentsFileCache.timestamp < AGENTS_CACHE_TTL) {
      return agentsFileCache.content
    }
    
    for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
      try {
        const content = await readFile(join(directory, name), "utf-8")
        agentsFileCache = { content, timestamp: Date.now() }
        return content
      } catch {}
    }
    agentsFileCache = { content: "", timestamp: Date.now() }
    return ""
  }

  function isJudgeSession(sessionId: string, messages: any[]): boolean {
    // Fast path: known judge session
    if (judgeSessionIds.has(sessionId)) return true
    
    // Content-based detection
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  // Check if the CURRENT task (identified by human message count) was aborted
  // Returns true only if the most recent assistant response for this task was aborted
  // This allows reflection to run on NEW tasks after an abort
  function wasCurrentTaskAborted(sessionId: string, messages: any[], humanMsgCount: number): boolean {
    // Fast path: check if this specific message count was already marked as aborted
    const abortedCounts = abortedMsgCounts.get(sessionId)
    if (abortedCounts?.has(humanMsgCount)) return true
    
    // Check if the LAST assistant message has an abort error
    // Only the last message matters - previous aborts don't block new tasks
    const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
    if (!lastAssistant) return false
    
    const error = lastAssistant.info?.error
    if (!error) return false
    
    // Check for MessageAbortedError
    if (error.name === "MessageAbortedError") {
      // Mark this specific message count as aborted
      if (!abortedMsgCounts.has(sessionId)) {
        abortedMsgCounts.set(sessionId, new Set())
      }
      abortedMsgCounts.get(sessionId)!.add(humanMsgCount)
      debug("Marked task as aborted:", sessionId.slice(0, 8), "msgCount:", humanMsgCount)
      return true
    }
    
    // Also check error message content for abort indicators
    const errorMsg = error.data?.message || error.message || ""
    if (typeof errorMsg === "string" && errorMsg.toLowerCase().includes("abort")) {
      if (!abortedMsgCounts.has(sessionId)) {
        abortedMsgCounts.set(sessionId, new Set())
      }
      abortedMsgCounts.get(sessionId)!.add(humanMsgCount)
      debug("Marked task as aborted:", sessionId.slice(0, 8), "msgCount:", humanMsgCount)
      return true
    }
    
    return false
  }

  function countHumanMessages(messages: any[]): number {
    let count = 0
    for (const msg of messages) {
      if (msg.info?.role === "user") {
        // Don't count reflection feedback as human input
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text && !part.text.includes("## Reflection:")) {
            count++
            break
          }
        }
      }
    }
    return count
  }

  function extractTaskAndResult(messages: any[]): { task: string; result: string; tools: string; isResearch: boolean } | null {
    let originalTask = ""  // First human message (the actual request)
    let latestTask = ""    // Latest human message (may be follow-up)
    let result = ""
    const tools: string[] = []

    for (const msg of messages) {
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            if (part.text.includes("## Reflection:")) continue
            // Track both first and latest human messages
            if (!originalTask) {
              originalTask = part.text  // First human message is the original task
            }
            latestTask = part.text  // Keep updating for latest
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

    // Use original task for evaluation, but include latest context if different
    const task = originalTask === latestTask 
      ? originalTask 
      : `Original request: ${originalTask}\n\nLatest user message: ${latestTask}`
    
    // Detect research-only tasks (no code expected)
    const isResearch = /research|explore|investigate|analyze|review|study|compare|evaluate/i.test(originalTask) &&
                       /do not|don't|no code|research only|just research|only research/i.test(originalTask)

    debug("extractTaskAndResult - task empty?", !task, "result empty?", !result, "isResearch?", isResearch)
    if (!originalTask || !result) return null
    return { task, result, tools: tools.slice(-10).join("\n"), isResearch }
  }

  async function waitForResponse(sessionId: string): Promise<string | null> {
    const start = Date.now()
    while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        const assistantMsg = [...(messages || [])].reverse().find((m: any) => m.info?.role === "assistant")
        if (!(assistantMsg?.info?.time as any)?.completed) continue
        for (const part of assistantMsg?.parts || []) {
          if (part.type === "text" && part.text) return part.text
        }
      } catch {}
    }
    return null
  }

  // Generate a key for tracking attempts per task (session + human message count)
  function getAttemptKey(sessionId: string, humanMsgCount: number): string {
    return `${sessionId}:${humanMsgCount}`
  }

  // Check if a session is currently idle (agent not responding)
  async function isSessionIdle(sessionId: string): Promise<boolean> {
    try {
      const { data: statuses } = await client.session.status({ query: { directory } })
      if (!statuses) return true // Assume idle on no data
      const status = statuses[sessionId]
      // Session is idle if status type is "idle" or if not found
      return !status || status.type === "idle"
    } catch {
      return true // Assume idle on error
    }
  }

  // Nudge a stuck session to continue working
  async function nudgeSession(sessionId: string, reason: "reflection" | "compression"): Promise<void> {
    // Clear any pending nudge timer
    const existing = pendingNudges.get(sessionId)
    if (existing) {
      clearTimeout(existing.timer)
      pendingNudges.delete(sessionId)
    }

    // Check if session is actually idle/stuck
    if (!(await isSessionIdle(sessionId))) {
      debug("Session not idle, skipping nudge:", sessionId.slice(0, 8))
      return
    }

    // Skip judge sessions (aborted tasks are handled per-task in runReflection)
    if (judgeSessionIds.has(sessionId)) {
      debug("Session is judge, skipping nudge:", sessionId.slice(0, 8))
      return
    }

    debug("Nudging stuck session:", sessionId.slice(0, 8), "reason:", reason)

    let nudgeMessage: string
    if (reason === "compression") {
      // After compression, prompt to update GitHub PR/issue
      nudgeMessage = `Context was just compressed. Before continuing with the task:

1. **If you have an active GitHub PR or issue for this work**, please add a comment summarizing:
   - What has been completed so far
   - Current status and any blockers
   - Next steps planned

2. Then continue with the original task.

Use \`gh pr comment\` or \`gh issue comment\` to add the update.`
    } else {
      // After reflection feedback, nudge to continue
      nudgeMessage = `Please continue working on the task. The reflection feedback above indicates there are outstanding items to address.`
    }

    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: nudgeMessage }]
        }
      })
      await showToast(reason === "compression" ? "Prompted GitHub update" : "Nudged agent to continue", "info")
    } catch (e) {
      debug("Failed to nudge session:", e)
    }
  }

  // Schedule a nudge after a delay (for stuck detection)
  // NOTE: Only one nudge per session is supported. If a new nudge is scheduled
  // before the existing one fires, the existing one is replaced.
  // This is intentional: compression nudges should fire before reflection runs,
  // and reflection nudges replace any stale compression nudges.
  function scheduleNudge(sessionId: string, delay: number, reason: "reflection" | "compression"): void {
    // Clear any existing timer (warn if replacing a different type)
    const existing = pendingNudges.get(sessionId)
    if (existing) {
      if (existing.reason !== reason) {
        debug("WARNING: Replacing", existing.reason, "nudge with", reason, "nudge for session:", sessionId.slice(0, 8))
      }
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(async () => {
      pendingNudges.delete(sessionId)
      debug("Nudge timer fired for session:", sessionId.slice(0, 8), "reason:", reason)
      await nudgeSession(sessionId, reason)
    }, delay)

    pendingNudges.set(sessionId, { timer, reason })
    debug("Scheduled nudge for session:", sessionId.slice(0, 8), "delay:", delay, "reason:", reason)
  }

  // Cancel a pending nudge (called when session becomes active)
  // onlyReason: if specified, only cancel nudges with this reason
  function cancelNudge(sessionId: string, onlyReason?: "reflection" | "compression"): void {
    const nudgeData = pendingNudges.get(sessionId)
    if (nudgeData) {
      // If onlyReason is specified, only cancel if reason matches
      if (onlyReason && nudgeData.reason !== onlyReason) {
        debug("Not cancelling nudge - reason mismatch:", nudgeData.reason, "!=", onlyReason)
        return
      }
      clearTimeout(nudgeData.timer)
      pendingNudges.delete(sessionId)
      debug("Cancelled pending nudge for session:", sessionId.slice(0, 8), "reason:", nudgeData.reason)
    }
  }

  async function runReflection(sessionId: string): Promise<void> {
    debug("runReflection called for session:", sessionId)
    
    // Capture when this reflection started - used to detect aborts during judge evaluation
    const reflectionStartTime = Date.now()
    
    // Prevent concurrent reflections on same session
    if (activeReflections.has(sessionId)) {
      debug("SKIP: activeReflections already has session")
      return
    }
    activeReflections.add(sessionId)

    try {
      // Get messages first - needed for all checks
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) {
        debug("SKIP: messages length < 2, got:", messages?.length)
        return
      }

      // Skip judge sessions
      if (isJudgeSession(sessionId, messages)) {
        debug("SKIP: is judge session")
        return
      }

      // Count human messages to determine current "task"
      const humanMsgCount = countHumanMessages(messages)
      debug("humanMsgCount:", humanMsgCount)
      if (humanMsgCount === 0) {
        debug("SKIP: no human messages")
        return
      }

      // Skip if current task was aborted/cancelled by user (Esc key)
      // This only skips the specific aborted task, not future tasks in the same session
      if (wasCurrentTaskAborted(sessionId, messages, humanMsgCount)) {
        debug("SKIP: current task was aborted")
        return
      }

      // Check if we already completed reflection for this exact message count
      const lastReflected = lastReflectedMsgCount.get(sessionId) || 0
      if (humanMsgCount <= lastReflected) {
        debug("SKIP: already reflected for this message count", { humanMsgCount, lastReflected })
        return
      }

      // Get attempt count for THIS specific task (session + message count)
      const attemptKey = getAttemptKey(sessionId, humanMsgCount)
      const attemptCount = attempts.get(attemptKey) || 0
      debug("attemptCount:", attemptCount, "/ MAX:", MAX_ATTEMPTS)
      
      if (attemptCount >= MAX_ATTEMPTS) {
        // Max attempts for this task - mark as reflected and stop
        lastReflectedMsgCount.set(sessionId, humanMsgCount)
        await showToast(`Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
        debug("SKIP: max attempts reached")
        return
      }

      // Extract task info
      const extracted = extractTaskAndResult(messages)
      if (!extracted) {
        debug("SKIP: extractTaskAndResult returned null")
        return
      }
      debug("extracted task length:", extracted.task.length, "result length:", extracted.result.length)

      // Create judge session and evaluate
      const { data: judgeSession } = await client.session.create({
        query: { directory }
      })
      if (!judgeSession?.id) return

      // Track judge session ID to skip it if session.idle fires on it
      judgeSessionIds.add(judgeSession.id)

      // Helper to clean up judge session (always called)
      const cleanupJudgeSession = async () => {
        try {
          await client.session.delete({ 
            path: { id: judgeSession.id },
            query: { directory }
          })
        } catch (e) {
          // Log deletion failures for debugging (but don't break the flow)
          console.error(`[Reflection] Failed to delete judge session ${judgeSession.id}:`, e)
        } finally {
          judgeSessionIds.delete(judgeSession.id)
        }
      }

      try {
        const agents = await getAgentsFile()
        
        // Build task-appropriate evaluation rules
        const researchRules = extracted.isResearch ? `
### Research Task Rules (APPLIES TO THIS TASK)
This is a RESEARCH task - the user explicitly requested investigation/analysis without code changes.
- Do NOT require tests, builds, or code changes
- Do NOT push the agent to write code when research was requested
- Complete = research findings delivered with reasonable depth
- Truncated display is NOT a failure (responses may be cut off in UI but agent completed the work)
- If agent provided research findings, mark complete: true
- Only mark incomplete if the agent clearly failed to research the topic
` : ""

        const codingRules = !extracted.isResearch ? `
### Coding Task Rules
1. All explicitly requested functionality implemented
2. Tests run and pass (if tests were requested or exist)
3. Build/compile succeeds (if applicable)
4. No unhandled errors in output

### Evidence Requirements
Every claim needs evidence. Reject claims like "ready", "verified", "working", "fixed" without:
- Actual command output showing success
- Test name + result
- File changes made

### Flaky Test Protocol
If a test is called "flaky" or "unrelated", require at least ONE of:
- Rerun with pass (show output)
- Quarantine/skip with tracking ticket
- Replacement test validating same requirement
- Stabilization fix applied
Without mitigation → severity >= HIGH, complete: false

### Waiver Protocol
If a required gate failed but agent claims ready, response MUST include:
- Explicit waiver statement ("shipping with known issue X")
- Impact scope ("affects Y users/flows")
- Mitigation/rollback plan
- Follow-up tracking (ticket/issue reference)
Without waiver details → complete: false
` : ""

        // Increase result size for better judgment (was 2000, now 4000)
        const resultPreview = extracted.result.slice(0, 4000)
        const truncationNote = extracted.result.length > 4000 
          ? `\n\n[NOTE: Response truncated from ${extracted.result.length} chars - agent may have provided more content]`
          : ""

        const prompt = `TASK VERIFICATION

Evaluate whether the agent completed what the user asked for.

${agents ? `## Project Instructions\n${agents.slice(0, 1500)}\n` : ""}
## User's Request
${extracted.task}

## Tools Used
${extracted.tools || "(none)"}

## Agent's Response
${resultPreview}${truncationNote}

---

## Evaluation Rules

### Task Type
${extracted.isResearch ? "This is a RESEARCH task (no code expected)" : "This is a CODING/ACTION task"}

### Severity Levels
- BLOCKER: security, auth, billing/subscription, data loss, E2E broken, prod health broken → complete MUST be false
- HIGH: major functionality degraded, CI red without approved waiver
- MEDIUM: partial degradation or uncertain coverage
- LOW: cosmetic / non-impacting
- NONE: no issues
${researchRules}${codingRules}

### Progress Status Detection
If the agent's response contains explicit progress indicators like:
- "IN PROGRESS", "in progress", "not yet committed"
- "Next steps:", "Remaining tasks:", "TODO:"
- "Phase X of Y complete" (where X < Y)
- "Continue to Phase N", "Proceed to step N"
Then the task is INCOMPLETE (complete: false) regardless of other indicators.
The agent must finish all stated work, not just report status.

### Delegation/Deferral Detection
If the agent's response asks the user to choose or act instead of completing the task:
- "What would you like me to do?"
- "Which option would you prefer?"
- "Let me know if you want me to..."
- "I can help you with..." followed by numbered options
- Presenting options (1. 2. 3.) without taking action

HOWEVER, if the original task REQUIRES user decisions (design choices, preferences, clarifications),
then asking questions is CORRECT behavior. In this case:
- Set complete: false (task is not done yet)
- Set severity: NONE (agent is correctly waiting for user input, no issues)
This signals that the agent should wait for the user, not be pushed to continue.

### Temporal Consistency
Reject if:
- Readiness claimed before verification ran
- Later output contradicts earlier "done" claim
- Failures downgraded after-the-fact without new evidence

---

Reply with JSON only (no other text):
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation of verdict",
  "missing": ["list of missing required steps or evidence"],
  "next_actions": ["concrete commands or checks to run"]
}`

        await client.session.promptAsync({
          path: { id: judgeSession.id },
          body: { parts: [{ type: "text", text: prompt }] }
        })
        debug("judge prompt sent, waiting for response...")

        const response = await waitForResponse(judgeSession.id)
        
        if (!response) {
          debug("SKIP: waitForResponse returned null (timeout)")
          // Timeout - mark this task as reflected to avoid infinite retries
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          return
        }
        debug("judge response received, length:", response.length)

        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
          debug("SKIP: no JSON found in response")
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          return
        }

        const verdict = JSON.parse(jsonMatch[0])
        debug("verdict:", JSON.stringify(verdict))

        // Save reflection data to .reflection/ directory
        await saveReflectionData(sessionId, {
          task: extracted.task,
          result: extracted.result.slice(0, 4000),
          tools: extracted.tools || "(none)",
          prompt,
          verdict,
          timestamp: new Date().toISOString()
        })

        // Normalize severity and enforce BLOCKER rule
        const severity = verdict.severity || "MEDIUM"
        const isBlocker = severity === "BLOCKER"
        const isComplete = verdict.complete && !isBlocker

        // Write verdict signal for TTS/Telegram coordination
        // This must be written BEFORE any prompts/toasts so TTS can read it
        await writeVerdictSignal(sessionId, isComplete, severity)

        if (isComplete) {
          // COMPLETE: mark this task as reflected, show toast only (no prompt!)
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          attempts.delete(attemptKey)
          const toastMsg = severity === "NONE" ? "Task complete ✓" : `Task complete ✓ (${severity})`
          await showToast(toastMsg, "success")
        } else {
          // INCOMPLETE: Check if session was aborted AFTER this reflection started
          // This prevents feedback injection when user pressed Esc while judge was running
          const abortTime = recentlyAbortedSessions.get(sessionId)
          if (abortTime && abortTime > reflectionStartTime) {
            debug("SKIP feedback: session was aborted after reflection started", 
              "abortTime:", abortTime, "reflectionStart:", reflectionStartTime)
            lastReflectedMsgCount.set(sessionId, humanMsgCount)  // Mark as reflected to prevent retry
            return
          }
          
          // SPECIAL CASE: severity NONE but incomplete means agent is waiting for user input
          // (e.g., asking clarifying questions, presenting options for user to choose)
          // Don't push feedback in this case - let the user respond naturally
          if (severity === "NONE") {
            debug("SKIP feedback: severity NONE means waiting for user input")
            lastReflectedMsgCount.set(sessionId, humanMsgCount)  // Mark as reflected
            await showToast("Awaiting user input", "info")
            return
          }
          
          // INCOMPLETE: increment attempts and send feedback
          attempts.set(attemptKey, attemptCount + 1)
          const toastVariant = isBlocker ? "error" : "warning"
          await showToast(`${severity}: Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})`, toastVariant)
          
          // Build structured feedback message
          const missing = verdict.missing?.length 
            ? `\n### Missing\n${verdict.missing.map((m: string) => `- ${m}`).join("\n")}`
            : ""
          const nextActions = verdict.next_actions?.length
            ? `\n### Next Actions\n${verdict.next_actions.map((a: string) => `- ${a}`).join("\n")}`
            : ""
          
          await client.session.promptAsync({
            path: { id: sessionId },
            body: {
              parts: [{
                type: "text",
                text: `## Reflection: Task Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS}) [${severity}]

${verdict.feedback || "Please review and complete the task."}${missing}${nextActions}

Please address the above and continue.`
              }]
            }
          })
          // Schedule a nudge in case the agent gets stuck after receiving feedback
          scheduleNudge(sessionId, STUCK_CHECK_DELAY, "reflection")
          // Don't mark as reflected yet - we want to check again after agent responds
        }
      } finally {
        // Always clean up judge session to prevent clutter in /session list
        await cleanupJudgeSession()
      }
    } catch (e) {
      // On error, don't mark as reflected - allow retry
      debug("ERROR in runReflection:", e)
    } finally {
      activeReflections.delete(sessionId)
    }
  }

  return {
    // Tool definition required by Plugin interface (reflection operates via events, not tools)
    tool: {
      reflection: {
        name: 'reflection',
        description: 'Judge layer that evaluates task completion - operates via session.idle events',
        execute: async () => 'Reflection plugin active - evaluation triggered on session idle'
      }
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type, (event as any).properties?.sessionID?.slice(0, 8))
      
      // Track aborted sessions immediately when session.error fires - cancel any pending nudges
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          // Track abort in memory to prevent race condition with session.idle
          // (session.idle may fire before the abort error is written to the message)
          recentlyAbortedSessions.set(sessionId, Date.now())
          // Cancel nudges for this session
          cancelNudge(sessionId)
          debug("Session aborted, added to recentlyAbortedSessions:", sessionId.slice(0, 8))
        }
      }
      
      // Handle session status changes - cancel reflection nudges when session becomes busy
      // BUT keep compression nudges so they can fire after agent finishes
      if (event.type === "session.status") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const status = props?.status
        if (sessionId && status?.type === "busy") {
          // Agent is actively working, cancel only reflection nudges
          // Keep compression nudges - they should fire after agent finishes to prompt GitHub update
          cancelNudge(sessionId, "reflection")
        }
      }
      
      // Handle compression/compaction - immediately nudge to prompt GitHub update
      // This must happen SYNCHRONOUSLY before session.idle fires, otherwise
      // reflection may run first and the compression context is lost
      if (event.type === "session.compacted") {
        const sessionId = (event as any).properties?.sessionID
        debug("session.compacted received for:", sessionId)
        if (sessionId && typeof sessionId === "string") {
          // Skip judge sessions
          if (judgeSessionIds.has(sessionId)) {
            debug("SKIP compaction handling: is judge session")
            return
          }
          // Mark as recently compacted
          recentlyCompacted.add(sessionId)
          
          // Wait a short time for session to settle, then nudge
          // Using setTimeout directly (not scheduleNudge) to avoid being replaced
          setTimeout(async () => {
            // Double-check session is still valid and idle
            if (!(await isSessionIdle(sessionId))) {
              debug("Session not idle after compression, skipping nudge:", sessionId.slice(0, 8))
              return
            }
            debug("Nudging after compression:", sessionId.slice(0, 8))
            await nudgeSession(sessionId, "compression")
          }, 3000) // 3 second delay to let session stabilize
        }
      }
      
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        debug("session.idle received for:", sessionId)
        if (sessionId && typeof sessionId === "string") {
          // Update timestamp for cleanup tracking
          sessionTimestamps.set(sessionId, Date.now())
          
          // Only cancel reflection nudges when session goes idle
          // Keep compression nudges so they can fire and prompt GitHub update
          cancelNudge(sessionId, "reflection")
          
          // Fast path: skip judge sessions
          if (judgeSessionIds.has(sessionId)) {
            debug("SKIP: session in judgeSessionIds set")
            return
          }
          
          // Fast path: skip recently aborted sessions (prevents race condition)
          // session.error fires with MessageAbortedError, but session.idle may fire
          // before the error is written to the message data
          // Use cooldown instead of immediate delete to handle rapid Esc presses
          const abortTime = recentlyAbortedSessions.get(sessionId)
          if (abortTime) {
            const elapsed = Date.now() - abortTime
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
  }
}

export default ReflectionPlugin
