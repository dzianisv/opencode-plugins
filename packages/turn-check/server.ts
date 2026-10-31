import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  auditorSystem,
  DEFAULT_MODEL,
  formatFeedback,
  hasAgentWork,
  parseModel,
  parseVerdict,
  pruneAuditLines,
  renderTranscript,
  type Msg,
} from "./opencode/core"

const logDir = () => process.env.SUPERVISOR_HOME || join(homedir(), ".cache", "supervisor")
const LOG_RETENTION_MS = 30 * 24 * 3600 * 1000
const DEFAULT_JUDGE_TIMEOUT_MS = 120000

/** Convert session.context entries to the Msg shape core.ts helpers consume. */
export function toMsgs(infos: any[]): Msg[] {
  const out: Msg[] = []
  for (const m of infos ?? []) {
    if (m?.type === "user" && typeof m.text === "string") {
      out.push({ info: { id: m.id, role: "user" }, parts: [{ type: "text", text: m.text }] })
    } else if (m?.type === "assistant") {
      const parts = (m.content ?? []).flatMap((p: any) => {
        if (p?.type === "text") return [{ type: "text", text: p.text }]
        if (p?.type === "tool") {
          const output = (p.state?.content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => String(c.text ?? ""))
            .join("\n")
          return [{ type: "tool", tool: p.name, state: { input: p.state?.input ?? {}, output } }]
        }
        return []
      })
      out.push({ info: { id: m.id, role: "assistant" }, parts })
    }
  }
  return out
}

/** True when a context-hook user message carries real user text (not only attachments or our own note). */
export function isRealUserMessageV2(msg: any): boolean {
  return (
    msg?.role === "user" &&
    (msg.content ?? []).some((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim() && !p.metadata?.supervisor)
  )
}

/** Push the feedback note onto a context-hook user message unless it already carries one. */
export function attachFeedbackV2(msg: any, feedback: string): boolean {
  const content = (msg.content ??= [])
  if (content.some((p: any) => p?.metadata?.supervisor)) return false
  content.push({
    type: "text",
    text: `<system-reminder>\n${feedback}\n</system-reminder>`,
    metadata: { supervisor: true },
  })
  return true
}

const canonical = (p: string | undefined): string => {
  if (!p) return ""
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export default {
  id: "turn-check",
  async setup(ctx: any) {
    if (process.env.SUPERVISOR_ENABLED === "0") return

    const spec = process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL
    const model = parseModel(spec)
    const rulesPath = process.env.SUPERVISOR_RULES ?? join(homedir(), ".agents", "AGENTS.md")
    const maxChars = Number(process.env.SUPERVISOR_MAX_CHARS ?? 60000)
    const judgeTimeoutMs = Number(process.env.SUPERVISOR_JUDGE_TIMEOUT ?? DEFAULT_JUDGE_TIMEOUT_MS / 1000) * 1000

    const skipped = new Map<string, boolean>() // child or foreign-location session
    const audited = new Map<string, string>()
    const running = new Set<string>()
    const rerun = new Set<string>()
    const pending = new Map<string, string>()
    const injected = new Map<string, { messageID: string; feedback: string }>()

    const log = (message: string) => console.error(`[supervisor] ${message}`)

    const ensureLogDir = () => {
      mkdirSync(logDir(), { recursive: true, mode: 0o700 })
      chmodSync(logDir(), 0o700)
    }

    const record = (entry: object) => {
      try {
        ensureLogDir()
        const file = join(logDir(), "audits.jsonl")
        appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), model: spec, ...entry }) + "\n", { mode: 0o600 })
        chmodSync(file, 0o600)
      } catch {}
    }

    const pruneAuditLog = () => {
      try {
        const file = join(logDir(), "audits.jsonl")
        const text = readFileSync(file, "utf8")
        const kept = pruneAuditLines(text, Date.now(), LOG_RETENTION_MS)
        if (kept === text) return
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, kept, { mode: 0o600 })
        renameSync(tmp, file)
      } catch {}
    }

    // Audit only sessions in this instance's location; never child sessions.
    const myDir = canonical(ctx.location?.directory)
    const eligible = async (id: string) => {
      if (!skipped.has(id)) {
        const info = await ctx.session.get({ sessionID: id }).catch(() => undefined)
        const foreign = Boolean(info?.location?.directory && myDir && canonical(info.location.directory) !== myDir)
        skipped.set(id, Boolean(info && (info.parentID || foreign)))
      }
      return !skipped.get(id)
    }

    const judge = async (transcript: string, rules: string): Promise<string> => {
      const prompt = `${auditorSystem(rules)}\n\nTRANSCRIPT:\n\n${transcript}`
      const ac = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort()
          reject(new Error("judge timed out"))
        }, judgeTimeoutMs)
      })
      const work = ctx.generate
        .text({ prompt, model: { providerID: model.providerID, id: model.modelID } }, { signal: ac.signal })
        .then((r: any) => String(r?.text ?? ""))
      work.catch(() => {})
      try {
        return await Promise.race([work, timeout])
      } finally {
        clearTimeout(timer)
      }
    }

    const audit = async (sessionID: string) => {
      const msgs = toMsgs(await ctx.session.context({ sessionID }))
      const last = msgs.at(-1)
      if (!last || audited.get(sessionID) === last.info.id || !hasAgentWork(msgs)) return

      const started = Date.now()
      const rules = readFileSync(rulesPath, "utf8")
      const reply = await judge(renderTranscript(msgs, maxChars), rules)
      const verdict = parseVerdict(reply)
      if (!verdict) {
        record({ sessionID, messageID: last.info.id, ms: Date.now() - started, error: "unparseable verdict", reply: reply.slice(0, 300) })
        return
      }
      audited.set(sessionID, last.info.id)
      record({ sessionID, messageID: last.info.id, ms: Date.now() - started, ...verdict })
      if (verdict.verdict === "PASS") {
        pending.delete(sessionID)
        injected.delete(sessionID)
        return
      }
      pending.set(sessionID, formatFeedback(verdict.violations))
      log(`${verdict.violations.length} rule violation(s) in ${sessionID}: ${verdict.violations.map((v) => v.rule).join("; ")}`)
    }

    const run = (id: string): void => {
      running.add(id)
      audit(id)
        .catch((err) => log(`audit failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          running.delete(id)
          if (rerun.delete(id)) run(id)
        })
    }

    const TRIGGER_EVENTS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ])

    pruneAuditLog()

    await ctx.session.hook("context", (event: any) => {
      const messages = event?.messages
      if (!Array.isArray(messages)) return
      const user = [...messages].reverse().find((m: any) => m?.role === "user" && typeof m?.id === "string")
      if (!user) return
      const sessionID = String(event.sessionID)
      const tracked = injected.get(sessionID)
      if (tracked?.messageID === user.id) {
        attachFeedbackV2(user, tracked.feedback)
        return
      }
      if (tracked) injected.delete(sessionID)
      const feedback = pending.get(sessionID)
      if (!feedback || !isRealUserMessageV2(user)) return
      pending.delete(sessionID)
      injected.set(sessionID, { messageID: user.id, feedback })
      attachFeedbackV2(user, feedback)
    })

    const ac = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
          if (!TRIGGER_EVENTS.has((event as any)?.type)) continue
          const sessionID = (event as any).data?.sessionID
          if (typeof sessionID !== "string") continue
          if (!(await eligible(sessionID))) continue
          if (running.has(sessionID)) {
            rerun.add(sessionID)
            continue
          }
          run(sessionID)
        }
      } catch (err) {
        if (!ac.signal.aborted) log(`event subscription failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    return () => ac.abort()
  },
}
