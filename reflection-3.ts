/**
 * Reflection-3 Plugin for OpenCode
 *
 * Consolidated reflection layer that combines self-assessment with workflow checks.
 * Uses a dynamic prompt (task + workflow requirements) unless reflection.md overrides it.
 * Ensures tests/build/PR/CI checks are verified before completion.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir, stat } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
const SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
const FEEDBACK_MARKER = "## Reflection-3:"

type TaskType = "coding" | "docs" | "research" | "ops" | "other"
type AgentMode = "plan" | "build" | "unknown"

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

const JUDGE_RESPONSE_TIMEOUT = 120_000
const POLL_INTERVAL = 2_000
const ABORT_COOLDOWN = 10_000
const REFLECTION_CONFIG_PATH = join(homedir(), ".config", "opencode", "reflection.yaml")

// Debug logging (silenced — console.error corrupts the OpenCode TUI)
function debug(..._args: any[]) {}

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
      if (part.type === "text" && part.text?.includes("ANALYZE REFLECTION-3")) {
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

async function loadReflectionModelList(): Promise<string[]> {
  try {
    const content = await readFile(REFLECTION_CONFIG_PATH, "utf-8")
    const models = parseModelListFromYaml(content)
    if (models.length) debug("Loaded reflection model list:", JSON.stringify(models))
    return models
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

function inferTaskType(text: string): TaskType {
  if (/research|investigate|analyze|compare|evaluate|study/i.test(text)) return "research"
  if (/docs?|readme|documentation/i.test(text)) return "docs"
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return "ops"
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
  const requiresPR = true
  const requiresCI = true
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

function buildSelfAssessmentPrompt(context: TaskContext, agents: string): string {
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

  return `${SELF_ASSESSMENT_MARKER}

Task summary:
${safeContext.taskSummary}

Agent mode: ${safeContext.agentMode}
Detected task type: ${safeContext.taskType}
Workflow gates: ${requirements.join("; ")}
Signals: ${signalSummary}

${agents ? `Project instructions (follow them):\n${agents.slice(0, 800)}\n\n` : ""}Respond with JSON only:
{
  "task_summary": "...",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.0,
  "evidence": {
    "tests": { "ran": true/false, "results": "pass|fail|unknown", "ran_after_changes": true/false, "commands": ["..."] },
    "build": { "ran": true/false, "results": "pass|fail|unknown" },
    "pr": { "created": true/false, "url": "", "ci_status": "pass|fail|unknown", "checked": true/false }
  },
  "remaining_work": ["..."],
  "next_steps": ["..."],
  "needs_user_action": ["..."],
  "stuck": true/false,
  "alternate_approach": ""
}

Rules:
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- If tests were skipped or marked flaky/not important, the task is incomplete.
- Direct pushes to main/master are not allowed; require a PR instead.
- Provide a PR URL and CI status when a PR is required.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials), list it in needs_user_action.`
}

function parseSelfAssessmentJson(text: string | null | undefined): SelfAssessment | null {
  if (typeof text !== "string") return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0]) as SelfAssessment
  } catch {
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
  const shouldContinue = !requiresHumanAction && missing.length > 0
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
  const attempts = modelList.length ? modelList : [""]

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
    const { data: judgeSession } = await client.session.create({ query: { directory } })
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
    } catch {
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
  const judgeSessionIds = new Set<string>()
  const lastReflectedMsgId = new Map<string, string>()
  const activeReflections = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()

  async function runReflection(sessionId: string): Promise<void> {
      if (activeReflections.has(sessionId)) return
      activeReflections.add(sessionId)

      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        if (!messages || messages.length < 2) return

        if (isJudgeSession(sessionId, messages, judgeSessionIds)) return
        if (isPlanMode(messages)) return

        const lastUserMsgId = getLastRelevantUserMessageId(messages)
        if (!lastUserMsgId) return

        const initialUserMsgId = lastUserMsgId
        const lastReflectedId = lastReflectedMsgId.get(sessionId)
        if (lastUserMsgId === lastReflectedId) return

        const context = await buildTaskContext(messages, directory)
        if (!context) return

        const customPrompt = await loadReflectionPrompt(directory)
        const agents = await getAgentsFile(directory)
        const reflectionPrompt = customPrompt || buildSelfAssessmentPrompt(context, agents)

        await showToast(client, directory, "Requesting reflection self-assessment...", "info")

        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: reflectionPrompt }] }
          })
        } catch (e: any) {
          debug("promptAsync failed (self-assessment):", e?.message || e)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        const selfAssessment = await waitForResponse(client, sessionId)
        if (!selfAssessment) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        debug("Self-assessment received")

        const { data: currentMessages } = await client.session.messages({ path: { id: sessionId } })
        const currentUserMsgId = getLastRelevantUserMessageId(currentMessages || [])
        if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          return
        }

        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
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
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, "Reflection analysis failed", "warning")
          return
        }

        debug("Reflection analysis completed")

        await saveReflectionData(directory, sessionId, {
          task: context.taskSummary,
          assessment: selfAssessment.slice(0, 4000),
          analysis,
          timestamp: new Date().toISOString()
        })

        await writeVerdictSignal(directory, sessionId, analysis.complete, analysis.severity)

        if (analysis.complete) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Task complete ✓ (${analysis.severity})`, "success")
          debug("Reflection complete")
          return
        }

        if (analysis.requiresHumanAction) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          const hint = analysis.missing[0] || "User action required"
          await showToast(client, directory, `Action needed: ${hint}`, "warning")
          debug("Reflection requires human action")
          return
        }

        // Re-check for new user messages or abort before feedback injection
        // (analysis/judge phase can take significant time)
        const { data: preFeedbackMessages } = await client.session.messages({ path: { id: sessionId } })
        const preFeedbackUserMsgId = getLastRelevantUserMessageId(preFeedbackMessages || [])
        if (preFeedbackUserMsgId && preFeedbackUserMsgId !== initialUserMsgId) {
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          debug("User sent new message during analysis, skipping feedback")
          return
        }
        const preFeedbackAbort = recentlyAbortedSessions.get(sessionId)
        if (preFeedbackAbort) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          debug("Session aborted during analysis, skipping feedback")
          return
        }

        const feedbackLines: string[] = []
        feedbackLines.push(`${FEEDBACK_MARKER} Task incomplete.`)
        if (analysis.reason) feedbackLines.push(`Reason: ${analysis.reason}`)
        if (analysis.missing.length) feedbackLines.push(`Missing: ${analysis.missing.join("; ")}`)
        if (analysis.nextActions.length) feedbackLines.push(`Next actions: ${analysis.nextActions.join("; ")}`)

        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: feedbackLines.join("\n") }] }
          })
        } catch (e: any) {
          debug("promptAsync failed (feedback):", e?.message || e)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        // Prevent reflection loop: mark this task as reflected so the next
        // session.idle (triggered by the agent responding to feedback) does not
        // start another reflection cycle for the same user message.
        lastReflectedMsgId.set(sessionId, lastUserMsgId)

        debug("Reflection pushed continuation")

        await showToast(client, directory, "Pushed agent to continue", "info")
      } finally {
        activeReflections.delete(sessionId)
      }
    }

  return {
    config: async (_config) => {
      return
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
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
        }
      }
    }
  }
}

export default Reflection3Plugin
