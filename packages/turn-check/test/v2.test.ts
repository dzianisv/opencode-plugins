import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "supervisor-v2-"))
const rules = join(dir, "AGENTS.md")
writeFileSync(rules, "Replies max 6 lines.")
process.env.SUPERVISOR_RULES = rules
process.env.SUPERVISOR_HOME = join(dir, "state")
const auditLog = join(dir, "state", "audits.jsonl")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const { default: plugin, attachFeedbackV2, isRealUserMessageV2, toMsgs } = await import("../server")

const conversation = [
  { id: "m1", type: "user", text: "status?", time: { created: 1 } },
  { id: "m2", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "line\n".repeat(12) }] },
  { id: "m3", type: "idle", time: { created: 4 } },
]

function channel() {
  const queue: any[] = []
  let waiter: ((r: IteratorResult<any>) => void) | undefined
  return {
    push(e: any) {
      if (waiter) {
        const w = waiter
        waiter = undefined
        w({ value: e, done: false })
      } else queue.push(e)
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((r) => (waiter = r))),
      }
    },
  }
}

function fakeCtx(opts: { parentID?: string; replies?: string[]; verdict?: string; convo?: any[]; foreignDir?: string }) {
  const calls = { generated: [] as any[], contextHook: null as any, registrations: 0 }
  const events = channel()
  const ctx: any = {
    location: { directory: dir },
    event: { subscribe: () => events },
    session: {
      get: async () => ({ parentID: opts.parentID, location: { directory: opts.foreignDir ?? dir } }),
      context: async () => opts.convo ?? conversation,
      hook: async (name: string, cb: any) => {
        if (name === "context") calls.contextHook = cb
        calls.registrations++
        return { dispose: async () => {} }
      },
    },
    generate: {
      text: async (input: any) => {
        calls.generated.push(input)
        return { text: opts.replies?.[calls.generated.length - 1] ?? opts.verdict ?? "" }
      },
    },
  }
  return { ctx, calls, events }
}

const idle = (events: ReturnType<typeof channel>, sessionID: string) =>
  events.push({ type: "session.execution.succeeded", data: { sessionID } })

const userMessage = (id: string, content: any[] = [{ type: "text", text: "next question" }]) => ({ id, role: "user", content })

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

const FAIL = (rule: string) => JSON.stringify({ verdict: "FAIL", violations: [{ rule, evidence: '#1 "12 lines"', fix: "shorten" }] })
const PASS = '{"verdict":"PASS","violations":[]}'

test("idle audit calls the judge with rules and transcript, and records the verdict", async () => {
  const { ctx, calls, events } = fakeCtx({ verdict: FAIL("Replies max 6 lines") })
  await plugin.setup(ctx)
  idle(events, "s1")
  await waitFor(() => calls.generated.length === 1)

  const prompt = calls.generated[0].prompt
  expect(calls.generated[0].model).toEqual({ providerID: "fireworks-ai", id: "accounts/fireworks/models/deepseek-v4p1-flash" })
  expect(prompt).toContain("Replies max 6 lines.")
  expect(prompt).toContain("TRANSCRIPT:")
  expect(prompt).toContain("[#1 ASSISTANT]")

  const entry = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.sessionID === "s1")
  expect(entry.verdict).toBe("FAIL")
  expect(entry.messageID).toBe("m2")
  expect(entry.violations[0].rule).toBe("Replies max 6 lines")
})

test("a FAIL verdict attaches feedback to the next user message and re-attaches it on every step of that turn", async () => {
  const { ctx, calls, events } = fakeCtx({ verdict: FAIL("Replies max 6 lines") })
  await plugin.setup(ctx)
  idle(events, "s2")
  await waitFor(() => calls.generated.length === 1)
  const hook = calls.contextHook

  const step1 = { sessionID: "s2", messages: [userMessage("u1")] }
  await hook(step1)
  expect(step1.messages[0].content).toHaveLength(2)
  expect(step1.messages[0].content[1].text).toContain("Replies max 6 lines")
  expect(step1.messages[0].content[1].text).toContain("<system-reminder>")

  // same array again: no double attach
  await hook(step1)
  expect(step1.messages[0].content).toHaveLength(2)

  // later steps rebuild the messages; the same user message gets the note again
  for (let step = 2; step <= 3; step++) {
    const reloaded = {
      sessionID: "s2",
      messages: [userMessage("u1"), { id: `a${step}`, role: "assistant", content: [{ type: "text", text: "working" }] }],
    }
    await hook(reloaded)
    expect(reloaded.messages[0].content).toHaveLength(2)
    expect(reloaded.messages[0].content[1].text).toContain("Replies max 6 lines")
    expect(reloaded.messages[1].content).toHaveLength(1)
  }

  // the next user message starts clean: old injection dropped, nothing pending
  const next = { sessionID: "s2", messages: [userMessage("u1"), userMessage("u2")] }
  await hook(next)
  expect(next.messages[0].content).toHaveLength(1)
  expect(next.messages[1].content).toHaveLength(1)
})

test("a later PASS clears pending feedback from an earlier FAIL", async () => {
  const convo = conversation.map((m) => ({ ...m }))
  const { ctx, calls, events } = fakeCtx({ replies: [FAIL("old violation"), PASS], convo })
  await plugin.setup(ctx)
  idle(events, "s3")
  await waitFor(() => calls.generated.length === 1)
  convo.splice(2, 0, { id: "m9", type: "assistant", time: { created: 5, completed: 6 }, content: [{ type: "text", text: "corrected" }] })
  idle(events, "s3")
  await waitFor(() => calls.generated.length === 2)
  await new Promise((r) => setTimeout(r, 50))
  const output = { sessionID: "s3", messages: [userMessage("u9")] }
  await calls.contextHook(output)
  expect(output.messages[0].content).toHaveLength(1)
})

test("dedupe: the same conversation state is audited once", async () => {
  const { ctx, calls, events } = fakeCtx({ verdict: PASS })
  await plugin.setup(ctx)
  idle(events, "s4")
  await waitFor(() => calls.generated.length === 1)
  idle(events, "s4")
  idle(events, "s4")
  await new Promise((r) => setTimeout(r, 50))
  expect(calls.generated).toHaveLength(1)
})

test("child sessions and sessions from other locations are never audited", async () => {
  const child = fakeCtx({ parentID: "parent", verdict: PASS })
  await plugin.setup(child.ctx)
  idle(child.events, "child1")
  const foreign = fakeCtx({ foreignDir: join(dir, "elsewhere"), verdict: PASS })
  await plugin.setup(foreign.ctx)
  idle(foreign.events, "foreign1")
  await new Promise((r) => setTimeout(r, 50))
  expect(child.calls.generated).toHaveLength(0)
  expect(foreign.calls.generated).toHaveLength(0)
})

test("an unparseable verdict is recorded as an error and retried on the next idle", async () => {
  const { ctx, calls, events } = fakeCtx({ replies: ["looks fine to me", PASS] })
  await plugin.setup(ctx)
  idle(events, "s5")
  await waitFor(() => calls.generated.length === 1)
  await waitFor(() => existsSync(auditLog) && readFileSync(auditLog, "utf8").includes("s5"))
  const entry = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.sessionID === "s5")
  expect(entry.error).toBe("unparseable verdict")
  idle(events, "s5")
  await waitFor(() => calls.generated.length === 2)
})

test("an idle that arrives during an audit triggers a follow-up audit of the newer turn", async () => {
  const convo = conversation.map((m) => ({ ...m }))
  const { ctx, calls, events } = fakeCtx({ verdict: PASS, convo })
  // extend the conversation as soon as the first judge call lands
  const origText = ctx.generate.text
  let pushed = false
  ctx.generate.text = async (input: any) => {
    const out = await origText(input)
    if (!pushed) {
      pushed = true
      convo.splice(2, 0, { id: "m8", type: "assistant", time: { created: 5, completed: 6 }, content: [{ type: "text", text: "more work" }] })
      idle(events, "s6")
    }
    return out
  }
  await plugin.setup(ctx)
  idle(events, "s6")
  await waitFor(() => calls.generated.length === 2)
  expect(calls.generated[1].prompt).toContain("more work")
})

test("feedback is not consumed by a user message without real text", async () => {
  const { ctx, calls, events } = fakeCtx({ verdict: FAIL("Replies max 6 lines") })
  await plugin.setup(ctx)
  idle(events, "s7")
  await waitFor(() => calls.generated.length === 1)
  const hook = calls.contextHook

  const filesOnly = { sessionID: "s7", messages: [userMessage("u1", [{ type: "media", media: { source: { type: "url", url: "x" } } }])] }
  await hook(filesOnly)
  expect(filesOnly.messages[0].content).toHaveLength(1)

  const real = { sessionID: "s7", messages: [userMessage("u2")] }
  await hook(real)
  expect(real.messages[0].content).toHaveLength(2)
})

describe("v2 adapters", () => {
  test("toMsgs maps user/assistant/tool and skips other message types", () => {
    const msgs = toMsgs([
      { id: "u1", type: "user", text: "hi" },
      {
        id: "a1",
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "answer" },
          { type: "tool", id: "t1", name: "bash", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "files" }] } },
        ],
      },
      { id: "i1", type: "idle" },
      { id: "c1", type: "compaction", status: "completed" },
    ])
    expect(msgs.map((m) => m.info.role)).toEqual(["user", "assistant"])
    expect(msgs[1].parts.map((p) => p.type)).toEqual(["text", "tool"])
    expect(msgs[1].parts[1].tool).toBe("bash")
    expect(msgs[1].parts[1].state.output).toBe("files")
  })

  test("isRealUserMessageV2 and attachFeedbackV2", () => {
    expect(isRealUserMessageV2(userMessage("u1"))).toBe(true)
    expect(isRealUserMessageV2({ id: "u2", role: "user", content: [{ type: "media" }] })).toBe(false)
    const msg = userMessage("u3")
    expect(attachFeedbackV2(msg, "note")).toBe(true)
    expect(attachFeedbackV2(msg, "note")).toBe(false)
    expect(msg.content[1].text).toBe("<system-reminder>\nnote\n</system-reminder>")
  })
})
