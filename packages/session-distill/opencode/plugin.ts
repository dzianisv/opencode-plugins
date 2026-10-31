import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  COMMAND_NAME,
  DESCRIPTION,
  RECORD_FROM,
  TEMPLATE,
  confidence,
  enqueue,
  findCues,
  injectSessionID,
  markerPath,
  prune,
  queueDepth,
  skipPrompt,
  suggestion,
  tally,
  userText,
} from "./core"

export const SessionReflect: Plugin = async ({ client }) => {
  const isChild = new Map<string, boolean>()
  const reminded = new Set<string>()
  const checking = new Set<string>()

  const childSession = async (id: string) => {
    if (!isChild.has(id)) {
      const res = await client.session.get({ path: { id } }).catch(() => undefined)
      isChild.set(id, Boolean(res?.data?.parentID))
    }
    return isChild.get(id)
  }

  const log = (level: "info" | "error", message: string) =>
    client.app.log({ body: { service: "session-distill", level, message } }).catch(() => {})

  const remind = async (sessionID: string) => {
    const once = (process.env.SESSION_DISTILL_REMIND_ONCE ?? "1") === "1"
    if (once && (reminded.has(sessionID) || existsSync(markerPath(sessionID)))) return

    const messages = ((await client.session.messages({ path: { id: sessionID } })).data ?? []) as any[]
    const seen = tally(messages)
    const queued = queueDepth(sessionID)
    const threshold = Number(process.env.SESSION_DISTILL_MIN_ACTIONS ?? 3)
    if (seen.ranReflect || (seen.actions < threshold && !queued && !seen.newFiles)) return

    await client.tui.showToast({
      body: { title: "session-distill", message: suggestion(seen, queued), variant: "info", duration: 15000 },
    })
    if (!once) return
    reminded.add(sessionID)
    try {
      mkdirSync(dirname(markerPath(sessionID)), { recursive: true })
      writeFileSync(markerPath(sessionID), "shown\n")
    } catch {}
    prune(Number(process.env.SESSION_DISTILL_TTL_DAYS ?? 7))
  }

  return {
    config: async (cfg) => {
      cfg.command = { ...cfg.command, [COMMAND_NAME]: { description: DESCRIPTION, template: TEMPLATE } }
    },

    "command.execute.before": async (input, output) => {
      if (input.command === COMMAND_NAME) injectSessionID(output.parts, input.sessionID)
    },

    "chat.message": async (input, output) => {
      if ((process.env.SESSION_DISTILL_CAPTURE ?? "1") !== "1") return
      const text = userText(output.parts)
      if (skipPrompt(text)) return
      const found = findCues(text)
      const score = confidence(found)
      if (score < RECORD_FROM) return
      if (await childSession(input.sessionID)) return
      enqueue(
        input.sessionID,
        {
          ts: new Date().toISOString(),
          sessionID: input.sessionID,
          messageID: input.messageID ?? output.message.id,
          kinds: Object.keys(found).sort((a, b) => found[b] - found[a]),
          confidence: score,
        },
        Number(process.env.SESSION_DISTILL_QUEUE_MAX ?? 200),
      )
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const id = event.properties.sessionID
      if (checking.has(id)) return
      checking.add(id)
      try {
        if (await childSession(id)) return
        await remind(id).catch((err) => log("error", `reminder failed: ${err instanceof Error ? err.message : String(err)}`))
      } finally {
        checking.delete(id)
      }
    },
  }
}
