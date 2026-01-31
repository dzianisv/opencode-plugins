/**
 * Reflection Plugin for OpenCode
 *
 * Simple judge layer: when session idles, ask LLM if task is complete.
 * Shows toast notifications only - does NOT auto-prompt the agent.
 * 
 * IMPORTANT: This plugin is READ-ONLY for the main session.
 * It evaluates task completion but never triggers agent actions.
 * The user must manually continue if the task is incomplete.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"

const MAX_ATTEMPTS = 3  // Reduced - we only evaluate, don't push
const JUDGE_RESPONSE_TIMEOUT = 180_000
const POLL_INTERVAL = 2_000
const DEBUG = process.env.REFLECTION_DEBUG === "1"
const SESSION_CLEANUP_INTERVAL = 300_000 // Clean old sessions every 5 minutes
const SESSION_MAX_AGE = 1800_000 // Sessions older than 30 minutes can be cleaned

// Debug logging (only when REFLECTION_DEBUG=1)
function debug(...args: any[]) {
  if (DEBUG) console.error("[Reflection]", ...args)
}

// ==================== CONFIG TYPES ====================

interface TaskPattern {
  pattern: string      // Regex pattern to match task text
  type?: "coding" | "research"  // Override task type detection
  extraRules?: string[]  // Additional rules for this pattern
}

interface ReflectionConfig {
  enabled?: boolean
  model?: string  // Override model for judge session
  customRules?: {
    coding?: string[]
    research?: string[]
  }
  severityMapping?: {
    [key: string]: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
  }
  taskPatterns?: TaskPattern[]
  promptTemplate?: string | null  // Full custom prompt template (advanced)
  strictMode?: boolean  // If true, incomplete tasks block further work
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
  severityMapping: {},
  taskPatterns: [],
  promptTemplate: null,
  strictMode: false
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
  // Track sessions that were recently aborted (Esc key) - prevents race condition
  const recentlyAbortedSessions = new Map<string, number>()
  const ABORT_COOLDOWN = 10_000 // 10 second cooldown before allowing reflection again
  
  // Periodic cleanup of old session data to prevent memory leaks
  const cleanupOldSessions = () => {
    const now = Date.now()
    for (const [sessionId, timestamp] of sessionTimestamps) {
      if (now - timestamp > SESSION_MAX_AGE) {
        sessionTimestamps.delete(sessionId)
        lastReflectedMsgCount.delete(sessionId)
        abortedMsgCounts.delete(sessionId)
        for (const key of attempts.keys()) {
          if (key.startsWith(sessionId)) attempts.delete(key)
        }
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

  // Cache for reflection config
  let configCache: { config: ReflectionConfig; timestamp: number } | null = null
  const CONFIG_CACHE_TTL = 60_000 // Cache for 1 minute

  /**
   * Load reflection config from project or global location.
   * Priority: <project>/.opencode/reflection.json > ~/.config/opencode/reflection.json > defaults
   */
  async function loadConfig(): Promise<ReflectionConfig> {
    const now = Date.now()
    if (configCache && now - configCache.timestamp < CONFIG_CACHE_TTL) {
      return configCache.config
    }

    const projectConfigPath = join(directory, ".opencode", "reflection.json")
    const globalConfigPath = join(homedir(), ".config", "opencode", "reflection.json")

    let config: ReflectionConfig = { ...DEFAULT_CONFIG }

    // Try project config first
    try {
      if (existsSync(projectConfigPath)) {
        const content = await readFile(projectConfigPath, "utf-8")
        const projectConfig = JSON.parse(content) as ReflectionConfig
        config = mergeConfig(DEFAULT_CONFIG, projectConfig)
        debug("Loaded project config from", projectConfigPath)
      }
    } catch (e) {
      debug("Failed to load project config:", e)
    }

    // Fall back to global config if no project config
    if (!existsSync(projectConfigPath)) {
      try {
        if (existsSync(globalConfigPath)) {
          const content = await readFile(globalConfigPath, "utf-8")
          const globalConfig = JSON.parse(content) as ReflectionConfig
          config = mergeConfig(DEFAULT_CONFIG, globalConfig)
          debug("Loaded global config from", globalConfigPath)
        }
      } catch (e) {
        debug("Failed to load global config:", e)
      }
    }

    configCache = { config, timestamp: now }
    return config
  }

  /**
   * Deep merge config with defaults
   */
  function mergeConfig(defaults: ReflectionConfig, override: ReflectionConfig): ReflectionConfig {
    return {
      enabled: override.enabled ?? defaults.enabled,
      model: override.model ?? defaults.model,
      customRules: {
        coding: override.customRules?.coding ?? defaults.customRules?.coding,
        research: override.customRules?.research ?? defaults.customRules?.research
      },
      severityMapping: { ...defaults.severityMapping, ...override.severityMapping },
      taskPatterns: override.taskPatterns ?? defaults.taskPatterns,
      promptTemplate: override.promptTemplate ?? defaults.promptTemplate,
      strictMode: override.strictMode ?? defaults.strictMode
    }
  }

  /**
   * Find matching task pattern for the given task text
   */
  function findMatchingPattern(task: string, config: ReflectionConfig): TaskPattern | null {
    if (!config.taskPatterns?.length) return null
    
    for (const pattern of config.taskPatterns) {
      try {
        const regex = new RegExp(pattern.pattern, "i")
        if (regex.test(task)) {
          debug("Task matched pattern:", pattern.pattern)
          return pattern
        }
      } catch (e) {
        debug("Invalid pattern regex:", pattern.pattern, e)
      }
    }
    return null
  }

  /**
   * Build custom rules section based on config and task
   */
  function buildCustomRules(isResearch: boolean, config: ReflectionConfig, matchedPattern: TaskPattern | null): string {
    const rules: string[] = []
    
    if (isResearch) {
      rules.push(...(config.customRules?.research || []))
    } else {
      rules.push(...(config.customRules?.coding || []))
    }
    
    // Add extra rules from matched pattern
    if (matchedPattern?.extraRules) {
      rules.push(...matchedPattern.extraRules)
    }
    
    if (rules.length === 0) return ""
    
    const numberedRules = rules.map((r, i) => `${i + 1}. ${r}`).join("\n")
    return isResearch 
      ? `\n### Research Task Rules (APPLIES TO THIS TASK)\nThis is a RESEARCH task - the user explicitly requested investigation/analysis without code changes.\n${numberedRules}\n`
      : `\n### Coding Task Rules\n${numberedRules}\n`
  }

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
    if (judgeSessionIds.has(sessionId)) return true
    
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  function wasCurrentTaskAborted(sessionId: string, messages: any[], humanMsgCount: number): boolean {
    const abortedCounts = abortedMsgCounts.get(sessionId)
    if (abortedCounts?.has(humanMsgCount)) return true
    
    const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
    if (!lastAssistant) return false
    
    const error = lastAssistant.info?.error
    if (!error) return false
    
    if (error.name === "MessageAbortedError") {
      if (!abortedMsgCounts.has(sessionId)) {
        abortedMsgCounts.set(sessionId, new Set())
      }
      abortedMsgCounts.get(sessionId)!.add(humanMsgCount)
      debug("Marked task as aborted:", sessionId.slice(0, 8), "msgCount:", humanMsgCount)
      return true
    }
    
    const errorMsg = error.data?.message || error.message || ""
    if (typeof errorMsg === "string" && errorMsg.toLowerCase().includes("abort")) {
      if (!abortedMsgCounts.has(sessionId)) {
        abortedMsgCounts.set(sessionId, new Set())
      }
      abortedMsgCounts.get(sessionId)!.add(humanMsgCount)
      return true
    }
    
    return false
  }

  function countHumanMessages(messages: any[]): number {
    let count = 0
    for (const msg of messages) {
      if (msg.info?.role === "user") {
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

    const task = humanMessages.length === 1
      ? humanMessages[0]
      : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")
    
    const allHumanText = humanMessages.join(" ")
    const isResearch = /research|explore|investigate|analyze|review|study|compare|evaluate/i.test(allHumanText) &&
                       /do not|don't|no code|research only|just research|only research/i.test(allHumanText)

    debug("extractTaskAndResult - humanMessages:", humanMessages.length, "task empty?", !task, "result empty?", !result)
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

  function getAttemptKey(sessionId: string, humanMsgCount: number): string {
    return `${sessionId}:${humanMsgCount}`
  }

  async function runReflection(sessionId: string): Promise<void> {
    debug("runReflection called for session:", sessionId)
    
    const reflectionStartTime = Date.now()
    
    if (activeReflections.has(sessionId)) {
      debug("SKIP: activeReflections already has session")
      return
    }
    activeReflections.add(sessionId)

    try {
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) {
        debug("SKIP: messages length < 2, got:", messages?.length)
        return
      }

      if (isJudgeSession(sessionId, messages)) {
        debug("SKIP: is judge session")
        return
      }

      const humanMsgCount = countHumanMessages(messages)
      debug("humanMsgCount:", humanMsgCount)
      if (humanMsgCount === 0) {
        debug("SKIP: no human messages")
        return
      }

      if (wasCurrentTaskAborted(sessionId, messages, humanMsgCount)) {
        debug("SKIP: current task was aborted")
        return
      }

      const lastReflected = lastReflectedMsgCount.get(sessionId) || 0
      if (humanMsgCount <= lastReflected) {
        debug("SKIP: already reflected for this message count", { humanMsgCount, lastReflected })
        return
      }

      const attemptKey = getAttemptKey(sessionId, humanMsgCount)
      const attemptCount = attempts.get(attemptKey) || 0
      debug("attemptCount:", attemptCount, "/ MAX:", MAX_ATTEMPTS)
      
      if (attemptCount >= MAX_ATTEMPTS) {
        lastReflectedMsgCount.set(sessionId, humanMsgCount)
        await showToast(`Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
        debug("SKIP: max attempts reached")
        return
      }

      const extracted = extractTaskAndResult(messages)
      if (!extracted) {
        debug("SKIP: extractTaskAndResult returned null")
        return
      }
      debug("extracted task length:", extracted.task.length, "result length:", extracted.result.length)

      // Create judge session
      const { data: judgeSession } = await client.session.create({
        query: { directory }
      })
      if (!judgeSession?.id) return

      judgeSessionIds.add(judgeSession.id)

      const cleanupJudgeSession = async () => {
        try {
          await client.session.delete({ 
            path: { id: judgeSession.id },
            query: { directory }
          })
        } catch (e) {
          console.error(`[Reflection] Failed to delete judge session ${judgeSession.id}:`, e)
        } finally {
          judgeSessionIds.delete(judgeSession.id)
        }
      }

      try {
        const agents = await getAgentsFile()
        const config = await loadConfig()
        
        // Check if reflection is disabled
        if (config.enabled === false) {
          debug("SKIP: reflection disabled in config")
          return
        }
        
        // Find matching task pattern for custom rules
        const matchedPattern = findMatchingPattern(extracted.task, config)
        
        // Determine task type (pattern can override detection)
        const isResearch = matchedPattern?.type 
          ? matchedPattern.type === "research"
          : extracted.isResearch
        
        // Build rules section from config
        const rulesSection = buildCustomRules(isResearch, config, matchedPattern)

        const resultPreview = extracted.result.slice(0, 4000)
        const truncationNote = extracted.result.length > 4000 
          ? `\n\n[NOTE: Response truncated from ${extracted.result.length} chars]`
          : ""

        const conversationNote = extracted.humanMessages.length > 1
          ? `\n\n**NOTE: The user sent ${extracted.humanMessages.length} messages. Evaluate completion based on the FINAL requirements.**`
          : ""

        // Use custom prompt template if provided, otherwise use default
        const prompt = config.promptTemplate 
          ? config.promptTemplate
              .replace("{{agents}}", agents ? `## Project Instructions\n${agents.slice(0, 1500)}\n` : "")
              .replace("{{conversationNote}}", conversationNote)
              .replace("{{task}}", extracted.task)
              .replace("{{tools}}", extracted.tools || "(none)")
              .replace("{{result}}", resultPreview)
              .replace("{{truncationNote}}", truncationNote)
              .replace("{{taskType}}", isResearch ? "RESEARCH task (no code expected)" : "CODING/ACTION task")
              .replace("{{rules}}", rulesSection)
          : `TASK VERIFICATION

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
${isResearch ? "This is a RESEARCH task (no code expected)" : "This is a CODING/ACTION task"}

### Severity Levels
- BLOCKER: security, auth, billing, data loss, E2E broken
- HIGH: major functionality degraded, CI red
- MEDIUM: partial degradation
- LOW: cosmetic
- NONE: no issues
${rulesSection}

---

Reply with JSON only (no other text):
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation of verdict",
  "missing": ["list of missing required steps"],
  "next_actions": ["concrete next steps"]
}`

        await client.session.promptAsync({
          path: { id: judgeSession.id },
          body: { parts: [{ type: "text", text: prompt }] }
        })
        debug("judge prompt sent, waiting for response...")

        const response = await waitForResponse(judgeSession.id)
        
        if (!response) {
          debug("SKIP: waitForResponse returned null (timeout)")
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

        await saveReflectionData(sessionId, {
          task: extracted.task,
          result: extracted.result.slice(0, 4000),
          tools: extracted.tools || "(none)",
          prompt,
          verdict,
          timestamp: new Date().toISOString()
        })

        const severity = verdict.severity || "MEDIUM"
        const isBlocker = severity === "BLOCKER"
        const isComplete = verdict.complete && !isBlocker

        await writeVerdictSignal(sessionId, isComplete, severity)

        // Mark as reflected - we don't auto-retry
        lastReflectedMsgCount.set(sessionId, humanMsgCount)
        attempts.set(attemptKey, attemptCount + 1)

        if (isComplete) {
          // COMPLETE: show success toast only
          const toastMsg = severity === "NONE" ? "Task complete ✓" : `Task complete ✓ (${severity})`
          await showToast(toastMsg, "success")
        } else {
          // INCOMPLETE: show warning toast with feedback - DO NOT prompt the agent
          const toastVariant = isBlocker ? "error" : "warning"
          const feedbackSummary = verdict.feedback?.slice(0, 100) || "Task incomplete"
          await showToast(`${severity}: ${feedbackSummary}`, toastVariant)
          
          // Log details for debugging but DO NOT send to agent
          debug("Incomplete verdict - NOT sending feedback to agent")
          debug("Missing:", verdict.missing)
          debug("Next actions:", verdict.next_actions)
        }
      } finally {
        await cleanupJudgeSession()
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
        name: 'reflection',
        description: 'Judge layer that evaluates task completion - operates via session.idle events',
        execute: async () => 'Reflection plugin active - evaluation triggered on session idle'
      }
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type, (event as any).properties?.sessionID?.slice(0, 8))
      
      // Track aborted sessions immediately
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionId, Date.now())
          debug("Session aborted:", sessionId.slice(0, 8))
        }
      }
      
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        debug("session.idle received for:", sessionId)
        if (sessionId && typeof sessionId === "string") {
          sessionTimestamps.set(sessionId, Date.now())
          
          // Skip judge sessions
          if (judgeSessionIds.has(sessionId)) {
            debug("SKIP: session in judgeSessionIds set")
            return
          }
          
          // Skip recently aborted sessions
          const abortTime = recentlyAbortedSessions.get(sessionId)
          if (abortTime) {
            const elapsed = Date.now() - abortTime
            if (elapsed < ABORT_COOLDOWN) {
              debug("SKIP: session was recently aborted (Esc)", elapsed, "ms ago")
              return
            }
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
