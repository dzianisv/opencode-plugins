import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { attachFeedback, auditorSystem, DEFAULT_MODEL, formatFeedback, hasAgentWork, isHeadlessRun, isRealUserMessage, JUDGE_AGENT, judgeAgent, parseModel, parseVerdict, pruneAuditLines, renderTranscript } from "./core"

const logDir = () => process.env.SUPERVISOR_HOME || join(homedir(), ".cache", "supervisor")
const LOG_RETENTION_MS = 30 * 24 * 3600 * 1000
const DEFAULT_JUDGE_TIMEOUT_MS = 120000
const AUDIT_TITLE = "supervisor audit"
const STALE_AUDIT_MS = 5 * 60 * 1000

export const Supervisor: Plugin = async ({ client }) => {
  if (process.env.SUPERVISOR_ENABLED === "0" || isHeadlessRun(process.argv, process.env)) return {}

  const spec = process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL
  const model = parseModel(spec)
  const rulesPath = process.env.SUPERVISOR_RULES ?? join(homedir(), ".agents", "AGENTS.md")
  const maxChars = Number(process.env.SUPERVISOR_MAX_CHARS ?? 60000)
  const judgeTimeoutMs = Number(process.env.SUPERVISOR_JUDGE_TIMEOUT ?? DEFAULT_JUDGE_TIMEOUT_MS / 1000) * 1000

  const isChild = new Map<string, boolean>()
  const audited = new Map<string, string>()
  const running = new Set<string>()
  const rerun = new Set<string>()
  const pending = new Map<string, string>()
  const injected = new Map<string, { messageID: string; feedback: string }>()
  const auditing = new Set<string>()

  const log = (level: "info" | "error", message: string) =>
    client.app.log({ body: { service: "supervisor", level, message } }).catch(() => {})

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

  const childSession = async (id: string) => {
    if (!isChild.has(id)) {
      const res = await client.session.get({ path: { id } }).catch(() => undefined)
      isChild.set(id, Boolean(res?.data?.parentID))
    }
    return isChild.get(id)
  }

  const cleanupStaleAudits = async () => {
    const sessions = ((await client.session.list()).data ?? []) as any[]
    for (const s of sessions) {
      if (!s.parentID || s.title !== AUDIT_TITLE || auditing.has(s.id) || Date.now() - (s.time?.created ?? Date.now()) < STALE_AUDIT_MS) continue
      await client.session.delete({ path: { id: s.id } }).catch(() => {})
    }
  }

  const waitForAssistant = async (auditID: string, deadline: number) => {
    while (Date.now() < deadline) {
      const msgs = ((await client.session.messages({ path: { id: auditID } })).data ?? []) as any[]
      const done = msgs.findLast((m) => m.info.role === "assistant" && (m.info.time?.completed || m.info.error))
      if (done) return done as { info: any; parts: any[] }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error("judge did not answer in time")
  }

  const promptJudge = async (auditID: string, transcript: string, rules: string, deadline: number) => {
    const res = await client.session.prompt({
      path: { id: auditID },
      body: { agent: JUDGE_AGENT, model, system: auditorSystem(rules), parts: [{ type: "text", text: `TRANSCRIPT:\n\n${transcript}` }] },
    })
    const early = (res.data as any)?.info?.role === "user"
    const answer = early ? await waitForAssistant(auditID, deadline) : { info: (res.data as any)?.info, parts: (res.data?.parts ?? []) as any[] }
    const meta = {
      role: answer.info?.role,
      agent: answer.info?.agent,
      error: JSON.stringify((res as any).error ?? answer.info?.error ?? null).slice(0, 300),
      partTypes: answer.parts.map((p) => p.type),
      waited: early,
    }
    return { text: answer.parts.flatMap((p) => (p.type === "text" ? [p.text as string] : [])).join(""), meta }
  }

  const judge = async (sessionID: string, transcript: string, rules: string) => {
    const created = await client.session.create({ body: { parentID: sessionID, title: AUDIT_TITLE } })
    const auditID = created.data?.id
    if (!auditID) throw new Error("could not create audit session")
    isChild.set(auditID, true)
    auditing.add(auditID)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = promptJudge(auditID, transcript, rules, Date.now() + judgeTimeoutMs)
      work.catch(() => {})
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client.session.abort({ path: { id: auditID } }).catch(() => {})
          reject(new Error("judge timed out"))
        }, judgeTimeoutMs)
      })
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
      auditing.delete(auditID)
      client.session.delete({ path: { id: auditID } }).catch(() => {})
    }
  }

  const audit = async (sessionID: string) => {
    const res = await client.session.messages({ path: { id: sessionID } })
    const msgs = (res.data ?? []) as any[]
    const last = msgs.at(-1)
    if (!last || audited.get(sessionID) === last.info.id || !hasAgentWork(msgs)) return

    const started = Date.now()
    const rules = readFileSync(rulesPath, "utf8")
    const { text: reply, meta } = await judge(sessionID, renderTranscript(msgs, maxChars), rules)
    const verdict = parseVerdict(reply)
    if (!verdict) {
      record({ sessionID, messageID: last.info.id, ...meta, error: "unparseable verdict", reply: reply.slice(0, 300) })
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
    client.tui
      .showToast({
        body: {
          title: "supervisor",
          message: `${verdict.violations.length} rule violation(s): ${verdict.violations.map((v) => v.rule).join("; ")}`,
          variant: "warning",
          duration: 10000,
        },
      })
      .catch(() => {})
  }

  pruneAuditLog()
  cleanupStaleAudits().catch(() => {})

  return {
    config: async (cfg) => {
      cfg.agent = { ...cfg.agent, [JUDGE_AGENT]: judgeAgent(spec) as any }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const id = event.properties.sessionID
      if (await childSession(id)) return
      if (running.has(id)) {
        rerun.add(id)
        return
      }
      const run = (): void => {
        running.add(id)
        audit(id)
          .catch((err) => log("error", `audit failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            running.delete(id)
            if (rerun.delete(id)) run()
          })
      }
      run()
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const user = output.messages.findLast((m) => m.info.role === "user")
      if (!user) return
      const sessionID = user.info.sessionID
      const tracked = injected.get(sessionID)
      if (tracked?.messageID === user.info.id) {
        attachFeedback(user, tracked.feedback)
        return
      }
      if (tracked) injected.delete(sessionID)
      const feedback = pending.get(sessionID)
      if (!feedback || !isRealUserMessage(user)) return
      pending.delete(sessionID)
      injected.set(sessionID, { messageID: user.info.id, feedback })
      attachFeedback(user, feedback)
    },
  }
}
