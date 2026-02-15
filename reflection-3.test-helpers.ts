export type TaskType = "coding" | "docs" | "research" | "ops" | "other"
export type AgentMode = "plan" | "build" | "unknown"

export interface WorkflowRequirements {
  requiresTests: boolean
  requiresBuild: boolean
  requiresPR: boolean
  requiresCI: boolean
  requiresLocalTests: boolean
  requiresLocalTestsEvidence: boolean
}

export interface TaskContext extends WorkflowRequirements {
  taskSummary: string
  taskType: TaskType
  agentMode: AgentMode
  humanMessages: string[]
  toolsSummary: string
  detectedSignals: string[]
  recentCommands: string[]
  pushedToDefaultBranch: boolean
}

export interface SelfAssessment {
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

export interface ReflectionAnalysis {
  complete: boolean
  shouldContinue: boolean
  reason: string
  missing: string[]
  nextActions: string[]
  requiresHumanAction: boolean
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
}

export function inferTaskType(text: string): TaskType {
  const hasResearch = /research|investigate|analyze|compare|evaluate|study/i.test(text)
  const hasCodingAction = /\bfix\b|implement|add|create|build|feature|refactor|improve|update/i.test(text)
  const hasCodingSignal = /\bbug\b|\berror\b|\bregression\b/i.test(text)
  const hasGitHubIssue = /github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/i.test(text)

  // When text contains both research AND coding-action keywords (e.g. "investigate and fix this bug"),
  // or references a GitHub issue URL alongside research terms, prefer coding —
  // these are almost always coding tasks even if the description says "investigate".
  // Note: coding-signal words (bug, error, regression) alone don't override research,
  // because "investigate performance regressions" is legitimate research.
  if (hasResearch && (hasCodingAction || hasGitHubIssue)) return "coding"

  if (hasResearch) return "research"
  if (/docs?|readme|documentation/i.test(text)) return "docs"
  // Ops detection: explicit ops terms and personal-assistant / browser-automation patterns
  // Must be checked BEFORE coding to avoid "create filter" or "build entities" matching as coding
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return "ops"
  if (/\bgmail\b|\bemail\b|\bfilter\b|\binbox\b|\bcalendar\b|\blinkedin\b|\brecruiter\b|\bbrowser\b/i.test(text)) return "ops"
  if (/\bclean\s*up\b|\borganize\b|\bconfigure\b|\bsetup\b|\bset\s*up\b|\binstall\b/i.test(text)) return "ops"
  if (hasCodingAction || hasCodingSignal) return "coding"
  return "other"
}

export function buildSelfAssessmentPrompt(context: TaskContext, agents: string, lastAssistantText?: string): string {
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

export function parseSelfAssessmentJson(text: string | null | undefined): SelfAssessment | null {
  if (typeof text !== "string") return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0]) as SelfAssessment
  } catch {
    return null
  }
}

export function evaluateSelfAssessment(assessment: SelfAssessment, context: TaskContext): ReflectionAnalysis {
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
      const normalizedRecent = safeContext.recentCommands.map(cmd => cmd.replace(/\s+/g, " ").trim())
      const normalizedEvidence = ranCommands.map(cmd => cmd.replace(/\s+/g, " ").trim())
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

export type RoutingCategory = "backend" | "architecture" | "frontend" | "default"

export interface RoutingConfig {
  enabled: boolean
  models: Record<RoutingCategory, string>
}


export function parseRoutingFromYaml(content: string): RoutingConfig {
  const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
    enabled: false,
    models: { backend: "", architecture: "", frontend: "", default: "" }
  }
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

export function getRoutingModel(config: RoutingConfig, category: RoutingCategory): { providerID: string; modelID: string } | null {
  if (!config.enabled) return null
  const modelSpec = config.models[category] || config.models["default"] || ""
  if (!modelSpec) return null
  const parts = modelSpec.split("/")
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

const FEEDBACK_MARKER = "## Reflection-3:"
const MAX_ATTEMPTS = 5

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
