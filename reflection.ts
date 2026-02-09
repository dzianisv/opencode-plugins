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
const STUCK_MESSAGE_THRESHOLD = 60_000 // 60 seconds: if last message has no completion, agent is stuck
const COMPRESSION_NUDGE_RETRIES = 5 // Retry compression nudge up to 5 times if agent is busy
const COMPRESSION_RETRY_INTERVAL = 15_000 // Retry compression nudge every 15 seconds
const GENAI_STUCK_CHECK_THRESHOLD = 30_000 // Only use GenAI after 30 seconds of apparent stuck
const GENAI_STUCK_CACHE_TTL = 60_000 // Cache GenAI stuck evaluations for 1 minute
const GENAI_STUCK_TIMEOUT = 30_000 // Timeout for GenAI stuck evaluation (30 seconds)

// Types for GenAI stuck detection
type StuckReason = "genuinely_stuck" | "waiting_for_user" | "working" | "complete" | "error"
interface StuckEvaluation {
  stuck: boolean
  reason: StuckReason
  confidence: number
  shouldNudge: boolean
  nudgeMessage?: string
}

// Types for GenAI post-compression evaluation
type CompressionAction = "needs_github_update" | "continue_task" | "needs_clarification" | "task_complete" | "error"
interface CompressionEvaluation {
  action: CompressionAction
  hasActiveGitWork: boolean
  confidence: number
  nudgeMessage: string
}

// Debug logging (only when REFLECTION_DEBUG=1)
function debug(...args: any[]) {
  if (DEBUG) console.error("[Reflection]", ...args)
}

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  
  // Track attempts per (sessionId, humanMsgId) - resets automatically for new messages
  const attempts = new Map<string, number>()
  // Track which human message ID we last completed reflection on
  const lastReflectedMsgId = new Map<string, string>()
  const activeReflections = new Set<string>()
  // Track aborted message IDs per session - only skip reflection for the aborted task, not future tasks
  const abortedMsgIds = new Map<string, Set<string>>()
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
  
  // Cache for GenAI stuck evaluations (to avoid repeated calls)
  const stuckEvaluationCache = new Map<string, { result: StuckEvaluation; timestamp: number }>()
  
  // Cache for fast model selection (provider -> model)
  let fastModelCache: { providerID: string; modelID: string } | null = null
  let fastModelCacheTime = 0
  const FAST_MODEL_CACHE_TTL = 300_000 // Cache fast model for 5 minutes
  
  // Known fast models per provider (prioritized for quick evaluations)
  const FAST_MODELS: Record<string, string[]> = {
    "anthropic": ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-haiku-4", "claude-haiku-4.5"],
    "openai": ["gpt-4o-mini", "gpt-3.5-turbo"],
    "google": ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-flash"],
    "github-copilot": ["claude-haiku-4.5", "claude-3.5-haiku", "gpt-4o-mini"],
    "azure": ["gpt-4o-mini", "gpt-35-turbo"],
    "bedrock": ["anthropic.claude-3-haiku-20240307-v1:0"],
    "groq": ["llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  }
  
  /**
   * Get a fast model for quick evaluations.
   * Uses config.providers() to find available providers and selects a fast model.
   * Falls back to the default model if no fast model is found.
   */
  async function getFastModel(): Promise<{ providerID: string; modelID: string } | null> {
    // Return cached result if valid
    if (fastModelCache && Date.now() - fastModelCacheTime < FAST_MODEL_CACHE_TTL) {
      return fastModelCache
    }
    
    try {
      const { data } = await client.config.providers({})
      if (!data) return null
      
      const { providers, default: defaults } = data
      
      // Find a provider with available fast models
      for (const provider of providers || []) {
        const providerID = provider.id
        if (!providerID) continue
        
        const fastModelsForProvider = FAST_MODELS[providerID] || []
        // Models might be an object/map or array - get the keys/ids
        const modelsData = provider.models
        const availableModels: string[] = modelsData 
          ? (Array.isArray(modelsData) 
              ? modelsData.map((m: any) => m.id || m) 
              : Object.keys(modelsData))
          : []
        
        // Find the first fast model that's available
        for (const fastModel of fastModelsForProvider) {
          if (availableModels.includes(fastModel)) {
            fastModelCache = { providerID, modelID: fastModel }
            fastModelCacheTime = Date.now()
            debug("Selected fast model:", fastModelCache)
            return fastModelCache
          }
        }
      }
      
      // Fallback: use the first provider's first model (likely the default)
      const firstProvider = providers?.[0]
      if (firstProvider?.id) {
        const modelsData = firstProvider.models
        const firstModelId = modelsData
          ? (Array.isArray(modelsData) 
              ? (modelsData[0]?.id || modelsData[0])
              : Object.keys(modelsData)[0])
          : null
        if (firstModelId) {
          fastModelCache = { 
            providerID: firstProvider.id, 
            modelID: firstModelId 
          }
          fastModelCacheTime = Date.now()
          debug("Using fallback model:", fastModelCache)
          return fastModelCache
        }
      }
      
      return null
    } catch (e) {
      debug("Error getting fast model:", e)
      return null
    }
  }
  
  // Periodic cleanup of old session data to prevent memory leaks
  const cleanupOldSessions = () => {
    const now = Date.now()
    for (const [sessionId, timestamp] of sessionTimestamps) {
      if (now - timestamp > SESSION_MAX_AGE) {
        // Clean up all data for this old session
        sessionTimestamps.delete(sessionId)
        lastReflectedMsgId.delete(sessionId)
        abortedMsgIds.delete(sessionId)
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
             // Check for reflection feedback
             if (part.text.includes("## Reflection:")) {
               isReflection = true
               break
             }
          }
        }
        if (!isReflection) {
          return getMessageSignature(msg)
        }
      }
    }
    return null
  }

  // Check if the CURRENT task (identified by human message ID) was aborted
  // Returns true only if the most recent assistant response for this task was aborted
  // This allows reflection to run on NEW tasks after an abort
  function wasCurrentTaskAborted(sessionId: string, messages: any[], humanMsgId: string): boolean {
    // Fast path: check if this specific message ID was already marked as aborted
    const abortedIds = abortedMsgIds.get(sessionId)
    if (abortedIds?.has(humanMsgId)) return true
    
    // Check if the LAST assistant message has an abort error
    // Only the last message matters - previous aborts don't block new tasks
    const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
    if (!lastAssistant) return false
    
    const error = lastAssistant.info?.error
    if (!error) return false
    
    // Check for MessageAbortedError
    if (error.name === "MessageAbortedError") {
      // Mark this specific message ID as aborted
      if (!abortedMsgIds.has(sessionId)) {
        abortedMsgIds.set(sessionId, new Set())
      }
      abortedMsgIds.get(sessionId)!.add(humanMsgId)
      debug("Marked task as aborted:", sessionId.slice(0, 8), "msgId:", humanMsgId)
      return true
    }
    
    // Also check error message content for abort indicators
    const errorMsg = error.data?.message || error.message || ""
    if (typeof errorMsg === "string" && errorMsg.toLowerCase().includes("abort")) {
      if (!abortedMsgIds.has(sessionId)) {
        abortedMsgIds.set(sessionId, new Set())
      }
      abortedMsgIds.get(sessionId)!.add(humanMsgId)
      debug("Marked task as aborted:", sessionId.slice(0, 8), "msgId:", humanMsgId)
      return true
    }
    
    return false
  }

  function extractTaskAndResult(messages: any[]): { task: string; result: string; tools: string; isResearch: boolean; humanMessages: string[] } | null {
    const humanMessages: string[] = []  // ALL human messages in order (excluding reflection feedback)
    let result = ""
    const tools: string[] = []

    for (const msg of messages) {
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            // Skip reflection feedback messages
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

    // Build task representation from ALL human messages
    // If only one message, use it directly; otherwise format as numbered conversation history
    // NOTE: This ensures the judge evaluates against the EVOLVING task, not just the first message
    const task = humanMessages.length === 1
      ? humanMessages[0]
      : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")
    
    // Detect research-only tasks (check all human messages, not just first)
    const allHumanText = humanMessages.join(" ")
    const isResearch = /research|explore|investigate|analyze|review|study|compare|evaluate/i.test(allHumanText) &&
                       /do not|don't|no code|research only|just research|only research/i.test(allHumanText)

    debug("extractTaskAndResult - humanMessages:", humanMessages.length, "task empty?", !task, "result empty?", !result, "isResearch?", isResearch)
    if (!task || !result) return null
    return { task, result, tools: tools.slice(-10).join("\n"), isResearch, humanMessages }
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

  // Generate a key for tracking attempts per task (session + human message ID)
  function getAttemptKey(sessionId: string, humanMsgId: string): string {
    return `${sessionId}:${humanMsgId}`
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

  /**
   * Check if the last assistant message is stuck (created but not completed).
   * This detects when the agent starts responding but never finishes.
   * Returns: { stuck: boolean, messageAgeMs: number }
   */
  async function isLastMessageStuck(sessionId: string): Promise<{ stuck: boolean; messageAgeMs: number }> {
    try {
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length === 0) {
        return { stuck: false, messageAgeMs: 0 }
      }

      // Find the last assistant message
      const lastMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
      if (!lastMsg) {
        return { stuck: false, messageAgeMs: 0 }
      }

      const created = (lastMsg.info?.time as any)?.created
      const completed = (lastMsg.info?.time as any)?.completed

      // If message has no created time, we can't determine if it's stuck
      if (!created) {
        return { stuck: false, messageAgeMs: 0 }
      }

      const messageAgeMs = Date.now() - created

      // Message is stuck if:
      // 1. It has a created time but no completed time
      // 2. It's been more than STUCK_MESSAGE_THRESHOLD since creation
      // 3. It has 0 output tokens (never generated content)
      const hasNoCompletion = !completed
      const isOldEnough = messageAgeMs > STUCK_MESSAGE_THRESHOLD
      const hasNoOutput = ((lastMsg.info as any)?.tokens?.output ?? 0) === 0

      const stuck = hasNoCompletion && isOldEnough && hasNoOutput

      if (stuck) {
        debug("Detected stuck message:", lastMsg.info?.id?.slice(0, 16), "age:", Math.round(messageAgeMs / 1000), "s")
      }

      return { stuck, messageAgeMs }
    } catch (e) {
      debug("Error checking stuck message:", e)
      return { stuck: false, messageAgeMs: 0 }
    }
  }

  /**
   * Use GenAI to evaluate if a session is stuck and needs nudging.
   * This is more accurate than static heuristics because it can understand:
   * - Whether the agent asked a question (waiting for user)
   * - Whether a tool call is still processing
   * - Whether the agent stopped mid-sentence
   * 
   * Uses a fast model for quick evaluation (~1-3 seconds).
   */
  async function evaluateStuckWithGenAI(
    sessionId: string,
    messages: any[],
    messageAgeMs: number
  ): Promise<StuckEvaluation> {
    // Check cache first
    const cached = stuckEvaluationCache.get(sessionId)
    if (cached && Date.now() - cached.timestamp < GENAI_STUCK_CACHE_TTL) {
      debug("Using cached stuck evaluation for:", sessionId.slice(0, 8))
      return cached.result
    }
    
    // Only run GenAI check if message is old enough
    if (messageAgeMs < GENAI_STUCK_CHECK_THRESHOLD) {
      return { stuck: false, reason: "working", confidence: 0.5, shouldNudge: false }
    }
    
    try {
      // Get fast model for evaluation
      const fastModel = await getFastModel()
      if (!fastModel) {
        debug("No fast model available, falling back to static check")
        return { stuck: true, reason: "error", confidence: 0.3, shouldNudge: true }
      }
      
      // Extract context for evaluation
      const lastHuman = [...messages].reverse().find(m => m.info?.role === "user")
      const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
      
      let lastHumanText = ""
      for (const part of lastHuman?.parts || []) {
        if (part.type === "text" && part.text) {
          lastHumanText = part.text.slice(0, 500)
          break
        }
      }
      
      let lastAssistantText = ""
      const pendingToolCalls: string[] = []
      for (const part of lastAssistant?.parts || []) {
        if (part.type === "text" && part.text) {
          lastAssistantText = part.text.slice(0, 1000)
        }
        if (part.type === "tool") {
          const toolName = part.tool || "unknown"
          const state = part.state?.status || "unknown"
          pendingToolCalls.push(`${toolName}: ${state}`)
        }
      }
      
      const isMessageComplete = !!(lastAssistant?.info?.time as any)?.completed
      const outputTokens = (lastAssistant?.info as any)?.tokens?.output ?? 0
      
      // Build evaluation prompt
      const prompt = `Evaluate this AI agent session state. Return only JSON.

## Context
- Time since last activity: ${Math.round(messageAgeMs / 1000)} seconds
- Message completed: ${isMessageComplete}
- Output tokens: ${outputTokens}

## Last User Message
${lastHumanText || "(empty)"}

## Agent's Last Response (may be incomplete)
${lastAssistantText || "(no text generated)"}

## Tool Calls
${pendingToolCalls.length > 0 ? pendingToolCalls.join("\n") : "(none)"}

---

Determine if the agent is stuck and needs a nudge to continue. Consider:
1. If agent asked a clarifying question → NOT stuck (waiting for user)
2. If agent is mid-tool-call (tool status: running) → NOT stuck (working)
3. If agent stopped mid-sentence or mid-thought → STUCK
4. If agent completed response but no further action → check if task requires more
5. If output tokens = 0 and long delay → likely STUCK
6. If agent listed "Next Steps" but didn't continue → STUCK (premature stop)

Return JSON only:
{
  "stuck": true/false,
  "reason": "genuinely_stuck" | "waiting_for_user" | "working" | "complete",
  "confidence": 0.0-1.0,
  "shouldNudge": true/false,
  "nudgeMessage": "optional: brief message to send if nudging"
}`
      
      // Create a temporary session for the evaluation
      const { data: evalSession } = await client.session.create({ query: { directory } })
      if (!evalSession?.id) {
        return { stuck: true, reason: "error", confidence: 0.3, shouldNudge: true }
      }
      
      // Track as judge session to skip in event handlers
      judgeSessionIds.add(evalSession.id)
      
      try {
        // Send prompt with fast model
        await client.session.promptAsync({
          path: { id: evalSession.id },
          body: {
            model: { providerID: fastModel.providerID, modelID: fastModel.modelID },
            parts: [{ type: "text", text: prompt }]
          }
        })
        
        // Wait for response with shorter timeout
        const start = Date.now()
        while (Date.now() - start < GENAI_STUCK_TIMEOUT) {
          await new Promise(r => setTimeout(r, 1000))
          const { data: evalMessages } = await client.session.messages({ path: { id: evalSession.id } })
          const assistantMsg = [...(evalMessages || [])].reverse().find((m: any) => m.info?.role === "assistant")
          if (!(assistantMsg?.info?.time as any)?.completed) continue
          
          for (const part of assistantMsg?.parts || []) {
            if (part.type === "text" && part.text) {
              const jsonMatch = part.text.match(/\{[\s\S]*\}/)
              if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]) as StuckEvaluation
                // Ensure all required fields
                const evaluation: StuckEvaluation = {
                  stuck: !!result.stuck,
                  reason: result.reason || "genuinely_stuck",
                  confidence: result.confidence ?? 0.5,
                  shouldNudge: result.shouldNudge ?? result.stuck,
                  nudgeMessage: result.nudgeMessage
                }
                
                // Cache the result
                stuckEvaluationCache.set(sessionId, { result: evaluation, timestamp: Date.now() })
                debug("GenAI stuck evaluation:", sessionId.slice(0, 8), evaluation)
                return evaluation
              }
            }
          }
        }
        
        // Timeout - fall back to stuck=true
        debug("GenAI stuck evaluation timed out:", sessionId.slice(0, 8))
        return { stuck: true, reason: "genuinely_stuck", confidence: 0.4, shouldNudge: true }
      } finally {
        // Clean up evaluation session
        try {
          await client.session.delete({ path: { id: evalSession.id }, query: { directory } })
        } catch {}
        judgeSessionIds.delete(evalSession.id)
      }
    } catch (e) {
      debug("Error in GenAI stuck evaluation:", e)
      // Fall back to assuming stuck
      return { stuck: true, reason: "error", confidence: 0.3, shouldNudge: true }
    }
  }

  /**
   * Use GenAI to evaluate what to do after context compression.
   * This provides intelligent, context-aware nudge messages instead of generic ones.
   * 
   * Evaluates:
   * - Whether there's active GitHub work (PR/issue) that needs updating
   * - Whether the task was in progress and should continue
   * - Whether clarification is needed due to context loss
   * - Whether the task was actually complete
   */
  async function evaluatePostCompression(
    sessionId: string,
    messages: any[]
  ): Promise<CompressionEvaluation> {
    const defaultNudge: CompressionEvaluation = {
      action: "continue_task",
      hasActiveGitWork: false,
      confidence: 0.5,
      nudgeMessage: `Context was just compressed. Please continue with the task where you left off.`
    }
    
    try {
      // Get fast model for evaluation
      const fastModel = await getFastModel()
      if (!fastModel) {
        debug("No fast model available for compression evaluation, using default")
        return defaultNudge
      }
      
      // Extract context from messages
      const humanMessages: string[] = []
      let lastAssistantText = ""
      const toolsUsed: string[] = []
      let hasGitCommands = false
      let hasPROrIssueRef = false
      
      for (const msg of messages) {
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text && !part.text.includes("## Reflection:")) {
              humanMessages.push(part.text.slice(0, 300))
              break
            }
          }
        }
        
        if (msg.info?.role === "assistant") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              lastAssistantText = part.text.slice(0, 1000)
            }
            if (part.type === "tool") {
              const toolName = part.tool || "unknown"
              toolsUsed.push(toolName)
              // Detect git/GitHub related work
              if (toolName === "bash") {
                const input = JSON.stringify(part.state?.input || {})
                if (/\bgh\s+(pr|issue)\b/i.test(input)) {
                  hasGitCommands = true
                  hasPROrIssueRef = true
                }
                if (/\bgit\s+(commit|push|branch|checkout)\b/i.test(input)) {
                  hasGitCommands = true
                }
              }
            }
          }
        }
      }
      
      // Also check text content for PR/issue references
      const allText = humanMessages.join(" ") + " " + lastAssistantText
      if (/#\d+|PR\s*#?\d+|issue\s*#?\d+|pull request/i.test(allText)) {
        hasPROrIssueRef = true
      }
      
      // Build task summary
      const taskSummary = humanMessages.length === 1
        ? humanMessages[0]
        : humanMessages.slice(0, 3).map((m, i) => `[${i + 1}] ${m}`).join("\n")
      
      // Build evaluation prompt
      const prompt = `Evaluate what action to take after context compression in an AI coding session. Return only JSON.

## Original Task(s)
${taskSummary || "(no task found)"}

## Agent's Last Response (before compression)
${lastAssistantText || "(no response found)"}

## Tools Used
${toolsUsed.slice(-10).join(", ") || "(none)"}

## Detected Indicators
- Git commands used: ${hasGitCommands}
- PR/Issue references found: ${hasPROrIssueRef}

---

Determine the best action after compression:

1. **needs_github_update**: Agent was working on a PR/issue and should update it with progress before continuing
2. **continue_task**: Agent should simply continue where it left off
3. **needs_clarification**: Significant context was lost, user input may be needed
4. **task_complete**: Task appears to be finished, no action needed

Return JSON only:
{
  "action": "needs_github_update" | "continue_task" | "needs_clarification" | "task_complete",
  "hasActiveGitWork": true/false,
  "confidence": 0.0-1.0,
  "nudgeMessage": "Context-aware message to send to the agent"
}

Guidelines for nudgeMessage:
- If needs_github_update: Tell agent to use \`gh pr comment\` or \`gh issue comment\` to summarize progress
- If continue_task: Brief reminder of what they were working on
- If needs_clarification: Ask agent to summarize current state and what's needed
- If task_complete: Empty string or brief acknowledgment`
      
      // Create evaluation session
      const { data: evalSession } = await client.session.create({ query: { directory } })
      if (!evalSession?.id) {
        return defaultNudge
      }
      
      judgeSessionIds.add(evalSession.id)
      
      try {
        await client.session.promptAsync({
          path: { id: evalSession.id },
          body: {
            model: { providerID: fastModel.providerID, modelID: fastModel.modelID },
            parts: [{ type: "text", text: prompt }]
          }
        })
        
        // Wait for response with short timeout
        const start = Date.now()
        while (Date.now() - start < GENAI_STUCK_TIMEOUT) {
          await new Promise(r => setTimeout(r, 1000))
          const { data: evalMessages } = await client.session.messages({ path: { id: evalSession.id } })
          const assistantMsg = [...(evalMessages || [])].reverse().find((m: any) => m.info?.role === "assistant")
          if (!(assistantMsg?.info?.time as any)?.completed) continue
          
          for (const part of assistantMsg?.parts || []) {
            if (part.type === "text" && part.text) {
              const jsonMatch = part.text.match(/\{[\s\S]*\}/)
              if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0])
                const evaluation: CompressionEvaluation = {
                  action: result.action || "continue_task",
                  hasActiveGitWork: !!result.hasActiveGitWork,
                  confidence: result.confidence ?? 0.5,
                  nudgeMessage: result.nudgeMessage || defaultNudge.nudgeMessage
                }
                
                debug("GenAI compression evaluation:", sessionId.slice(0, 8), evaluation)
                return evaluation
              }
            }
          }
        }
        
        // Timeout - use default
        debug("GenAI compression evaluation timed out:", sessionId.slice(0, 8))
        return defaultNudge
      } finally {
        // Clean up evaluation session
        try {
          await client.session.delete({ path: { id: evalSession.id }, query: { directory } })
        } catch {}
        judgeSessionIds.delete(evalSession.id)
      }
    } catch (e) {
      debug("Error in GenAI compression evaluation:", e)
      return defaultNudge
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
      // Use GenAI to generate context-aware compression nudge
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (messages && messages.length > 0) {
        const evaluation = await evaluatePostCompression(sessionId, messages)
        debug("Post-compression evaluation:", evaluation.action, "confidence:", evaluation.confidence)
        
        // Handle different actions
        if (evaluation.action === "task_complete") {
          debug("Task appears complete after compression, skipping nudge")
          await showToast("Task complete (post-compression)", "success")
          return
        }
        
        nudgeMessage = evaluation.nudgeMessage
        
        // Show appropriate toast based on action
        const toastMsg = evaluation.action === "needs_github_update" 
          ? "Prompted GitHub update" 
          : evaluation.action === "needs_clarification"
            ? "Requested clarification"
            : "Nudged to continue"
        
        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: nudgeMessage }] }
          })
          await showToast(toastMsg, "info")
        } catch (e) {
          debug("Failed to nudge session:", e)
        }
        return
      }
      
      // Fallback if no messages available
      nudgeMessage = `Context was just compressed. Please continue with the task where you left off.`
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

      // Identify current task by ID (robust against context compression)
      const humanMsgId = getLastRelevantUserMessageId(messages)
      debug("humanMsgId:", humanMsgId)
      if (!humanMsgId) {
        debug("SKIP: no relevant human messages")
        return
      }

      // Skip if current task was aborted/cancelled by user (Esc key)
      // This only skips the specific aborted task, not future tasks in the same session
      if (wasCurrentTaskAborted(sessionId, messages, humanMsgId)) {
        debug("SKIP: current task was aborted")
        return
      }

      // Check if we already completed reflection for this exact message ID
      const lastReflected = lastReflectedMsgId.get(sessionId)
      if (humanMsgId === lastReflected) {
        debug("SKIP: already reflected for this message ID:", humanMsgId)
        return
      }

      // Get attempt count for THIS specific task (session + message ID)
      const attemptKey = getAttemptKey(sessionId, humanMsgId)
      const attemptCount = attempts.get(attemptKey) || 0
      debug("attemptCount:", attemptCount, "/ MAX:", MAX_ATTEMPTS)
      
      if (attemptCount >= MAX_ATTEMPTS) {
        // Max attempts for this task - mark as reflected and stop
        lastReflectedMsgId.set(sessionId, humanMsgId)
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

        // Format conversation history note if there were multiple messages
        const conversationNote = extracted.humanMessages.length > 1
          ? `\n\n**NOTE: The user sent ${extracted.humanMessages.length} messages during this session. Messages are numbered [1], [2], etc. Later messages may refine, pivot, or add to earlier requests. Evaluate completion based on the FINAL requirements after all pivots.**`
          : ""

        const prompt = `TASK VERIFICATION

Evaluate whether the agent completed what the user asked for.

${agents ? `## Project Instructions\n${agents.slice(0, 1500)}\n` : ""}
## User's Request${conversationNote}
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
- "Would you like me to continue?"
- "I can help you with..." followed by numbered options
- Presenting options (1. 2. 3.) without taking action

IMPORTANT: If the agent lists "Remaining Tasks" or "Next Steps" and then asks for permission to continue,
this is PREMATURE STOPPING, not waiting for user input. The agent should complete the stated work.
- Set complete: false
- Set severity: LOW or MEDIUM (not NONE)
- Include the remaining items in "missing" array
- Include concrete next steps in "next_actions" array

ONLY use severity: NONE when the original task GENUINELY requires user decisions that cannot be inferred:
- Design choices ("what color scheme do you want?")
- Preference decisions ("which approach do you prefer?")
- Missing information ("what is your API key?")
- Clarification requests when the task is truly ambiguous

Do NOT use severity: NONE when:
- Agent lists remaining work and asks permission to continue
- Agent asks "should I proceed?" when the answer is obviously yes
- Agent presents a summary and waits instead of completing the task

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
  "next_actions": ["concrete commands or checks to run"],
  "requires_human_action": true/false  // NEW: set true ONLY if user must physically act (auth, hardware, 2FA)
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
          lastReflectedMsgId.set(sessionId, humanMsgId)
          return
        }
        debug("judge response received, length:", response.length)

        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
          debug("SKIP: no JSON found in response")
          lastReflectedMsgId.set(sessionId, humanMsgId)
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
          lastReflectedMsgId.set(sessionId, humanMsgId)
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
            lastReflectedMsgId.set(sessionId, humanMsgId)  // Mark as reflected to prevent retry
            return
          }
          
          // HUMAN ACTION REQUIRED: Show toast to USER, don't send feedback to agent
          // This handles cases like OAuth consent, 2FA, API key retrieval from dashboard
          // The agent cannot complete these tasks - it's up to the user
          if (verdict.requires_human_action) {
            debug("REQUIRES_HUMAN_ACTION: notifying user, not agent")
            lastReflectedMsgId.set(sessionId, humanMsgId)  // Mark as reflected to prevent retry
            attempts.delete(attemptKey)  // Reset attempts since this isn't agent's fault
            
            // Show helpful toast with what user needs to do
            const actionHint = verdict.missing?.[0] || "User action required"
            await showToast(`Action needed: ${actionHint}`, "warning")
            return
          }
          
          // SPECIAL CASE: severity NONE but incomplete
          // If there are NO missing items, agent is legitimately waiting for user input
          // (e.g., asking clarifying questions, presenting options for user to choose)
          // If there ARE missing items, agent should continue (not wait for permission)
          const hasMissingItems = verdict.missing?.length > 0 || verdict.next_actions?.length > 0
          if (severity === "NONE" && !hasMissingItems) {
            debug("SKIP feedback: severity NONE and no missing items means waiting for user input")
            lastReflectedMsgId.set(sessionId, humanMsgId)  // Mark as reflected
            await showToast("Awaiting user input", "info")
            return
          }
          
          // If severity NONE but HAS missing items, agent should continue without waiting
          if (severity === "NONE" && hasMissingItems) {
            debug("Pushing agent: severity NONE but has missing items:", verdict.missing?.length || 0, "missing,", verdict.next_actions?.length || 0, "next_actions")
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
                text: `## Reflection: Task Incomplete (${severity})
${verdict.feedback}
${missing}
${nextActions}

Please address these issues and continue.`
              }]
            }
          })

          // Schedule a nudge to ensure the agent continues if it gets stuck after feedback
          scheduleNudge(sessionId, STUCK_CHECK_DELAY, "reflection")
        }

      } catch (e) {
        debug("Error in reflection evaluation:", e)
      } finally {
        await cleanupJudgeSession()
      }

    } catch (e) {
      debug("ERROR in runReflection:", e)
    } finally {
      activeReflections.delete(sessionId)
    }
  }
  /**
   * Check all sessions for stuck state on startup.
   * This handles the case where OpenCode is restarted with -c (continue)
   * and the previous session was stuck mid-turn.
   */
  async function checkAllSessionsOnStartup(): Promise<void> {
    debug("Checking all sessions on startup...")
    try {
      const { data: sessions } = await client.session.list({ query: { directory } })
      if (!sessions || sessions.length === 0) {
        debug("No sessions found on startup")
        return
      }

      debug("Found", sessions.length, "sessions to check")

      for (const session of sessions) {
        const sessionId = session.id
        if (!sessionId) continue

        // Skip judge sessions
        if (judgeSessionIds.has(sessionId)) continue

        try {
          // Check if this session has a stuck message
          const { stuck: staticStuck, messageAgeMs } = await isLastMessageStuck(sessionId)
          
          if (staticStuck) {
            debug("Found potentially stuck session on startup:", sessionId.slice(0, 8), "age:", Math.round(messageAgeMs / 1000), "s")
            
            // Check if session is idle (not actively working)
            if (await isSessionIdle(sessionId)) {
              // Use GenAI for accurate evaluation
              const { data: messages } = await client.session.messages({ path: { id: sessionId } })
              if (messages && messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD) {
                const evaluation = await evaluateStuckWithGenAI(sessionId, messages, messageAgeMs)
                
                if (evaluation.shouldNudge) {
                  debug("GenAI confirms stuck on startup, nudging:", sessionId.slice(0, 8))
                  await showToast("Resuming stuck session...", "info")
                  
                  const nudgeText = evaluation.nudgeMessage || 
                    `It appears the previous task was interrupted. Please continue where you left off.

If context was compressed, first update any active GitHub PR/issue with your progress using \`gh pr comment\` or \`gh issue comment\`, then continue with the task.`
                  
                  await client.session.promptAsync({
                    path: { id: sessionId },
                    body: { parts: [{ type: "text", text: nudgeText }] }
                  })
                } else if (evaluation.reason === "waiting_for_user") {
                  debug("Session waiting for user on startup:", sessionId.slice(0, 8))
                  await showToast("Session awaiting user input", "info")
                } else {
                  debug("Session not stuck on startup:", sessionId.slice(0, 8), evaluation.reason)
                }
              } else {
                // Static stuck, not old enough for GenAI - nudge anyway
                debug("Nudging stuck session on startup (static):", sessionId.slice(0, 8))
                await showToast("Resuming stuck session...", "info")
                
                await client.session.promptAsync({
                  path: { id: sessionId },
                  body: {
                    parts: [{
                      type: "text",
                      text: `It appears the previous task was interrupted. Please continue where you left off.

If context was compressed, first update any active GitHub PR/issue with your progress using \`gh pr comment\` or \`gh issue comment\`, then continue with the task.`
                    }]
                  }
                })
              }
            } else {
              debug("Stuck session is busy, skipping nudge:", sessionId.slice(0, 8))
            }
          } else {
            // Not stuck, but check if session is idle and might need reflection
            if (await isSessionIdle(sessionId)) {
              // Get messages to check if there's an incomplete task
              const { data: messages } = await client.session.messages({ path: { id: sessionId } })
              if (messages && messages.length >= 2) {
                // Check if last assistant message is complete (has finished property)
                const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
                if (lastAssistant) {
                  const completed = (lastAssistant.info?.time as any)?.completed
                  if (completed) {
                    // Message is complete, run reflection to check if task is done
                    debug("Running reflection on startup for session:", sessionId.slice(0, 8))
                    // Don't await - run in background
                    runReflection(sessionId).catch(e => debug("Startup reflection error:", e))
                  }
                }
              }
            }
          }
        } catch (e) {
          debug("Error checking session on startup:", sessionId.slice(0, 8), e)
        }
      }
    } catch (e) {
      debug("Error listing sessions on startup:", e)
    }
  }

  // Run startup check after a short delay to let OpenCode initialize
  // This handles the -c (continue) case where previous session was stuck
  const STARTUP_CHECK_DELAY = 5_000 // 5 seconds
  setTimeout(() => {
    checkAllSessionsOnStartup().catch(e => debug("Startup check failed:", e))
  }, STARTUP_CHECK_DELAY)

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
      
      // Handle compression/compaction - nudge to prompt GitHub update and continue task
      // Uses retry mechanism because agent may be busy immediately after compression
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
          
          // Retry mechanism: keep checking until session is idle, then nudge
          // This handles the case where agent is busy processing the compression summary
          let retryCount = 0
          const attemptNudge = async () => {
            retryCount++
            debug("Compression nudge attempt", retryCount, "for session:", sessionId.slice(0, 8))
            
            // First check if message is stuck (created but never completed)
            const { stuck: staticStuck, messageAgeMs } = await isLastMessageStuck(sessionId)
            if (staticStuck) {
              // Use GenAI for accurate evaluation if message is old enough
              if (messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD) {
                const { data: messages } = await client.session.messages({ path: { id: sessionId } })
                if (messages) {
                  const evaluation = await evaluateStuckWithGenAI(sessionId, messages, messageAgeMs)
                  if (evaluation.shouldNudge) {
                    debug("GenAI confirms stuck after compression, nudging:", sessionId.slice(0, 8))
                    await nudgeSession(sessionId, "compression")
                    return // Success - stop retrying
                  } else if (evaluation.reason === "working") {
                    // Still working, continue retry loop
                    debug("GenAI says still working after compression:", sessionId.slice(0, 8))
                  } else {
                    // Not stuck according to GenAI
                    debug("GenAI says not stuck after compression:", sessionId.slice(0, 8), evaluation.reason)
                    return // Stop retrying
                  }
                }
              } else {
                // Static stuck but not old enough for GenAI - nudge anyway
                debug("Detected stuck message after compression (static), nudging:", sessionId.slice(0, 8))
                await nudgeSession(sessionId, "compression")
                return // Success - stop retrying
              }
            }
            
            // Check if session is idle
            if (await isSessionIdle(sessionId)) {
              debug("Session is idle after compression, nudging:", sessionId.slice(0, 8))
              await nudgeSession(sessionId, "compression")
              return // Success - stop retrying
            }
            
            // Session is still busy, retry if we haven't exceeded max retries
            if (retryCount < COMPRESSION_NUDGE_RETRIES) {
              debug("Session still busy, will retry in", COMPRESSION_RETRY_INTERVAL / 1000, "s")
              setTimeout(attemptNudge, COMPRESSION_RETRY_INTERVAL)
            } else {
              debug("Max compression nudge retries reached for session:", sessionId.slice(0, 8))
              // Last resort: use GenAI evaluation after threshold
              setTimeout(async () => {
                const { stuck, messageAgeMs } = await isLastMessageStuck(sessionId)
                if (stuck) {
                  const { data: messages } = await client.session.messages({ path: { id: sessionId } })
                  if (messages && messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD) {
                    const evaluation = await evaluateStuckWithGenAI(sessionId, messages, messageAgeMs)
                    if (evaluation.shouldNudge) {
                      debug("Final GenAI check triggered nudge for session:", sessionId.slice(0, 8))
                      await nudgeSession(sessionId, "compression")
                    }
                  } else if (stuck) {
                    debug("Final static check triggered nudge for session:", sessionId.slice(0, 8))
                    await nudgeSession(sessionId, "compression")
                  }
                }
              }, STUCK_MESSAGE_THRESHOLD)
            }
          }
          
          // Start retry loop after initial delay
          setTimeout(attemptNudge, 3000) // 3 second initial delay
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
          
          // Check for stuck message BEFORE running reflection
          // This handles the case where agent started responding but got stuck
          const { stuck: staticStuck, messageAgeMs } = await isLastMessageStuck(sessionId)
          
          if (staticStuck) {
            // Static check says stuck - use GenAI for more accurate evaluation
            // Get messages for GenAI context
            const { data: messages } = await client.session.messages({ path: { id: sessionId } })
            
            if (messages && messageAgeMs >= GENAI_STUCK_CHECK_THRESHOLD) {
              // Use GenAI to evaluate if actually stuck
              const evaluation = await evaluateStuckWithGenAI(sessionId, messages, messageAgeMs)
              debug("GenAI evaluation result:", sessionId.slice(0, 8), evaluation)
              
              if (evaluation.shouldNudge) {
                // GenAI confirms agent is stuck - nudge with custom message if provided
                const reason = recentlyCompacted.has(sessionId) ? "compression" : "reflection"
                if (evaluation.nudgeMessage) {
                  // Use GenAI-suggested nudge message
                  await client.session.promptAsync({
                    path: { id: sessionId },
                    body: { parts: [{ type: "text", text: evaluation.nudgeMessage }] }
                  })
                  await showToast("Nudged agent to continue", "info")
                } else {
                  await nudgeSession(sessionId, reason)
                }
                recentlyCompacted.delete(sessionId)
                return  // Wait for agent to respond to nudge
              } else if (evaluation.reason === "waiting_for_user") {
                // Agent is waiting for user input - don't nudge or reflect
                debug("Agent waiting for user input, skipping:", sessionId.slice(0, 8))
                await showToast("Awaiting user input", "info")
                return
              } else if (evaluation.reason === "working") {
                // Agent is still working - check again later
                debug("Agent still working, will check again:", sessionId.slice(0, 8))
                return
              }
              // If evaluation.reason === "complete", continue to reflection
            } else {
              // Message not old enough for GenAI - use static nudge
              debug("Detected stuck message on session.idle, nudging:", sessionId.slice(0, 8))
              const reason = recentlyCompacted.has(sessionId) ? "compression" : "reflection"
              await nudgeSession(sessionId, reason)
              recentlyCompacted.delete(sessionId)
              return
            }
          }
          
          await runReflection(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
