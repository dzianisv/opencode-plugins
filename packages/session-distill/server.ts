import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  RECORD_FROM,
  confidence,
  enqueue,
  findCues,
  markerPath,
  prune,
  queueDepth,
  skipPrompt,
  suggestion,
  tally,
  userText,
  type Msg,
} from "./opencode/core"

const toMsgs = (items: any[]): Msg[] =>
  (items ?? []).map((m: any) => {
    if (m?.type === "user") {
      return { info: { id: m.id, role: "user" }, parts: [{ type: "text", text: String(m.text ?? "") }] }
    }
    const parts = (m?.content ?? []).map((p: any) =>
      p?.type === "text"
        ? { type: "text", text: p.text }
        : p?.type === "tool"
          ? { type: "tool", tool: p.name, state: { status: "completed", input: p.state?.input ?? {} } }
          : { type: String(p?.type) },
    )
    return { info: { id: m.id, role: "assistant" }, parts }
  })

/** Proposes where a session's lessons belong; opencode v2 entry. */
export default {
  id: "session-distill",
  async setup(ctx: any) {
    const injected = new Set<string>()

    await ctx.session.hook("context", async (event: any) => {
      const messages = event?.messages
      if (!Array.isArray(messages)) return
      const index = messages.findLastIndex((m: any) => m?.role === "user")
      if (index < 0) return
      const user = messages[index]
      const parts = Array.isArray(user.content) ? user.content : []
      const sessionID = String(event.sessionID)
      const text = userText(parts as any)

      if ((process.env.SESSION_DISTILL_CAPTURE ?? "1") === "1" && !skipPrompt(text)) {
        const found = findCues(text)
        const score = confidence(found)
        if (score >= RECORD_FROM) {
          enqueue(
            sessionID,
            {
              ts: new Date().toISOString(),
              sessionID,
              messageID: user.id,
              kinds: Object.keys(found).sort((a, b) => found[b] - found[a]),
              confidence: score,
            },
            Number(process.env.SESSION_DISTILL_QUEUE_MAX ?? 200),
          )
        }
      }

      if (injected.has(sessionID)) return
      const once = (process.env.SESSION_DISTILL_REMIND_ONCE ?? "1") === "1"
      if (once && existsSync(markerPath(sessionID))) return

      let history: any[] = []
      try {
        history = await ctx.session.context({ sessionID })
      } catch {
        return
      }
      const seen = tally(toMsgs(history))
      const queued = queueDepth(sessionID)
      const threshold = Number(process.env.SESSION_DISTILL_MIN_ACTIONS ?? 3)
      if (seen.ranReflect || (seen.actions < threshold && !queued && !seen.newFiles)) return

      parts.push({
        type: "text",
        text: `<system-reminder>\n${suggestion(seen, queued)}\n</system-reminder>`,
        metadata: { distill: true },
      })
      injected.add(sessionID)
      if (!once) return
      try {
        mkdirSync(dirname(markerPath(sessionID)), { recursive: true })
        writeFileSync(markerPath(sessionID), "shown\n")
      } catch {}
      prune(Number(process.env.SESSION_DISTILL_TTL_DAYS ?? 7))
    })
  },
}
