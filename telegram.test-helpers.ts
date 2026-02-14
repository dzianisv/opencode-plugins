/**
 * Test helpers for the Telegram plugin.
 *
 * OpenCode's plugin loader treats every named export as a plugin, so
 * telegram.ts can only have a default export.  This file duplicates the
 * pure-logic functions so they can be imported directly by unit tests.
 *
 * Keep in sync with telegram.ts — any change to the originals must be
 * reflected here.
 */

import { readFile } from "fs/promises"
import { join } from "path"

// ==================== TYPES ====================

export interface TelegramConfig {
  enabled?: boolean
  uuid?: string
  serviceUrl?: string
  sendText?: boolean
  sendVoice?: boolean
  receiveReplies?: boolean
  supabaseUrl?: string
  supabaseAnonKey?: string
  reflection?: {
    waitForVerdict?: boolean
    maxWaitMs?: number
  }
  whisper?: {
    enabled?: boolean
    serverUrl?: string
    port?: number
    model?: string
    device?: string
  }
}

export interface TelegramReply {
  id: string
  uuid: string
  session_id: string
  directory: string | null
  reply_text: string | null
  telegram_message_id: number
  telegram_chat_id: number
  created_at: string
  processed: boolean
  is_voice?: boolean
  audio_base64?: string | null
  voice_file_type?: string | null
  voice_duration_seconds?: number | null
}

export interface ReflectionVerdict {
  sessionId: string
  complete: boolean
  severity: string
  timestamp: number
}

// ==================== SESSION HELPERS ====================

const REFLECTION_SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
const REFLECTION_FEEDBACK_MARKER = "## Reflection-3:"

// Markers used by reflection plugins in internal evaluation sessions.
// Sessions containing these are NOT user-facing and must never be posted to Telegram.
export const INTERNAL_SESSION_MARKERS = [
  "ANALYZE REFLECTION-3",   // reflection-3 judge sessions
  "CLASSIFY TASK ROUTING",  // reflection-3 task routing classifier
  "TASK VERIFICATION",      // legacy reflection judge sessions
  "You are a judge",        // legacy judge sessions
  "Task to evaluate",       // legacy judge sessions
]

/**
 * Detect internal reflection/judge sessions by scanning ALL messages for known markers.
 * Mirrors telegram.ts:isJudgeSession
 */
export function isJudgeSession(messages: any[]): boolean {
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && part.text) {
        for (const marker of INTERNAL_SESSION_MARKERS) {
          if (part.text.includes(marker)) return true
        }
      }
    }
  }
  return false
}

/**
 * Determine whether a session has completed (last assistant message has
 * time.completed set).
 * Mirrors telegram.ts:isSessionComplete
 */
export function isSessionComplete(messages: any[]): boolean {
  const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
  if (!lastAssistant) return false
  if (lastAssistant.info?.error) return false
  return !!(lastAssistant.info?.time as any)?.completed
}

/**
 * Find the index of the first user message that contains a Reflection-3
 * self-assessment or feedback marker.
 * Mirrors telegram.ts:findStaticReflectionPromptIndex
 */
export function findStaticReflectionPromptIndex(messages: any[]): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info?.role !== "user") continue
    for (const part of msg.parts || []) {
      if (
        part.type === "text" &&
        (part.text?.includes(REFLECTION_SELF_ASSESSMENT_MARKER) ||
          part.text?.includes(REFLECTION_FEEDBACK_MARKER))
      ) {
        return i
      }
    }
  }
  return -1
}

/**
 * Returns true if the text looks like a reflection self-assessment JSON
 * response (e.g. '{"status":"complete","confidence":0.9,...}').
 * These are internal reflection artifacts and should never appear in
 * Telegram notifications.
 * Mirrors telegram.ts:isSelfAssessmentJson
 */
export function isSelfAssessmentJson(text: string): boolean {
  if (!text) return false
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return false
  try {
    const parsed = JSON.parse(jsonMatch[0])
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.status === "string" &&
      ("confidence" in parsed || "evidence" in parsed || "task_summary" in parsed)
    )
  } catch {
    return false
  }
}

/**
 * Find the index of the LAST reflection feedback marker (## Reflection-3:).
 * Mirrors telegram.ts:findLastReflectionFeedbackIndex
 */
export function findLastReflectionFeedbackIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role !== "user") continue
    for (const part of msg.parts || []) {
      if (
        part.type === "text" &&
        part.text?.includes(REFLECTION_FEEDBACK_MARKER)
      ) {
        return i
      }
    }
  }
  return -1
}

/** Extract joined text from an assistant message, trimmed. Mirrors telegram.ts:extractAssistantText */
function extractAssistantText(msg: any): string {
  const textParts = (msg.parts || [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text || "")
  return textParts.join("\n").trim()
}

/**
 * Extract the final user-visible assistant response, skipping any
 * Reflection-3 artifacts.
 * Mirrors telegram.ts:extractFinalResponse
 */
export function extractFinalResponse(messages: any[]): string {
  const firstReflectionIndex = findStaticReflectionPromptIndex(messages)

  // No reflection ran — return the last non-empty assistant message
  if (firstReflectionIndex === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role !== "assistant") continue
      const text = extractAssistantText(msg)
      if (text) return text
    }
    return ""
  }

  // Reflection ran. Check if there was feedback (INCOMPLETE → agent did more work).
  const lastFeedbackIndex = findLastReflectionFeedbackIndex(messages)
  if (lastFeedbackIndex > -1) {
    // Look for a non-JSON assistant response AFTER the last feedback.
    for (let i = messages.length - 1; i > lastFeedbackIndex; i--) {
      const msg = messages[i]
      if (msg.info?.role !== "assistant") continue
      const text = extractAssistantText(msg)
      if (text && !isSelfAssessmentJson(text)) return text
    }
  }

  // Fall back to the assistant message just before the first reflection marker.
  for (let i = firstReflectionIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role !== "assistant") continue
    const text = extractAssistantText(msg)
    if (text) return text
  }

  return ""
}

// ==================== NOTIFICATION FORMATTING ====================

/**
 * Format the notification text with header and reply hint.
 * Extracted from sendNotification in telegram.ts.
 */
export function formatNotificationText(
  text: string,
  context?: { model?: string; directory?: string; sessionId?: string }
): string {
  const dirName = context?.directory?.split("/").pop() || null
  const sessionId = context?.sessionId || null
  const modelName = context?.model || null

  const headerParts = [dirName, sessionId, modelName].filter(Boolean)
  const header = headerParts.join(" | ")
  const replyHint = sessionId ? "\n\n💬 Reply to this message to continue" : ""

  const formattedText = header
    ? `${header}\n${"─".repeat(Math.min(40, header.length))}\n\n${text}${replyHint}`
    : `${text}${replyHint}`

  return formattedText.slice(0, 3800)
}

/**
 * Validate sendNotification preconditions without making network calls.
 * Returns { canSend, error? } to indicate whether the real sendNotification
 * would proceed.
 */
export function validateNotificationConfig(
  config: TelegramConfig,
  text: string | null,
  voicePath: string | null
): { canSend: boolean; error?: string } {
  if (!config?.enabled) {
    return { canSend: false, error: "Telegram notifications disabled" }
  }

  const uuid = config.uuid || process.env.TELEGRAM_NOTIFICATION_UUID
  if (!uuid) {
    return { canSend: false, error: "No UUID configured for Telegram notifications" }
  }

  const sendText = config.sendText !== false
  const sendVoice = config.sendVoice !== false

  const hasTextContent = sendText && !!text
  const hasVoiceContent = sendVoice && !!voicePath

  if (!hasTextContent && !hasVoiceContent) {
    return { canSend: false, error: "No content to send" }
  }

  return { canSend: true }
}

// ==================== REPLY ROUTING ====================

/**
 * Build the prefix for an injected Telegram reply.
 */
export function buildReplyPrefix(isVoice: boolean): string {
  return isVoice ? "[User via Telegram Voice]" : "[User via Telegram]"
}

/**
 * Determine the audio format for Whisper transcription from the Telegram
 * voice_file_type field.
 */
export function voiceFileTypeToFormat(voiceFileType: string | null | undefined): string {
  if (voiceFileType === "voice") return "ogg"
  if (voiceFileType === "video_note") return "mp4"
  if (voiceFileType === "video") return "mp4"
  return "ogg"
}

/**
 * Check whether a reply has enough information to be routed to a session.
 */
export function canRouteReply(reply: TelegramReply): {
  routable: boolean
  reason?: string
} {
  if (!reply.session_id) {
    return { routable: false, reason: "No session_id in reply" }
  }

  const hasText = !!reply.reply_text
  const hasVoice = reply.is_voice && !!reply.audio_base64

  if (!hasText && !hasVoice) {
    return { routable: false, reason: "No text or voice content" }
  }

  return { routable: true }
}

// ==================== REFLECTION VERDICT GATING ====================

const REFLECTION_POLL_INTERVAL_MS = 250

/**
 * Poll for a reflection verdict file and return it if fresh.
 * Mirrors telegram.ts:waitForReflectionVerdict.
 *
 * Unlike the original this is fully testable: callers can provide a
 * custom `readFileFn` to avoid real FS I/O.
 */
export async function waitForReflectionVerdict(
  directory: string,
  sessionId: string,
  maxWaitMs: number,
  readFileFn: (path: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<ReflectionVerdict | null> {
  const reflectionDir = join(directory, ".reflection")
  const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const content = await readFileFn(signalPath)
      const verdict = JSON.parse(content) as ReflectionVerdict

      const age = Date.now() - verdict.timestamp
      if (age < 30_000) {
        return verdict
      }
      // Stale verdict — keep waiting
    } catch {
      // File not yet written
    }

    await new Promise((resolve) => setTimeout(resolve, REFLECTION_POLL_INTERVAL_MS))
  }

  return null
}

/**
 * Decide whether to suppress the notification based on a reflection verdict.
 * Returns true when the notification should be sent, false to suppress.
 */
export function shouldSendAfterVerdict(
  verdict: ReflectionVerdict | null,
  waitForVerdict: boolean
): { send: boolean; reason: string } {
  if (!waitForVerdict) {
    return { send: true, reason: "Reflection verdict gating disabled" }
  }

  if (!verdict) {
    return { send: true, reason: "No reflection verdict found, proceeding" }
  }

  if (verdict.complete) {
    return { send: true, reason: `Reflection verdict: COMPLETE (${verdict.severity})` }
  }

  return {
    send: false,
    reason: `Reflection verdict: INCOMPLETE (${verdict.severity})`,
  }
}
