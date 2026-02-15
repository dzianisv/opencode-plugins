/**
 * Reflection-3 Plugin for OpenCode
 *
 * Consolidated reflection layer that combines self-assessment with workflow checks.
 * Uses a dynamic prompt (task + workflow requirements) unless reflection.md overrides it.
 * Ensures tests/build/PR/CI checks are verified before completion.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir, stat, appendFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

// Lazy Sentry helper — reports errors without crashing if @sentry/node is unavailable
async function reportError(err: unknown, context?: Record<string, string>): Promise<void> {
  try {
    const Sentry = await import("@sentry/node")
    if (!Sentry.isInitialized()) return
    Sentry.captureException(err, context ? { tags: context } : undefined)
  } catch {}
}

const SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
const FEEDBACK_MARKER = "## Reflection-3:"
const MAX_ATTEMPTS = 5

const JUDGE_BLOCKED_PATTERNS = [
  /\bhaiku\b/i,
  /\bmini\b/i,
  /\bnano\b/i,
  /\bflash\b/i,
  /\bgpt-3\.5\b/i,
  /\bllama-3\.1-8b\b/i,
  /\bmixtral-8x7b\b/i,
]

const PLANNING_LOOP_MIN_TOOL_CALLS = 8
const PLANNING_LOOP_WRITE_RATIO_THRESHOLD = 0.1

type TaskType = "coding" | "docs" | "research" | "ops" | "other"
type AgentMode = "plan" | "build" | "unknown"
type RoutingCategory = "backend" | "architecture" | "frontend" | "default"

interface WorkflowRequirements {
  requiresTests: boolean
  requiresBuild: boolean
  requiresPR: boolean
  requiresCI: boolean
  requiresLocalTests: boolean
  requiresLocalTestsEvidence: boolean
}

interface TaskContext extends WorkflowRequirements {
  taskSummary: string
  taskType: TaskType
  agentMode: AgentMode
  humanMessages: string[]
  toolsSummary: string
  detectedSignals: string[]
  recentCommands: string[]
  pushedToDefaultBranch: boolean
}

interface SelfAssessment {
  task_summary?: string
  task_type?: string
  status?: "complete" | "in_progress" | "blocked" | "stuck" | "waiting_for_user"
  confidence?: number
  evidence?: {
    tests?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
      ran_after_changes?: boolean
      commands?: string[]
      skipped?: boolean
      skip_reason?: string
    }
    build?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
    }
    pr?: {
      created?: boolean
      url?: string
      ci_status?: "pass" | "fail" | "unknown"
      checked?: boolean
    }
  }
  remaining_work?: string[]
  next_steps?: string[]
  needs_user_action?: string[]
  stuck?: boolean
  alternate_approach?: string
}

interface ReflectionAnalysis {
  complete: boolean
  shouldContinue: boolean
  reason: string
  missing: string[]
  nextActions: string[]
  requiresHumanAction: boolean
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
}

interface RoutingConfig {
  enabled: boolean
  models: Record<RoutingCategory, string>
}

const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false,
  models: {
    backend: "",
    architecture: "",
    frontend: "",
    default: ""
  }
}

const JUDGE_RESPONSE_TIMEOUT = 120_000
const POLL_INTERVAL = 2_000
const ABORT_COOLDOWN = 10_000
const REFLECTION_CONFIG_PATH = join(homedir(), ".config", "opencode", "reflection.yaml")

// Debug logging — writes to .reflection/debug.log when REFLECTION_DEBUG=1.
// Never write to stdout/stderr — it corrupts the OpenCode TUI.
const REFLECTION_DEBUG = process.env.REFLECTION_DEBUG === "1"

// Module-level debug function, initially a no-op.
// Replaced with a file-backed logger once the plugin initializes with a directory.
let debug: (...args: any[]) => void = () => {}

function initDebugLogger(directory: string) {
  if (!REFLECTION_DEBUG) return
  const logPath = join(directory, ".reflection", "debug.log")
  let dirEnsured = false
  debug = (...args: any[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    const ts = new Date().toISOString()
    const line = `[${ts}] [Reflection3] ${msg}\n`
    // Fire-and-forget: do not await to avoid slowing down the plugin
    ;(async () => {
      if (!dirEnsured) {
        try { await mkdir(join(directory, ".reflection"), { recursive: true }) } catch {}
        dirEnsured = true
      }
      try { await appendFile(logPath, line) } catch {}
    })()
  }
}

function isBlockedJudgeModel(modelSpec: string): boolean {
  const normalized = modelSpec.toLowerCase()
  return JUDGE_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
}

async function loadPreferredModelSpec(directory: string): Promise<string | null> {
  const candidates = [
    join(directory, "opencode.json"),
    join(directory, ".opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf-8")
      const parsed = JSON.parse(stripJsonComments(content))
      const model = parsed?.model
      if (typeof model === "string" && model.trim()) {
        return model.trim()
      }
    } catch {}
  }
  return null
}

async function loadReflectionPrompt(directory: string): Promise<string | null> {
  const candidates = ["reflection.md", "reflection.MD"]
  for (const name of candidates) {
    try {
      const reflectionPath = join(directory, name)
      const customPrompt = await readFile(reflectionPath, "utf-8")
      debug("Loaded custom prompt from", name)
      return customPrompt.trim()
    } catch {}
  }
  return null
}

async function getAgentsFile(directory: string): Promise<string> {
  for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
    try {
      const content = await readFile(join(directory, name), "utf-8")
      return content
    } catch {}
  }
  return ""
}

function getMessageSignature(msg: any): string {
  if (msg.id) return msg.id
  const role = msg.info?.role || "unknown"
  const time = msg.info?.time?.start || 0
  const textPart = msg.parts?.find((p: any) => p.type === "text")?.text?.slice(0, 20) || ""
  return `${role}:${time}:${textPart}`
}

export function detectPlanningLoop(messages: any[]): {
  detected: boolean
  readCount: number
  writeCount: number
  totalTools: number
} {
  if (!Array.isArray(messages)) {
    return { detected: false, readCount: 0, writeCount: 0, totalTools: 0 }
  }
  let readCount = 0
  let writeCount = 0
  let totalTools = 0

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part.type !== "tool") continue
      totalTools++

      const toolName = (part.tool || "").toString().toLowerCase()
      const input = part.state?.input || {}

      if (["edit", "write", "apply_patch", "github_create_or_update_file", "github_push_files", "github_delete_file", "github_create_pull_request", "github_update_pull_request"].includes(toolName)) {
        writeCount++
        continue
      }

      if (toolName === "bash") {
        const cmd = (input.command || input.cmd || "").toString()
        if (/^\s*(npm|yarn|pnpm)\s+(run\s+)?(build|test|lint|fmt|format)\b/i.test(cmd) || /^\s*git\s+(add|commit|push|checkout|switch|merge|rebase)\b/i.test(cmd) || /^\s*(mkdir|rm|mv|cp)\b/i.test(cmd)) {
          writeCount++
        } else if (/^\s*git\s+(status|log|diff|show|branch|remote|tag)\b/i.test(cmd) || /^\s*(ls|cat|head|tail|find|grep|rg|wc|file)\b/i.test(cmd)) {
          readCount++
        }
        continue
      }

      if (["read", "glob", "grep", "todowrite", "task", "webfetch", "knowledge-graph_search", "knowledge-graph_read", "knowledge-graph_open"].some((name) => toolName.startsWith(name)) || toolName.startsWith("context7_")) {
        readCount++
      }
    }
  }

  const detected =
    totalTools >= PLANNING_LOOP_MIN_TOOL_CALLS &&
    (writeCount === 0 || writeCount / totalTools < PLANNING_LOOP_WRITE_RATIO_THRESHOLD)

  return { detected, readCount, writeCount, totalTools }
}

export function buildEscalatingFeedback(
  attemptCount: number,
  severity: string,
  verdict: { feedback?: string; missing?: string[]; next_actions?: string[] } | undefined | null,
  isPlanningLoop: boolean
): string {
  const safeVerdict = verdict ?? {}
  const missingItems = Array.isArray(safeVerdict.missing) ? safeVerdict.missing : []
  const nextActionItems = Array.isArray(safeVerdict.next_actions) ? safeVerdict.next_actions : []
  const feedbackStr = safeVerdict.feedback || ""
  if (isPlanningLoop) {
    return `${FEEDBACK_MARKER} STOP: Planning Loop Detected

You have been reading files, checking git status, and creating todo lists without writing any code.

DO NOT:
- Run git status or git log again
- Create another todo list
- Read more files "for context"
- Say "let me get right to work" without actually working

DO NOW:
Pick the FIRST item from your existing todo list and implement it. Open a file with Edit or Write and make changes. If you don't know where to start, create the simplest possible file first.

Start coding NOW. No more planning.`
  }

  if (attemptCount <= 2) {
    const missing = missingItems.length
      ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join("\n")}`
      : ""
    const nextActions = nextActionItems.length
      ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join("\n")}`
      : ""
    return `${FEEDBACK_MARKER} Task Incomplete (${severity})
${feedbackStr}
${missing}
${nextActions}

Please address these issues and continue.`
  }

  const missingBrief = missingItems.length
    ? `Still missing: ${missingItems.slice(0, 3).join(", ")}.`
    : ""
  return `${FEEDBACK_MARKER} Still Incomplete (attempt ${attemptCount}/${MAX_ATTEMPTS})

${missingBrief}

You have been asked ${attemptCount} times to complete this task. Stop re-reading files or re-planning. Focus on the specific items above and implement them now. If something is blocking you, say what it is clearly.`
}

function getLastRelevantUserMessageId(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user") {
      let isReflection = false
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) {
            isReflection = true
            break
          }
        }
      }
      if (!isReflection) return getMessageSignature(msg)
    }
  }
  return null
}

function isJudgeSession(sessionId: string, messages: any[], judgeSessionIds: Set<string>): boolean {
  if (judgeSessionIds.has(sessionId)) return true
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && (part.text?.includes("ANALYZE REFLECTION-3") || part.text?.includes("SELF-ASSESS REFLECTION-3"))) {
        return true
      }
    }
  }
  return false
}

function isPlanMode(messages: any[]): boolean {
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
  if (hasSystemPlanMode) return true

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user") {
      let isReflection = false
      let text = ""
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          text = part.text
          if (part.text.includes(SELF_ASSESSMENT_MARKER)) {
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

async function showToast(client: any, directory: string, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
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

function parseModelListFromYaml(content: string): string[] {
  const models: string[] = []
  const lines = content.split(/\r?\n/)
  let inModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^models\s*:/i.test(line)) {
      inModels = true
      const inline = line.replace(/^models\s*:/i, "").trim()
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const items = inline.slice(1, -1).split(",")
        for (const item of items) {
          const value = item.trim().replace(/^['"]|['"]$/g, "")
          if (value) models.push(value)
        }
        inModels = false
      }
      continue
    }

    if (inModels) {
      if (/^[\w-]+\s*:/.test(line)) {
        inModels = false
        continue
      }
      if (line.startsWith("-")) {
        const value = line.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "")
        if (value) models.push(value)
      }
    }
  }

  return models
}

function parseRoutingFromYaml(content: string): RoutingConfig {
  const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  const lines = content.split(/\r?\n/)
  let inRouting = false
  let inRoutingModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^routing\s*:/i.test(line)) {
      inRouting = true
      continue
    }

    if (inRouting) {
      // Exit routing section when we hit a top-level key
      if (/^[a-zA-Z][\w-]*\s*:/.test(rawLine) && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        inRouting = false
        inRoutingModels = false
        continue
      }

      if (/^\s*enabled\s*:\s*(true|false)/i.test(rawLine)) {
        config.enabled = /true/i.test(rawLine)
        continue
      }

      if (/^\s*models\s*:/i.test(rawLine)) {
        inRoutingModels = true
        continue
      }

      if (inRoutingModels) {
        // Exit models sub-section on a non-indented or non-model key
        if (/^\s{2,}[\w-]+\s*:/.test(rawLine) || /^\s+[\w-]+\s*:/.test(rawLine)) {
          const match = rawLine.match(/^\s+([\w-]+)\s*:\s*(.*)/)
          if (match) {
            const key = match[1].toLowerCase() as RoutingCategory
            const value = match[2].trim().replace(/^['"]|['"]$/g, "")
            if (key === "backend" || key === "architecture" || key === "frontend" || key === "default") {
              config.models[key] = value
            }
          }
        }
      }
    }
  }

  return config
}


function parseRoutingCategory(text: string | null | undefined): RoutingCategory | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { category?: string }
      const value = (parsed.category || "").toLowerCase()
      if (value === "backend" || value === "architecture" || value === "frontend" || value === "default") {
        return value
      }
    } catch {}
  }
  const word = trimmed.split(/\s+/)[0]?.toLowerCase()
  if (word === "backend" || word === "architecture" || word === "frontend" || word === "default") {
    return word
  }
  return null
}

async function classifyTaskForRoutingWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  judgeSessionIds: Set<string>
): Promise<RoutingCategory | null> {
  const modelList = await loadReflectionModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  const attempts = modelList.length
    ? modelList
    : preferredModel && !isBlockedJudgeModel(preferredModel)
      ? [preferredModel]
      : [""]

  const prompt = `CLASSIFY TASK ROUTING\n\nYou are classifying a task into one routing category.\n\nTask summary:\n${context.taskSummary}\n\nTask type: ${context.taskType}\n\nRecent user messages:\n${context.humanMessages.slice(0, 4).join("\n\n")}\n\nChoose exactly one category from: backend, architecture, frontend, default.\nReturn JSON only:\n{\n  "category": "backend|architecture|frontend|default"\n}`

  for (const modelSpec of attempts) {
    let classifierSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      classifierSession = data
    } catch {
      return null
    }
    if (!classifierSession?.id) return null
    judgeSessionIds.add(classifierSession.id)

    let response: string | null = null
    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""
      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: classifierSession.id },
        body
      })

      response = await waitForResponse(client, classifierSession.id)
    } catch (e) {
      reportError(e, { plugin: "reflection-3", op: "routing-classifier" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: classifierSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(classifierSession.id)
    }

    const category = parseRoutingCategory(response)
    if (category) return category
  }

  return null
}

async function loadRoutingConfig(): Promise<RoutingConfig> {
  try {
    const content = await readFile(REFLECTION_CONFIG_PATH, "utf-8")
    return parseRoutingFromYaml(content)
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  }
}

function getRoutingModel(config: RoutingConfig, category: RoutingCategory | null): { providerID: string; modelID: string } | null {
  if (!category) return null
  if (!config.enabled) return null
  const modelSpec = config.models[category] || config.models["default"] || ""
  if (!modelSpec) return null
  const parts = modelSpec.split("/")
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

async function loadReflectionModelList(): Promise<string[]> {
  try {
    const content = await readFile(REFLECTION_CONFIG_PATH, "utf-8")
    const models = parseModelListFromYaml(content)
    const filtered = models.filter((model) => {
      if (isBlockedJudgeModel(model)) {
        debug("Blocked weak reflection model:", model)
        return false
      }
      return true
    })
    if (filtered.length) debug("Loaded reflection model list:", JSON.stringify(filtered))
    return filtered
  } catch {
    return []
  }
}

async function ensureReflectionDir(directory: string): Promise<string> {
  const reflectionDir = join(directory, ".reflection")
  try {
    await mkdir(reflectionDir, { recursive: true })
  } catch {}
  return reflectionDir
}

async function writeVerdictSignal(directory: string, sessionId: string, complete: boolean, severity: string): Promise<void> {
  const reflectionDir = await ensureReflectionDir(directory)
  const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
  const signal = {
    sessionId: sessionId.slice(0, 8),
    complete,
    severity,
    timestamp: Date.now()
  }
  try {
    await writeFile(signalPath, JSON.stringify(signal))
    debug("Wrote verdict signal:", signalPath)
  } catch (e) {
    debug("Failed to write verdict signal:", String(e))
    reportError(e, { plugin: "reflection-3", op: "write-verdict-signal" })
  }
}

async function saveReflectionData(directory: string, sessionId: string, data: any): Promise<void> {
  const reflectionDir = await ensureReflectionDir(directory)
  const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
  const filepath = join(reflectionDir, filename)
  try {
    await writeFile(filepath, JSON.stringify(data, null, 2))
  } catch {}
}

async function waitForResponse(client: any, sessionId: string): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    try {
      const { data } = await client.session.messages({ path: { id: sessionId } })
      const messages = Array.isArray(data) ? data : []
      const assistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
      if (!(assistantMsg?.info?.time as any)?.completed) continue
      for (const part of assistantMsg?.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    } catch {}
  }
  return null
}

function inferTaskType(text: string): TaskType {
  if (/research|investigate|analyze|compare|evaluate|study/i.test(text)) return "research"
  if (/docs?|readme|documentation/i.test(text)) return "docs"
  // Ops detection: explicit ops terms and personal-assistant / browser-automation patterns
  // Must be checked BEFORE coding to avoid "create filter" or "build entities" matching as coding
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return "ops"
  if (/\bgmail\b|\bemail\b|\bfilter\b|\binbox\b|\bcalendar\b|\blinkedin\b|\brecruiter\b|\bbrowser\b/i.test(text)) return "ops"
  if (/\bclean\s*up\b|\borganize\b|\bconfigure\b|\bsetup\b|\bset\s*up\b|\binstall\b/i.test(text)) return "ops"
  if (/fix|bug|issue|error|regression/i.test(text)) return "coding"
  if (/implement|add|create|build|feature|refactor|improve|update/i.test(text)) return "coding"
  return "other"
}

async function hasPath(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function getRepoSignals(directory: string): Promise<{ hasTestScript: boolean; hasBuildScript: boolean; hasTestsDir: boolean }>{
  let hasTestScript = false
  let hasBuildScript = false
  const packagePath = join(directory, "package.json")
  try {
    const content = await readFile(packagePath, "utf-8")
    const pkg = JSON.parse(content)
    const scripts = pkg?.scripts || {}
    hasTestScript = Boolean(scripts.test || scripts["test:ci"] || scripts["test:e2e"])
    hasBuildScript = Boolean(scripts.build || scripts["build:prod"])
  } catch {}

  const hasTestsDir = (await hasPath(join(directory, "test"))) || (await hasPath(join(directory, "tests")))
  return { hasTestScript, hasBuildScript, hasTestsDir }
}

function extractToolCommands(messages: any[]): string[] {
  const commands: string[] = []
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "tool" && part.tool === "bash") {
        const command = part.state?.input?.command
        if (typeof command === "string" && command.trim()) {
          commands.push(command)
        }
      }
    }
  }
  return commands
}

function detectSignals(humanText: string, commands: string[]): string[] {
  const signals: string[] = []
  if (/test|tests|pytest|jest|unit|e2e|integration/i.test(humanText)) signals.push("test-mention")
  if (/build|compile|bundle|release/i.test(humanText)) signals.push("build-mention")
  if (/pull request|\bPR\b|merge request/i.test(humanText)) signals.push("pr-mention")
  if (/ci|checks|github actions/i.test(humanText)) signals.push("ci-mention")

  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+test\b|pytest\b|go\s+test\b|cargo\s+test\b/i.test(cmd))) {
    signals.push("test-command")
  }
  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+run\s+build\b|cargo\s+build\b|go\s+build\b/i.test(cmd))) {
    signals.push("build-command")
  }
  if (commands.some(cmd => /\bgh\s+pr\b/i.test(cmd))) signals.push("gh-pr")
  if (commands.some(cmd => /\bgh\s+issue\b/i.test(cmd))) signals.push("gh-issue")
  if (commands.some(cmd => /\bgh\s+pr\s+create\b/i.test(cmd))) signals.push("gh-pr-create")
  if (commands.some(cmd => /\bgh\s+pr\s+view\b/i.test(cmd))) signals.push("gh-pr-view")
  if (commands.some(cmd => /\bgh\s+pr\s+status\b/i.test(cmd))) signals.push("gh-pr-status")
  if (commands.some(cmd => /\bgh\s+pr\s+checks\b/i.test(cmd))) signals.push("gh-pr-checks")
  if (commands.some(cmd => /\bgit\s+push\b/i.test(cmd))) signals.push("git-push")
  return signals
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim()
}

function getRecentCommands(commands: string[], limit = 20): string[] {
  return commands.map(normalizeCommand).slice(-limit)
}

function hasLocalTestCommand(commands: string[]): boolean {
  return commands.some(cmd =>
    /\bnpm\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+typecheck\b/i.test(cmd) ||
    /\bpnpm\s+test\b/i.test(cmd) ||
    /\byarn\s+test\b/i.test(cmd) ||
    /\bpytest\b/i.test(cmd) ||
    /\bgo\s+test\b/i.test(cmd) ||
    /\bcargo\s+test\b/i.test(cmd)
  )
}

function pushedToDefaultBranch(commands: string[]): boolean {
  return commands.some(cmd =>
    /\bgit\s+push\b.*\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\borigin\b\s+\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\bHEAD:(main|master)\b/i.test(cmd)
  )
}

async function buildTaskContext(messages: any[], directory: string): Promise<TaskContext | null> {
  if (!Array.isArray(messages)) return null
  const humanMessages: string[] = []
  let lastAssistantText = ""

  for (const msg of messages) {
    if (msg.info?.role === "user") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) continue
          humanMessages.push(part.text)
          break
        }
      }
    }
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          lastAssistantText = part.text
        }
      }
    }
  }

  if (humanMessages.length === 0) return null

  const taskSummary = humanMessages.length === 1
    ? humanMessages[0]
    : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")

  const combinedText = `${humanMessages.join(" ")} ${lastAssistantText}`
  const taskType = inferTaskType(combinedText)
  const agentMode: AgentMode = isPlanMode(messages) ? "plan" : "build"

  const repoSignals = await getRepoSignals(directory)
  const commands = extractToolCommands(messages)
  const detectedSignals = detectSignals(combinedText, commands)
  const recentCommands = getRecentCommands(commands)
  const hasLocalTests = hasLocalTestCommand(commands)
  const pushedDefault = pushedToDefaultBranch(commands)

  const requiresTests = taskType === "coding" && (repoSignals.hasTestScript || repoSignals.hasTestsDir || detectedSignals.includes("test-mention"))
  const requiresBuild = taskType === "coding" && (repoSignals.hasBuildScript || detectedSignals.includes("build-mention"))
  // PR and CI are only required for coding tasks; ops/personal-assistant tasks don't need them
  const requiresPR = taskType === "coding"
  const requiresCI = taskType === "coding"
  const requiresLocalTests = requiresTests
  const requiresLocalTestsEvidence = requiresTests && !hasLocalTests

  const toolsSummary = commands.slice(-6).join("\n") || "(none)"

  return {
    taskSummary,
    taskType,
    agentMode,
    humanMessages,
    toolsSummary,
    detectedSignals,
    recentCommands,
    pushedToDefaultBranch: pushedDefault,
    requiresTests,
    requiresBuild,
    requiresPR,
    requiresCI,
    requiresLocalTests,
    requiresLocalTestsEvidence
  }
}

function extractLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    }
  }
  return ""
}

function buildSelfAssessmentPrompt(context: TaskContext, agents: string, lastAssistantText?: string): string {
  const safeContext = {
    ...context,
    detectedSignals: Array.isArray(context.detectedSignals) ? context.detectedSignals : []
  }
  const requirements: string[] = []
  if (safeContext.requiresTests) requirements.push("Tests required (run after latest changes)")
  if (safeContext.requiresBuild) requirements.push("Build/compile required")
  if (safeContext.requiresPR) requirements.push("PR required (include link)")
  if (safeContext.requiresCI) requirements.push("CI checks required (verify status)")
  if (safeContext.requiresLocalTests) requirements.push("Local tests required (must run in this session)")
  if (safeContext.pushedToDefaultBranch) requirements.push("Detected direct push to default branch (must be avoided)")
  if (requirements.length === 0) requirements.push("No explicit workflow gates detected")

  const signalSummary = safeContext.detectedSignals.length ? safeContext.detectedSignals.join(", ") : "none"

  const assistantSection = lastAssistantText
    ? `\n## Agent's Last Response\n${lastAssistantText.slice(0, 4000)}\n`
    : ""

  return `SELF-ASSESS REFLECTION-3

You are evaluating an agent's work against workflow requirements.
Analyze the task context, the agent's last response, and the tool signals to determine whether the task is complete.

## Task Context
- Summary: ${safeContext.taskSummary}
- Type: ${safeContext.taskType}
- Mode: ${safeContext.agentMode}
- Required checks: ${requirements.join("; ")}
- Detected signals: ${signalSummary}

## Tool Commands Run
${safeContext.toolsSummary}
${assistantSection}
${agents ? `## Project Instructions\n${agents.slice(0, 800)}\n\n` : ""}Return JSON only:
{
  "task_summary": "brief description of what was done",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.95,
  "evidence": {
    "tests": { 
      "ran": true,
      "results": "pass|fail|unknown",
      "ran_after_changes": true,
      "commands": ["npm test", "pytest"]
    },
    "build": { 
      "ran": true,
      "results": "pass|fail|unknown"
    },
    "pr": { 
      "created": true,
      "url": "https://github.com/...",
      "ci_status": "pass|fail|unknown",
      "checked": true
    }
  },
  "remaining_work": ["list any incomplete items"],
  "next_steps": ["list next actions needed"],
  "needs_user_action": ["list any actions requiring user input"],
  "stuck": false,
  "alternate_approach": "describe if needed"
}

Rules:
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- Tests cannot be skipped or marked as flaky/not important.
- Direct pushes to main/master are not allowed; require a PR instead.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials), list it in needs_user_action.`
}

function parseSelfAssessmentJson(text: string | null | undefined): SelfAssessment | null {
  if (typeof text !== "string") return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0]) as SelfAssessment
  } catch (e) {
    reportError(e, { plugin: "reflection-3", op: "parse-self-assessment" })
    return null
  }
}

function evaluateSelfAssessment(assessment: SelfAssessment, context: TaskContext): ReflectionAnalysis {
  const safeContext: TaskContext = {
    taskSummary: context?.taskSummary || "",
    taskType: context?.taskType || "other",
    agentMode: context?.agentMode || "unknown",
    humanMessages: Array.isArray(context?.humanMessages) ? context.humanMessages : [],
    toolsSummary: context?.toolsSummary || "(none)",
    detectedSignals: Array.isArray(context?.detectedSignals) ? context.detectedSignals : [],
    recentCommands: Array.isArray(context?.recentCommands) ? context.recentCommands : [],
    pushedToDefaultBranch: !!context?.pushedToDefaultBranch,
    requiresTests: !!context?.requiresTests,
    requiresBuild: !!context?.requiresBuild,
    requiresPR: !!context?.requiresPR,
    requiresCI: !!context?.requiresCI,
    requiresLocalTests: !!context?.requiresLocalTests,
    requiresLocalTestsEvidence: !!context?.requiresLocalTestsEvidence
  }
  const missing: string[] = []
  const nextActions: string[] = []
  const remaining = assessment.remaining_work || []
  const needsUserAction = assessment.needs_user_action || []
  const status = assessment.status || "in_progress"
  const confidence = assessment.confidence ?? 0.5
  const stuck = assessment.stuck === true

  const tests = assessment.evidence?.tests || {}
  const build = assessment.evidence?.build || {}
  const pr = assessment.evidence?.pr || {}
  const hasPrSignal = safeContext.detectedSignals.includes("gh-pr-create") || safeContext.detectedSignals.includes("gh-pr")
  const hasCiSignal = safeContext.detectedSignals.includes("gh-pr-checks") || safeContext.detectedSignals.includes("gh-pr-view") || safeContext.detectedSignals.includes("gh-pr-status")

  const addMissing = (item: string, action?: string) => {
    if (!missing.includes(item)) missing.push(item)
    if (action && !nextActions.includes(action)) nextActions.push(action)
  }

  if (remaining.length) {
    for (const item of remaining) addMissing(item)
  }

  if (safeContext.requiresTests) {
    if (tests.ran !== true) {
      addMissing("Run tests", "Run the full test suite and capture output")
    } else {
      if (tests.skipped === true || typeof tests.skip_reason === "string") {
        addMissing("Do not skip required tests", "Run required tests and document passing results")
      }
      if (tests.results !== "pass") {
        addMissing("Fix failing tests", "Fix failing tests and re-run")
      }
      if (tests.ran_after_changes !== true) {
        addMissing("Re-run tests after latest changes", "Re-run tests after latest changes")
      }
    }
  }

  if (safeContext.requiresLocalTests) {
    const ranCommands = tests.commands || []
    if (ranCommands.length === 0) {
      addMissing("Provide local test commands", "Run local tests and include commands in self-assessment")
    } else {
      const normalizedRecent = safeContext.recentCommands.map(normalizeCommand)
      const normalizedEvidence = ranCommands.map(normalizeCommand)
      const hasMatch = normalizedEvidence.some(cmd => normalizedRecent.includes(cmd))
      if (!hasMatch) {
        addMissing("Provide local test commands from this session", "Run local tests in this session and include exact commands")
      }
    }
  }

  if (safeContext.requiresBuild) {
    if (build.ran !== true) {
      addMissing("Run build/compile", "Run the build/compile step and confirm success")
    } else if (build.results !== "pass") {
      addMissing("Fix build failures", "Fix build errors and re-run")
    }
  }

  if (safeContext.requiresPR) {
    if (pr.created !== true) {
      addMissing("Create PR", "Create a pull request with summary and checklist")
    } else if (safeContext.requiresCI) {
      if (!pr.url) {
        addMissing("Provide PR link", "Include the PR URL in the self-assessment")
      }
      if (!hasPrSignal) {
        addMissing("Provide PR creation evidence", "Create the PR using gh or include evidence of PR creation")
      }
      if (pr.checked !== true) {
        addMissing("Verify CI checks", "Run `gh pr checks` or `gh pr view` and report results")
      } else if (pr.ci_status !== "pass") {
        addMissing("Fix failing CI", "Fix CI failures and re-run checks")
      }
      if (!hasCiSignal) {
        addMissing("Provide CI check evidence", "Use `gh pr checks` or `gh pr view` and include results")
      }
    }
  }

  if (safeContext.pushedToDefaultBranch) {
    addMissing("Avoid direct push to default branch", "Revert direct push and open a PR instead")
  }

  if (stuck) {
    addMissing("Rethink approach", "Propose an alternate approach and continue")
  }

  const requiresHumanAction = needsUserAction.length > 0
  // Agent should continue if there are missing items beyond what only the user can do.
  // Even when user action is needed (e.g. "merge PR"), the agent may still have
  // actionable work (e.g. uncommitted changes, missing tests) it can complete first.
  const agentActionableMissing = missing.filter(item =>
    !needsUserAction.some(ua => item.toLowerCase().includes(ua.toLowerCase()) || ua.toLowerCase().includes(item.toLowerCase()))
  )
  const shouldContinue = agentActionableMissing.length > 0 || (!requiresHumanAction && missing.length > 0)
  const complete = status === "complete" && missing.length === 0 && confidence >= 0.8 && !requiresHumanAction

  let severity: ReflectionAnalysis["severity"] = "NONE"
  if (missing.some(item => /test|build/i.test(item))) severity = "HIGH"
  else if (missing.some(item => /CI|check/i.test(item))) severity = "MEDIUM"
  else if (missing.length > 0) severity = "LOW"

  if (requiresHumanAction && missing.length === 0) severity = "LOW"

  const reason = complete
    ? "Self-assessment confirms completion with required evidence"
    : requiresHumanAction
      ? "User action required before continuing"
      : missing.length
        ? "Missing required workflow steps"
        : "Task not confirmed complete"

  if (assessment.next_steps?.length) {
    for (const step of assessment.next_steps) {
      if (!nextActions.includes(step)) nextActions.push(step)
    }
  }

  return { complete, shouldContinue, reason, missing, nextActions, requiresHumanAction, severity }
}

async function analyzeSelfAssessmentWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  selfAssessment: string,
  judgeSessionIds: Set<string>
): Promise<ReflectionAnalysis | null> {
  const modelList = await loadReflectionModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  const attempts = modelList.length
    ? modelList
    : preferredModel && !isBlockedJudgeModel(preferredModel)
      ? [preferredModel]
      : [""]

  const prompt = `ANALYZE REFLECTION-3

You are validating an agent's self-assessment against workflow requirements.

## Task Summary
${context.taskSummary}

## Task Type
${context.taskType}

## Workflow Requirements
- Tests required: ${context.requiresTests}
- Build required: ${context.requiresBuild}
- PR required: ${context.requiresPR}
- CI checks required: ${context.requiresCI}
- Local test commands required: ${context.requiresLocalTests}

## Tool Signals
${context.toolsSummary}

## Agent Self-Assessment
${selfAssessment.slice(0, 4000)}

Rules:
- If tests are required, agent must confirm tests ran AFTER latest changes and passed.
- If local test commands are required, agent must list the exact commands run in this session.
- If tests were skipped/flaky/not important, task is incomplete.
- Direct pushes to main/master are not allowed; require PR instead.
- If PR required, agent must provide PR link.
- If PR exists, CI checks must be verified and passing.
- If user action is required (auth/2FA/credentials), set requires_human_action true.
- If agent is stuck, require alternate approach and continued work.

Return JSON only:
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation",
  "missing": ["missing steps"],
  "next_actions": ["actions to take"],
  "requires_human_action": true/false
}`

  for (const modelSpec of attempts) {
    let judgeSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      judgeSession = data
    } catch {
      return null
    }
    if (!judgeSession?.id) return null
    judgeSessionIds.add(judgeSession.id)

    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""

      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body
      })

      const response = await waitForResponse(client, judgeSession.id)
      if (!response) continue

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue

      const verdict = JSON.parse(jsonMatch[0]) as any
      return {
        complete: !!verdict.complete,
        shouldContinue: !verdict.requires_human_action && !verdict.complete,
        reason: verdict.feedback || "Judge analysis completed",
        missing: Array.isArray(verdict.missing) ? verdict.missing : [],
        nextActions: Array.isArray(verdict.next_actions) ? verdict.next_actions : [],
        requiresHumanAction: !!verdict.requires_human_action,
        severity: verdict.severity || "MEDIUM"
      }
    } catch (e) {
      reportError(e, { plugin: "reflection-3", op: "judge-session" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: judgeSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  return null
}

export const Reflection3Plugin: Plugin = async ({ client, directory }) => {
  initDebugLogger(directory)
  const judgeSessionIds = new Set<string>()
  const lastReflectedMsgId = new Map<string, string>()
  const activeReflections = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()
  const attempts = new Map<string, number>()

  async function runReflection(sessionId: string): Promise<void> {
      debug("runReflection called for session:", sessionId.slice(0, 8))
      if (activeReflections.has(sessionId)) return
      activeReflections.add(sessionId)

      try {
        let messages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          messages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session not found (likely deleted), skipping reflection:", sessionId.slice(0, 8))
          return
        }
        if (!messages || messages.length < 2) return

        if (isJudgeSession(sessionId, messages, judgeSessionIds)) return
        if (isPlanMode(messages)) return

        // Issue #82: Check if session was interrupted by ESC.
        // When user presses ESC, session.idle can fire before session.error
        // writes the abort error. The last assistant message won't have
        // time.completed set. This catches aborts regardless of event ordering
        // — same approach used by TTS and Telegram plugins (isSessionComplete).
        const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
        if (lastAssistant && !(lastAssistant.info?.time as any)?.completed) {
          debug("Session interrupted (no time.completed on last assistant message), skipping reflection:", sessionId.slice(0, 8))
          return
        }

        const lastUserMsgId = getLastRelevantUserMessageId(messages)
        if (!lastUserMsgId) return

        const initialUserMsgId = lastUserMsgId
        const attemptKey = `${sessionId}:${lastUserMsgId}`
        const lastReflectedId = lastReflectedMsgId.get(sessionId)
        if (lastUserMsgId === lastReflectedId) return

        const context = await buildTaskContext(messages, directory)
        if (!context) return

        const lastAssistantText = extractLastAssistantText(messages)
        const customPrompt = await loadReflectionPrompt(directory)
        const agents = await getAgentsFile(directory)
        const reflectionPrompt = customPrompt || buildSelfAssessmentPrompt(context, agents, lastAssistantText)

        await showToast(client, directory, "Requesting reflection self-assessment...", "info")
        debug("Requesting reflection self-assessment")

        // Issue #98: Run self-assessment in a separate ephemeral session instead
        // of prompting the active agent session. Asking the active session to
        // respond in JSON poisons its context, causing subsequent replies to be
        // JSON-only.
        const modelList = await loadReflectionModelList()
        const preferredModel = await loadPreferredModelSpec(directory)
        const assessmentAttempts = modelList.length
          ? modelList
          : preferredModel && !isBlockedJudgeModel(preferredModel)
            ? [preferredModel]
            : [""]

        let selfAssessment: string | null = null
        for (const modelSpec of assessmentAttempts) {
          let assessmentSession: any
          try {
            const { data } = await client.session.create({ query: { directory } })
            assessmentSession = data
          } catch {
            debug("Failed to create self-assessment session")
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          if (!assessmentSession?.id) {
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          judgeSessionIds.add(assessmentSession.id)

          try {
            const modelParts = modelSpec ? modelSpec.split("/") : []
            const providerID = modelParts[0] || ""
            const modelID = modelParts.slice(1).join("/") || ""
            const body: any = { parts: [{ type: "text", text: reflectionPrompt }] }
            if (providerID && modelID) body.model = { providerID, modelID }

            await client.session.promptAsync({
              path: { id: assessmentSession.id },
              body
            })

            selfAssessment = await waitForResponse(client, assessmentSession.id)
            if (selfAssessment) break
          } catch (e: any) {
            debug("promptAsync failed (self-assessment):", e?.message || e)
            reportError(e, { plugin: "reflection-3", op: "prompt-self-assessment" })
            continue
          } finally {
            try {
              await client.session.delete({ path: { id: assessmentSession.id }, query: { directory } })
            } catch {}
            judgeSessionIds.delete(assessmentSession.id)
          }
        }

        if (!selfAssessment) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        debug("Self-assessment received")

        // Check if user sent a new message or aborted during assessment
        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        let currentMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          currentMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted during reflection, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const currentUserMsgId = getLastRelevantUserMessageId(currentMessages || [])
        if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          return
        }

        let analysis: ReflectionAnalysis | null = null
        const parsedAssessment = parseSelfAssessmentJson(selfAssessment)
        if (parsedAssessment) {
          analysis = evaluateSelfAssessment(parsedAssessment, context)
        } else {
          analysis = await analyzeSelfAssessmentWithLLM(client, directory, context, selfAssessment, judgeSessionIds)
        }

        if (!analysis) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, "Reflection analysis failed", "warning")
          return
        }

        debug("Reflection analysis completed")

        // Compute routing early so it can be included in saved data
        const routingConfig = await loadRoutingConfig()
        const routingCategory = await classifyTaskForRoutingWithLLM(client, directory, context, judgeSessionIds)
        const routingModel = getRoutingModel(routingConfig, routingCategory)

        await saveReflectionData(directory, sessionId, {
          task: context.taskSummary,
          assessment: selfAssessment.slice(0, 4000),
          analysis,
          routing: routingModel ? { category: routingCategory, model: routingModel } : null,
          timestamp: new Date().toISOString()
        })

        await writeVerdictSignal(directory, sessionId, analysis.complete, analysis.severity)

        if (analysis.complete) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Task complete ✓ (${analysis.severity})`, "success")
          debug("Reflection complete")
          return
        }

        if (analysis.requiresHumanAction && !analysis.shouldContinue) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          const hint = (Array.isArray(analysis.missing) && analysis.missing[0]) || "User action required"
          await showToast(client, directory, `Action needed: ${hint}`, "warning")
          debug("Reflection requires human action (no agent-actionable work remaining)")
          return
        }

        // Re-check for new user messages or abort before feedback injection
        // (analysis/judge phase can take significant time)
        let preFeedbackMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          preFeedbackMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted before feedback injection, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const preFeedbackUserMsgId = getLastRelevantUserMessageId(preFeedbackMessages || [])
        if (preFeedbackUserMsgId && preFeedbackUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          debug("User sent new message during analysis, skipping feedback")
          return
        }
        const preFeedbackAbort = recentlyAbortedSessions.get(sessionId)
        if (preFeedbackAbort) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          debug("Session aborted during analysis, skipping feedback")
          return
        }

        const nextAttemptCount = (attempts.get(attemptKey) || 0) + 1
        attempts.set(attemptKey, nextAttemptCount)
        if (nextAttemptCount >= MAX_ATTEMPTS) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
          debug("Max attempts reached for", sessionId.slice(0, 8))
          return
        }

        const loopCheck = detectPlanningLoop(preFeedbackMessages || messages)
        const feedbackText = buildEscalatingFeedback(
          nextAttemptCount,
          analysis.severity || "MEDIUM",
          {
            feedback: analysis.reason || "Task incomplete",
            missing: analysis.missing,
            next_actions: analysis.nextActions
          },
          loopCheck.detected
        )

        // Apply task-based model routing to feedback injection
        const feedbackBody: any = { parts: [{ type: "text", text: feedbackText }] }
        if (routingModel) {
          feedbackBody.model = routingModel
          debug("Routing feedback to", routingCategory, "model:", JSON.stringify(routingModel))
        }

        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: feedbackBody
          })
        } catch (e: any) {
          debug("promptAsync failed (feedback):", e?.message || e)
          reportError(e, { plugin: "reflection-3", op: "prompt-feedback" })
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        // Prevent reflection loop: mark this task as reflected so the next
        // session.idle (triggered by the agent responding to feedback) does not
        // start another reflection cycle for the same user message.
        lastReflectedMsgId.set(sessionId, lastUserMsgId)

        debug("Reflection pushed continuation")

        const routingInfo = routingModel ? ` [${routingCategory} → ${routingModel.modelID}]` : ""
        await showToast(client, directory, `Pushed agent to continue${routingInfo}`, "info")
      } finally {
        activeReflections.delete(sessionId)
      }
    }

  return {
    config: async (_config) => {
      return
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type)
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
        debug("session.idle received")
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          const elapsed = Date.now() - abortTime
          if (elapsed < ABORT_COOLDOWN) return
          recentlyAbortedSessions.delete(sessionId)
        }

        try {
          await runReflection(sessionId)
        } catch (e: any) {
          debug("runReflection error:", e?.message || e)
          reportError(e, { plugin: "reflection-3", op: "run-reflection" })
        }
      }
    }
  }
}

export default Reflection3Plugin
