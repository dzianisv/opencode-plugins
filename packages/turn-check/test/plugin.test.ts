import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "supervisor-"))
const rules = join(dir, "AGENTS.md")
writeFileSync(rules, "Replies max 6 lines.")
process.env.SUPERVISOR_RULES = rules
process.env.HOME = dir
process.env.SUPERVISOR_HOME = join(dir, "state")
const auditLog = join(dir, "state", "audits.jsonl")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const { Supervisor } = await import("../opencode/plugin")

const conversation = [
  { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "status?" }] },
  { info: { id: "m2", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "line\n".repeat(12) }] },
]

function fakeClient(opts: {
  parentID?: string
  verdict?: string
  replies?: string[]
  onPrompt?: (n: number) => void
  convo?: any[]
  earlyReturn?: boolean
  hangFirstPrompt?: boolean
  sessions?: any[] | Promise<any[]>
}) {
  const calls = { prompt: [] as any[], toast: [] as any[], deleted: [] as string[], created: [] as any[], aborted: [] as string[], listed: 0 }
  const convo = opts.convo ?? conversation
  const client: any = {
    app: { log: async () => {} },
    tui: { showToast: async (a: any) => void calls.toast.push(a) },
    session: {
      get: async () => ({ data: { parentID: opts.parentID } }),
      list: async () => (calls.listed++, { data: await (opts.sessions ?? []) }),
      abort: async (a: any) => void calls.aborted.push(a.path.id),
      messages: async (a: any) =>
        a.path.id === "audit1"
          ? { data: [{ info: { role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: opts.verdict ?? "" }] }] }
          : { data: convo },
      create: async (a: any) => (calls.created.push(a), { data: { id: "audit1" } }),
      prompt: async (a: any) => {
        calls.prompt.push(a)
        opts.onPrompt?.(calls.prompt.length)
        if (opts.hangFirstPrompt && calls.prompt.length === 1) return new Promise(() => {})
        if (opts.earlyReturn) return { data: { info: { role: "user" }, parts: [{ type: "text", text: "TRANSCRIPT: echo of the input" }] } }
        const reply = opts.replies?.[calls.prompt.length - 1] ?? opts.verdict ?? ""
        return { data: { parts: [{ type: "text", text: reply }] } }
      },
      delete: async (a: any) => void calls.deleted.push(a.path.id),
    },
  }
  return { client, calls }
}

const userTurn = (id: string, sessionID: string, parts: any[] = [{ type: "text", text: "next question" }]) => ({ info: { id, role: "user", sessionID }, parts })

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

test("idle audit flags a violation, toasts, and injects feedback on the next user turn", async () => {
  const verdict = JSON.stringify({ verdict: "FAIL", violations: [{ rule: "Replies max 6 lines", evidence: '#1 "12 lines"', fix: "shorten" }] })
  const { client, calls } = fakeClient({ verdict })
  const hooks: any = await Supervisor({ client } as any)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  await waitFor(() => calls.toast.length > 0)

  expect(calls.created[0].body.parentID).toBe("s1")
  expect(calls.prompt[0].body.model.modelID).toBe("accounts/fireworks/models/deepseek-v4p1-flash")
  expect(calls.prompt[0].body.system).toContain("Replies max 6 lines.")
  expect(calls.prompt[0].body.parts[0].text).toContain("[#1 ASSISTANT]")
  expect(calls.toast[0].body.variant).toBe("warning")
  expect(calls.deleted).toEqual(["audit1"])
  expect(calls.prompt[0].body.agent).toBe("supervisor-judge")

  const cfg: any = { agent: { other: { mode: "primary" } } }
  await hooks.config(cfg)
  expect(cfg.agent["supervisor-judge"].permission).toEqual({ "*": "deny" })
  expect(cfg.agent.other).toEqual({ mode: "primary" })

  const output = { messages: [userTurn("m3", "s1")] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  expect(output.messages[0].parts[1].synthetic).toBe(true)
  expect(output.messages[0].parts[1].text).toContain("Replies max 6 lines")

  const again = { messages: [userTurn("m4", "s1")] }
  await hooks["experimental.chat.messages.transform"]({}, again)
  expect(again.messages[0].parts).toHaveLength(1)
})

test("when prompt returns the user message early, the plugin waits for the assistant reply", async () => {
  const verdict = JSON.stringify({ verdict: "FAIL", violations: [{ rule: "Replies max 6 lines", evidence: "#1", fix: "shorten" }] })
  const { client, calls } = fakeClient({ verdict, earlyReturn: true })
  const hooks: any = await Supervisor({ client } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s6" } } })
  await waitFor(() => calls.toast.length > 0)
  expect(calls.toast[0].body.message).toContain("Replies max 6 lines")
})

test("a later PASS clears feedback from an earlier FAIL that was corrected", async () => {
  const fail = JSON.stringify({ verdict: "FAIL", violations: [{ rule: "old violation", evidence: "#1", fix: "fix" }] })
  const pass = '{"verdict":"PASS","violations":[]}'
  const convo = [...conversation]
  const { client, calls } = fakeClient({ replies: [fail, pass], convo })
  const hooks: any = await Supervisor({ client } as any)
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s7" } } })
  await idle()
  await waitFor(() => calls.toast.length > 0)
  convo.push({ info: { id: "m9", role: "assistant", sessionID: "s7" }, parts: [{ type: "text", text: "corrected" }] })
  await idle()
  await waitFor(() => calls.prompt.length === 2)
  await new Promise((r) => setTimeout(r, 50))
  const output = { messages: [userTurn("u2", "s7")] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  expect(output.messages[0].parts).toHaveLength(1)
})

test("PASS verdict raises no toast and queues nothing", async () => {
  const { client, calls } = fakeClient({ verdict: '{"verdict":"PASS","violations":[]}' })
  const hooks: any = await Supervisor({ client } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } })
  await waitFor(() => calls.deleted.length > 0)
  expect(calls.toast).toHaveLength(0)
})

test("child sessions are never audited", async () => {
  const { client, calls } = fakeClient({ parentID: "s1", verdict: "{}" })
  const hooks: any = await Supervisor({ client } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "audit1" } } })
  await new Promise((r) => setTimeout(r, 50))
  expect(calls.created).toHaveLength(0)
})

test("an unparseable reply is ignored without throwing, and the same state is retried on the next idle", async () => {
  const pass = '{"verdict":"PASS","violations":[]}'
  const { client, calls } = fakeClient({ replies: ["looks fine to me", pass] })
  const hooks: any = await Supervisor({ client } as any)
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s3" } } })
  await idle()
  await waitFor(() => calls.deleted.length === 1)
  expect(calls.toast).toHaveLength(0)
  await idle()
  await waitFor(() => calls.deleted.length === 2)
  expect(calls.prompt).toHaveLength(2)
  await idle()
  await new Promise((r) => setTimeout(r, 50))
  expect(calls.prompt).toHaveLength(2)
})

test("a FAIL verdict without usable violations is rejected, not recorded as a pass", async () => {
  const { client, calls } = fakeClient({ verdict: '{"verdict":"FAIL","violations":[]}' })
  const hooks: any = await Supervisor({ client } as any)
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s4" } } })
  await idle()
  await waitFor(() => calls.deleted.length === 1)
  await idle()
  await waitFor(() => calls.deleted.length === 2)
  expect(calls.prompt).toHaveLength(2)
})

test("an idle that arrives during an audit triggers a follow-up audit of the newer turn", async () => {
  const pass = '{"verdict":"PASS","violations":[]}'
  const convo = [...conversation]
  let hooks: any
  const { client, calls } = fakeClient({
    verdict: pass,
    convo,
    onPrompt: (n) => {
      if (n !== 1) return
      convo.push({ info: { id: "m3", role: "assistant", sessionID: "s5" }, parts: [{ type: "text", text: "more work" }] })
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "s5" } } })
    },
  })
  hooks = await Supervisor({ client } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s5" } } })
  await waitFor(() => calls.prompt.length === 2)
  expect(calls.prompt).toHaveLength(2)
  expect(calls.prompt[1].body.parts[0].text).toContain("more work")
})

test("feedback is kept for a real user turn and not consumed by compaction or synthetic-only messages", async () => {
  const verdict = JSON.stringify({ verdict: "FAIL", violations: [{ rule: "Replies max 6 lines", evidence: "#1", fix: "shorten" }] })
  const { client, calls } = fakeClient({ verdict })
  const hooks: any = await Supervisor({ client } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s8" } } })
  await waitFor(() => calls.toast.length > 0)
  const transform = hooks["experimental.chat.messages.transform"]

  const compaction = { messages: [userTurn("c1", "s8", [{ type: "compaction", auto: true }])] }
  await transform({}, compaction)
  expect(compaction.messages[0].parts).toHaveLength(1)

  const syntheticOnly = { messages: [userTurn("c2", "s8", [{ type: "text", text: "note", synthetic: true }])] }
  await transform({}, syntheticOnly)
  expect(syntheticOnly.messages[0].parts).toHaveLength(1)

  const real = { messages: [userTurn("c5", "s8")] }
  await transform({}, real)
  expect(real.messages[0].parts).toHaveLength(2)
  expect(real.messages[0].parts[1].text).toContain("Replies max 6 lines")
})

describe("feedback across the steps of one turn", () => {
  const fail = (rule: string) => JSON.stringify({ verdict: "FAIL", violations: [{ rule, evidence: "#1", fix: "fix" }] })
  const assistant = (id: string, sessionID: string) => ({ info: { id, role: "assistant", sessionID }, parts: [{ type: "text", text: "working" }] })

  test("is injected again on every step for the same user message, once per message object, and not on the next user message", async () => {
    const { client, calls } = fakeClient({ verdict: fail("Rule one") })
    const hooks: any = await Supervisor({ client } as any)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "t1" } } })
    await waitFor(() => calls.toast.length > 0)
    const transform = hooks["experimental.chat.messages.transform"]

    const step1 = { messages: [userTurn("u1", "t1")] }
    await transform({}, step1)
    await transform({}, step1)
    expect(step1.messages[0].parts).toHaveLength(2)
    expect(step1.messages[0].parts[1].id.startsWith("prt_supervisor")).toBe(true)

    for (let step = 2; step <= 4; step++) {
      const reloaded = { messages: [userTurn("u1", "t1"), assistant(`a${step}`, "t1")] }
      await transform({}, reloaded)
      expect(reloaded.messages[0].parts).toHaveLength(2)
      expect(reloaded.messages[0].parts[1].text).toContain("Rule one")
    }

    const next = { messages: [userTurn("u1", "t1"), assistant("a9", "t1"), userTurn("u2", "t1")] }
    await transform({}, next)
    expect(next.messages[2].parts).toHaveLength(1)
    expect(next.messages[0].parts).toHaveLength(1)

    const back = { messages: [userTurn("u1", "t1")] }
    await transform({}, back)
    expect(back.messages[0].parts).toHaveLength(1)
  })

  test("a second feedback replaces the first on the next user message", async () => {
    const { client, calls } = fakeClient({ replies: [fail("Rule one"), fail("Rule two")] })
    const convo = [...conversation.map((m) => ({ ...m, info: { ...m.info, sessionID: "t2" } }))]
    const hooks: any = await Supervisor({ client } as any)
    const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "t2" } } })
    ;(client.session as any).messages = async () => ({ data: convo })
    await idle()
    await waitFor(() => calls.toast.length === 1)
    const transform = hooks["experimental.chat.messages.transform"]
    const first = { messages: [userTurn("u1", "t2")] }
    await transform({}, first)
    expect(first.messages[0].parts[1].text).toContain("Rule one")

    convo.push({ info: { id: "m9", role: "assistant", sessionID: "t2" }, parts: [{ type: "text", text: "more" }] })
    await idle()
    await waitFor(() => calls.toast.length === 2)
    const second = { messages: [userTurn("u1", "t2"), assistant("a1", "t2"), userTurn("u2", "t2")] }
    await transform({}, second)
    expect(second.messages[2].parts).toHaveLength(2)
    expect(second.messages[2].parts[1].text).toContain("Rule two")
    expect(second.messages[2].parts[1].text).not.toContain("Rule one")
    const later = { messages: [...second.messages.map((m) => ({ ...m, parts: m.parts.slice(0, 1) })), assistant("a2", "t2")] }
    await transform({}, later)
    expect(later.messages[2].parts).toHaveLength(2)
    expect(later.messages[2].parts[1].text).toContain("Rule two")
  })

  test("a PASS audit drops the stored feedback", async () => {
    const pass = '{"verdict":"PASS","violations":[]}'
    const convo = conversation.map((m) => ({ ...m, info: { ...m.info, sessionID: "t3" } }))
    const { client, calls } = fakeClient({ replies: [fail("Rule one"), pass], convo })
    const hooks: any = await Supervisor({ client } as any)
    const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "t3" } } })
    await idle()
    await waitFor(() => calls.toast.length === 1)
    const transform = hooks["experimental.chat.messages.transform"]
    await transform({}, { messages: [userTurn("u1", "t3")] })
    convo.push({ info: { id: "m9", role: "assistant", sessionID: "t3" }, parts: [{ type: "text", text: "fixed" }] })
    await idle()
    await waitFor(() => calls.prompt.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    const again = { messages: [userTurn("u1", "t3"), assistant("a1", "t3")] }
    await transform({}, again)
    expect(again.messages[0].parts).toHaveLength(1)
  })
})

describe("headless opencode run", () => {
  test("registers no hooks and starts no audit, unless SUPERVISOR_AUDIT_RUN=1", async () => {
    const argv = process.argv
    process.argv = ["bun", "/$bunfs/root/src/index.js", "run", "--model", "x", "hi"]
    try {
      const { client, calls } = fakeClient({ verdict: '{"verdict":"PASS","violations":[]}' })
      const hooks: any = await Supervisor({ client } as any)
      expect(hooks).toEqual({})
      expect(calls.listed).toBe(0)

      process.env.SUPERVISOR_AUDIT_RUN = "1"
      const forced = fakeClient({ verdict: '{"verdict":"PASS","violations":[]}' })
      const forcedHooks: any = await Supervisor({ client: forced.client } as any)
      await forcedHooks.event({ event: { type: "session.idle", properties: { sessionID: "h1" } } })
      await waitFor(() => forced.calls.prompt.length > 0)
      expect(forced.calls.prompt).toHaveLength(1)
    } finally {
      delete process.env.SUPERVISOR_AUDIT_RUN
      process.argv = argv
    }
  })
})

describe("audit log", () => {
  test("an unparseable verdict keeps its own error text, and the log is private", async () => {
    const { client, calls } = fakeClient({ verdict: "no json here" })
    const hooks: any = await Supervisor({ client } as any)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "l1" } } })
    await waitFor(() => calls.deleted.length > 0)
    await waitFor(() => existsSync(auditLog) && readFileSync(auditLog, "utf8").includes("l1"))
    const entry = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.sessionID === "l1")
    expect(entry.error).toBe("unparseable verdict")
    expect(statSync(auditLog).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700)
  })

  test("startup prunes entries older than 30 days and corrupt lines", async () => {
    const day = 86400000
    const line = (daysAgo: number, id: string) => JSON.stringify({ time: new Date(Date.now() - daysAgo * day).toISOString(), sessionID: id })
    writeFileSync(auditLog, [line(40, "old"), "not json", line(2, "recent"), ""].join("\n"))
    const { client } = fakeClient({})
    await Supervisor({ client } as any)
    const text = readFileSync(auditLog, "utf8")
    expect(text).toContain("recent")
    expect(text).not.toContain("old")
    expect(text).not.toContain("not json")
    expect(statSync(auditLog).mode & 0o777).toBe(0o600)
  })
})

test("a hung judge is aborted at the timeout, its session deleted, and the turn is retried on the next idle", async () => {
  process.env.SUPERVISOR_JUDGE_TIMEOUT = "0.1"
  try {
    const { client, calls } = fakeClient({ verdict: '{"verdict":"PASS","violations":[]}', hangFirstPrompt: true })
    const hooks: any = await Supervisor({ client } as any)
    const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } })
    await idle()
    await waitFor(() => calls.aborted.length > 0)
    expect(calls.aborted).toEqual(["audit1"])
    await waitFor(() => calls.deleted.length > 0)
    expect(calls.deleted).toEqual(["audit1"])
    expect(calls.toast).toHaveLength(0)
    await idle()
    await waitFor(() => calls.deleted.length === 2)
    expect(calls.prompt).toHaveLength(2)
    expect(calls.aborted).toHaveLength(1)
  } finally {
    delete process.env.SUPERVISOR_JUDGE_TIMEOUT
  }
})

describe("startup cleanup of leftover audit sessions", () => {
  const minutes = (n: number) => Date.now() - n * 60000
  const session = (id: string, title: string, ageMinutes: number, parentID: string | null = "parent") => ({ id, title, parentID, time: { created: minutes(ageMinutes), updated: minutes(ageMinutes) } })

  test("deletes only old child sessions titled exactly supervisor audit, never a top-level one", async () => {
    const { client, calls } = fakeClient({
      sessions: [
        session("old1", "supervisor audit", 10),
        session("old2", "supervisor audit", 6),
        session("fresh", "supervisor audit", 1),
        session("other", "supervisor audit notes", 60),
        session("mine", "my work", 60),
        session("top", "supervisor audit", 60, null),
      ],
    })
    await Supervisor({ client } as any)
    await waitFor(() => calls.deleted.length >= 2)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.deleted).toEqual(["old1", "old2"])
    expect(calls.listed).toBe(1)
  })

  test("skips a session this plugin instance is auditing right now", async () => {
    let release: (v: any[]) => void = () => {}
    const sessions = new Promise<any[]>((r) => (release = r))
    const { client, calls } = fakeClient({ sessions, hangFirstPrompt: true })
    process.env.SUPERVISOR_JUDGE_TIMEOUT = "5"
    try {
      const hooks: any = await Supervisor({ client } as any)
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s10" } } })
      await waitFor(() => calls.prompt.length === 1)
      release([session("audit1", "supervisor audit", 30), session("leftover", "supervisor audit", 30)])
      await waitFor(() => calls.deleted.includes("leftover"))
      await new Promise((r) => setTimeout(r, 30))
      expect(calls.deleted).toEqual(["leftover"])
    } finally {
      delete process.env.SUPERVISOR_JUDGE_TIMEOUT
    }
  })

  test("errors from listing or deleting never break plugin start", async () => {
    const { client } = fakeClient({ sessions: Promise.reject(new Error("no server")) })
    const hooks: any = await Supervisor({ client } as any)
    expect(typeof hooks.event).toBe("function")
  })
})
