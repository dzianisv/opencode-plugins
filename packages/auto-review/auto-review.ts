import { appendFile, mkdir } from "fs/promises"
import { join } from "path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

const ABORT_COOLDOWN = 10_000
const ABORT_RACE_DELAY = 1_500
const MIN_TOOL_CALLS = 3
const AUTO_REVIEW_DEBUG = process.env.AUTO_REVIEW_DEBUG === "1"

const REVIEW_MARKERS = [
  "AUTO-REVIEW",
  "AUTO REVIEW",
  "REVIEW AUTO-REVIEW",
  "Review another model's work",
  "You are reviewing another session",
]
const SELF_ASSESSMENT_MARKER = "SELF-ASSESS REFLECTION-3"
const FEEDBACK_MARKER = "REFLECTION FEEDBACK"

type SessionInfo = {
  id?: string
  parentID?: string
  directory?: string
}

type SessionPart = {
  type?: string
  text?: string
  tool?: string
  state?: {
    input?: Record<string, unknown>
  }
}

type SessionMessage = {
  id?: string
  info?: {
    role?: string
    providerID?: string
    modelID?: string
    model?: string | { providerID?: string; modelID?: string }
    time?: {
      start?: number
    }
  }
  parts?: SessionPart[]
}

type ModelSpec = {
  providerID: string
  modelID: string
}

let debug: (...args: unknown[]) => void = () => {}

function initDebugLogger(directory: string): void {
  if (!AUTO_REVIEW_DEBUG) return
  const logDir = join(directory, ".reflection")
  const logPath = join(logDir, "debug.log")
  let dirReady = false

  debug = (...args: unknown[]) => {
    const msg = args
      .map((arg) => {
        if (typeof arg === "string") return arg
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(" ")
    const line = `[${new Date().toISOString()}] [AutoReview] ${msg}\n`
    ;(async () => {
      if (!dirReady) {
        try {
          await mkdir(logDir, { recursive: true })
        } catch {}
        dirReady = true
      }
      try {
        await appendFile(logPath, line)
      } catch {}
    })()
  }
}

function parseModelSpec(spec: string | null | undefined): ModelSpec | null {
  if (typeof spec !== "string") return null
  const trimmed = spec.trim()
  if (!trimmed) return null
  const parts = trimmed.split("/")
  if (parts.length < 2) return null
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

function formatModelSpec(model: ModelSpec | null): string {
  if (!model) return ""
  return `${model.providerID}/${model.modelID}`
}

function resolveWorkModel(lastAssistant: SessionMessage | undefined): ModelSpec | null {
  if (!lastAssistant?.info) return null
  const directProvider = lastAssistant.info.providerID
  const directModel = lastAssistant.info.modelID
  if (typeof directProvider === "string" && typeof directModel === "string" && directProvider && directModel) {
    return { providerID: directProvider, modelID: directModel }
  }

  if (typeof lastAssistant.info.model === "string") {
    return parseModelSpec(lastAssistant.info.model)
  }

  if (lastAssistant.info.model && typeof lastAssistant.info.model === "object") {
    const providerID = lastAssistant.info.model.providerID
    const modelID = lastAssistant.info.model.modelID
    if (providerID && modelID) return { providerID, modelID }
  }

  return null
}

function inferReviewModels(workModel: ModelSpec | null): ModelSpec[] {
  const workSpec = formatModelSpec(workModel).toLowerCase()
  const baseCandidates = [
    "github-copilot/claude-opus-4.6",
    "github-copilot/gpt-5.2-codex",
    "github-copilot/claude-sonnet-4.6",
  ]
  const preferred =
    workModel && workModel.modelID.toLowerCase().includes("claude")
      ? "github-copilot/gpt-5.2-codex"
      : workModel && workModel.modelID.toLowerCase().includes("gpt")
        ? "github-copilot/claude-opus-4.6"
        : workModel &&
            (workModel.modelID.toLowerCase().includes("gemini") ||
              workModel.modelID.toLowerCase().includes("llama") ||
              workModel.modelID.toLowerCase().includes("deepseek"))
          ? "github-copilot/claude-opus-4.6"
          : null
  const orderedCandidates = preferred ? [preferred, ...baseCandidates] : baseCandidates

  return orderedCandidates
    .filter((candidate, index, all) => candidate.toLowerCase() !== workSpec && all.indexOf(candidate) === index)
    .map((candidate) => parseModelSpec(candidate))
    .filter((candidate): candidate is ModelSpec => Boolean(candidate))
}

function extractText(msg: SessionMessage): string {
  const texts = (msg.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text || "")
  return texts.join("\n").trim()
}

function hasReviewMarker(text: string): boolean {
  const normalized = text.toLowerCase()
  return REVIEW_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()))
}

function countToolCalls(messages: SessionMessage[]): number {
  let toolCalls = 0
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part.type === "tool") toolCalls++
    }
  }
  return toolCalls
}

function isRelevantUserBoundary(msg: SessionMessage): boolean {
  if (msg.info?.role !== "user") return false
  const text = extractText(msg)
  if (!text) return false
  if (hasReviewMarker(text)) return false
  if (text.includes(SELF_ASSESSMENT_MARKER) || text.includes(FEEDBACK_MARKER)) return false
  return true
}

function findLastRelevantUserBoundaryIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRelevantUserBoundary(messages[i])) return i
  }
  return -1
}

function findLastAssistantAfterIndex(messages: SessionMessage[], boundaryIndex: number): SessionMessage | undefined {
  for (let i = messages.length - 1; i > boundaryIndex; i--) {
    if (messages[i]?.info?.role === "assistant") return messages[i]
  }
  return undefined
}

function countToolCallsAfterIndex(messages: SessionMessage[], boundaryIndex: number): number {
  return countToolCalls(messages.slice(boundaryIndex + 1))
}

function getMessageSignature(msg: SessionMessage | undefined): string {
  if (!msg) return ""
  if (msg.id) return msg.id
  const role = msg.info?.role || "unknown"
  const time = msg.info?.time?.start || 0
  return `${role}:${time}:${extractText(msg).slice(0, 40)}`
}

export const AutoReviewPlugin: Plugin = async ({ client, directory }: PluginInput) => {
  initDebugLogger(directory)

  const active = new Set<string>()
  const reviewSessionIDs = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()
  const reviewedMessageBySession = new Map<string, string>()

  async function runReview(parentSessionID: string): Promise<void> {
    if (active.has(parentSessionID)) return
    active.add(parentSessionID)

    try {
      let sessionInfo: SessionInfo | undefined
      try {
        const { data } = await client.session.get({
          path: { id: parentSessionID },
          query: { directory },
        })
        sessionInfo = data as SessionInfo
      } catch (error) {
        debug("session.get failed", parentSessionID, error)
        return
      }

      if (sessionInfo?.parentID) {
        debug("Skipping child session", parentSessionID, sessionInfo.parentID)
        return
      }

      const sessionDirectory = sessionInfo?.directory || directory
      let messages: SessionMessage[] = []
      try {
        const { data } = await client.session.messages({
          path: { id: parentSessionID },
          query: { directory: sessionDirectory },
        })
        messages = Array.isArray(data) ? (data as SessionMessage[]) : []
      } catch (error) {
        debug("session.messages failed", parentSessionID, error)
        return
      }

      if (messages.length < 2) return

      const boundaryIndex = findLastRelevantUserBoundaryIndex(messages)
      if (boundaryIndex < 0) {
        debug("Skipping: no relevant user boundary", parentSessionID)
        return
      }
      const lastUser = messages[boundaryIndex]
      const lastAssistant = findLastAssistantAfterIndex(messages, boundaryIndex)
      const lastUserText = lastUser ? extractText(lastUser) : ""
      const lastAssistantText = lastAssistant ? extractText(lastAssistant) : ""

      if (hasReviewMarker(lastUserText) || hasReviewMarker(lastAssistantText)) {
        debug("Skipping likely review loop via marker", parentSessionID)
        return
      }

      const lastUserSig = getMessageSignature(lastUser)
      if (lastUserSig && reviewedMessageBySession.get(parentSessionID) === lastUserSig) {
        debug("Already reviewed message", parentSessionID, lastUserSig)
        return
      }

      const toolCalls = countToolCallsAfterIndex(messages, boundaryIndex)
      if (toolCalls < MIN_TOOL_CALLS) {
        debug("Skipping low-tool turn", parentSessionID, toolCalls)
        return
      }

      const workModel = resolveWorkModel(lastAssistant)
      const reviewModels = inferReviewModels(workModel)
      const workModelText = formatModelSpec(workModel) || "unknown"
      const reviewSignature = lastUserSig || getMessageSignature(lastAssistant)

      let reviewSession: SessionInfo | undefined
      try {
        const { data } = await client.session.create({
          query: { directory: sessionDirectory },
          body: { parentID: parentSessionID, title: "AUTO-REVIEW" },
        })
        reviewSession = data as SessionInfo
      } catch (error) {
        debug("session.create failed", parentSessionID, error)
        return
      }

      if (!reviewSession?.id) return
      reviewSessionIDs.add(reviewSession.id)

      let reviewCompleted = false
      for (const reviewModel of reviewModels) {
        const reviewPrompt = `AUTO-REVIEW\n\nYou are reviewing another model's just-completed task turn.\nValidate completion quality and workflow gates, then report concrete risks only.\n\nRules:\n- Scope review to work after the last relevant user message.\n- Do not repeat the task.\n- Focus on correctness, verification evidence, and missed edge cases.\n\nObserved model: ${workModelText}\nReview model: ${formatModelSpec(reviewModel)}\nTool calls in scoped turn: ${toolCalls}\n\nLast relevant user message:\n${lastUserText.slice(0, 2000) || "(none)"}\n\nLast assistant message in scoped turn:\n${lastAssistantText.slice(0, 3000) || "(none)"}\n\nChecklist to validate:\n- task completion\n- tests run/pass\n- PR exists if code changes were made\n- CI passed if applicable\n- obvious issues / bugs / missed edge cases\n\nReturn:\n1) Checklist with PASS/FAIL/UNKNOWN and brief evidence\n2) Issues (only real gaps)\n3) Final line exactly one of:\n   - Review passed — no issues found.\n   - Review failed — <brief reason>.`
        try {
          await client.session.promptAsync({
            path: { id: reviewSession.id },
            query: { directory: sessionDirectory },
            body: {
              model: reviewModel,
              parts: [{ type: "text", text: reviewPrompt }],
            },
          })
          reviewedMessageBySession.set(parentSessionID, reviewSignature)
          debug("Created review child session", {
            parentSessionID,
            reviewSessionID: reviewSession.id,
            workModel: workModelText,
            reviewModel: formatModelSpec(reviewModel),
            toolCalls,
          })
          reviewCompleted = true
          break
        } catch (error) {
          debug("promptAsync failed, trying fallback", {
            parentSessionID,
            reviewSessionID: reviewSession.id,
            reviewModel: formatModelSpec(reviewModel),
            error,
          })
        }
      }
      if (!reviewCompleted) {
        reviewedMessageBySession.set(parentSessionID, reviewSignature)
        debug("All review model fallbacks failed", {
          parentSessionID,
          reviewSessionID: reviewSession.id,
          workModel: workModelText,
          attemptedModels: reviewModels.map(formatModelSpec),
        })
      }
    } finally {
      active.delete(parentSessionID)
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID
        const errorName = event.properties?.error?.name
        if (sessionID && errorName === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionID, Date.now())
          debug("Abort cooldown started", sessionID)
        }
        return
      }

      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return

      if (reviewSessionIDs.has(sessionID)) {
        debug("Skipping review child idle", sessionID)
        return
      }

      const abortAt = recentlyAbortedSessions.get(sessionID)
      if (abortAt) {
        const elapsed = Date.now() - abortAt
        if (elapsed < ABORT_COOLDOWN) {
          debug("Skipping during abort cooldown", sessionID, elapsed)
          return
        }
        recentlyAbortedSessions.delete(sessionID)
      }

      await new Promise((resolve) => setTimeout(resolve, ABORT_RACE_DELAY))

      const raceAbortAt = recentlyAbortedSessions.get(sessionID)
      if (raceAbortAt) {
        const elapsed = Date.now() - raceAbortAt
        if (elapsed < ABORT_COOLDOWN) {
          debug("Skipping due to abort race", sessionID, elapsed)
          return
        }
        recentlyAbortedSessions.delete(sessionID)
      }

      try {
        await runReview(sessionID)
      } catch (error) {
        debug("runReview failed", sessionID, error)
      }
    },
  }
}

export default { id: "auto-review", server: AutoReviewPlugin }
