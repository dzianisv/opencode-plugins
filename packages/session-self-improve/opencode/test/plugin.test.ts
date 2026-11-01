import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMAND_NAME, TEMPLATE_HEADING, tally } from "../core"
import { SessionReflect } from "../plugin"

let home = ""
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-self-improve-"))
  process.env.SESSION_SELF_IMPROVE_HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const key of ["SESSION_SELF_IMPROVE_QUEUE_MAX", "SESSION_SELF_IMPROVE_REMIND_ONCE", "SESSION_SELF_IMPROVE_CAPTURE"]) delete process.env[key]
})

const text = (t: string, extra: object = {}) => ({ type: "text", text: t, ...extra })
const tool = (name: string, input: object, metadata: object = {}, status = "completed") => ({
  type: "tool",
  tool: name,
  state: { status, input, metadata, output: "" },
})
const user = (t: string) => ({ info: { id: "u", role: "user" }, parts: [text(t)] })
const assistant = (...parts: any[]) => ({ info: { id: "a", role: "assistant" }, parts })

function fakeClient(opts: { parentID?: string; messages?: any[] } = {}) {
  const calls = { toast: [] as any[], messages: 0 }
  const client: any = {
    app: { log: async () => {} },
    tui: { showToast: async (a: any) => void calls.toast.push(a) },
    session: {
      get: async () => ({ data: { parentID: opts.parentID } }),
      messages: async () => (calls.messages++, { data: opts.messages ?? [] }),
    },
  }
  return { client, calls }
}

const send = (hooks: any, sessionID: string, t: string, parts: any[] = [text(t)]) =>
  hooks["chat.message"]({ sessionID, messageID: "msg_1" }, { message: { id: "msg_1" }, parts })
const queueLines = (name: string) =>
  readFileSync(join(home, "queue", `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const idle = (hooks: any, sessionID = "s1") => hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

describe("cue capture", () => {
  test("records a pointer with kinds and confidence, and no prompt text", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    const secret = "from now on never use sk-live-SECRET123 ... and that didn't work"
    await send(hooks, "ses_abc", secret)

    const [record] = queueLines("ses_abc")
    expect(record.sessionID).toBe("ses_abc")
    expect(record.messageID).toBe("msg_1")
    expect(record.kinds).toEqual(["rule", "failure"])
    expect(record.confidence).toBe(0.9)
    expect(Object.keys(record).sort()).toEqual(["confidence", "kinds", "messageID", "sessionID", "ts"])
    const raw = readFileSync(join(home, "queue", "ses_abc.jsonl"), "utf8")
    expect(raw).not.toContain("SECRET")
    expect(raw).not.toContain("never use")
  })

  test("single strong cue scores 0.8; curly apostrophes match", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    await send(hooks, "s1", "That didn’t work")
    expect(queueLines("s1")[0]).toMatchObject({ kinds: ["failure"], confidence: 0.6 })
    await send(hooks, "s1", "you should have used rg")
    expect(queueLines("s1")[1]).toMatchObject({ kinds: ["correction"], confidence: 0.8 })
  })

  test("approval alone and plain prompts are not recorded", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    await send(hooks, "s1", "looks good, that works")
    await send(hooks, "s1", "please add a test")
    expect(existsSync(join(home, "queue"))).toBe(false)
  })

  test("slash commands, the session-self-improve template, synthetic and ignored text are skipped", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    await send(hooks, "s1", "/foo from now on always use x")
    await send(hooks, "s1", `${TEMPLATE_HEADING}\n\nfrom now on always use x`)
    await send(hooks, "s1", "", [text("from now on always use x", { synthetic: true }), text("never use y", { ignored: true })])
    expect(existsSync(join(home, "queue"))).toBe(false)
  })

  test("child sessions are skipped", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient({ parentID: "root" }).client } as any)
    await send(hooks, "s1", "from now on always use x")
    expect(existsSync(join(home, "queue"))).toBe(false)
  })

  test("queue stops at SESSION_SELF_IMPROVE_QUEUE_MAX", async () => {
    process.env.SESSION_SELF_IMPROVE_QUEUE_MAX = "2"
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    for (let i = 0; i < 5; i++) await send(hooks, "s1", "from now on always use x")
    expect(queueLines("s1")).toHaveLength(2)
  })

  test("session id is sanitised in the file name", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    await send(hooks, "../../etc/pa ss", "from now on always use x")
    expect(readdirSync(join(home, "queue"))).toEqual(["etcpass.jsonl"])
  })

  test("SESSION_SELF_IMPROVE_CAPTURE=0 disables capture", async () => {
    process.env.SESSION_SELF_IMPROVE_CAPTURE = "0"
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    await send(hooks, "s1", "from now on always use x")
    expect(existsSync(join(home, "queue"))).toBe(false)
  })
})

describe("tally", () => {
  test("counts changing and delegating tools, MCP tools and git commit; ignores reads", () => {
    const result = tally([
      user("go"),
      assistant(
        tool("edit", { filePath: "/a.go" }),
        tool("write", { filePath: "/notes.md" }, { exists: true }),
        tool("task", {}),
        tool("skill", {}),
        tool("apply_patch", {}, { files: [] }),
        tool("jira_create_issue", {}),
        tool("bash", { command: "git add . && git commit -m x" }),
        tool("bash", { command: "ls" }),
        tool("read", { filePath: "/a.go" }),
        tool("grep", {}),
        tool("edit", {}, {}, "error"),
      ),
    ] as any)
    expect(result).toEqual({ actions: 7, newFiles: 0, ranReflect: false })
  })

  test("new script files are counted only when created, once per path", () => {
    const result = tally([
      assistant(
        tool("write", { filePath: "/p/run.sh" }, { exists: false }),
        tool("write", { filePath: "/p/run.sh" }, { exists: false }),
        tool("write", { filePath: "/p/old.py" }, { exists: true }),
        tool("write", { filePath: "/p/README.md" }, { exists: false }),
        tool("write", { filePath: "/p/skills/x/SKILL.md" }, { exists: false }),
        tool("apply_patch", {}, { files: [{ type: "add", filePath: "/p/new.ts" }, { type: "update", filePath: "/p/b.ts" }] }),
      ),
    ] as any)
    expect(result.newFiles).toBe(3)
  })

  test("detects an earlier run of the reflect command", () => {
    expect(tally([user(`${TEMPLATE_HEADING}\n\nstuff`)] as any).ranReflect).toBe(true)
  })
})

describe("reminder", () => {
  const busy = [user("go"), assistant(tool("edit", {}), tool("edit", {}), tool("edit", {}))]

  test("shown once for a busy session, with the counts", async () => {
    const { client, calls } = fakeClient({ messages: busy })
    const hooks: any = await SessionReflect({ client } as any)
    await idle(hooks)
    await idle(hooks)
    expect(calls.toast).toHaveLength(1)
    expect(calls.toast[0].body.message).toBe(
      "This session has work worth keeping (3 actions). Run /session-self-improve to turn it into skill, AGENTS.md or memory updates.",
    )
    expect(existsSync(join(home, "markers", "s1.mark"))).toBe(true)
  })

  test("two overlapping idle events show one toast", async () => {
    const { client, calls } = fakeClient({ messages: busy })
    const hooks: any = await SessionReflect({ client } as any)
    await Promise.all([idle(hooks), idle(hooks), idle(hooks)])
    expect(calls.toast).toHaveLength(1)
  })

  test("a restarted plugin does not remind again (marker file)", async () => {
    const first = fakeClient({ messages: busy })
    await idle(await SessionReflect({ client: first.client } as any))
    const second = fakeClient({ messages: busy })
    await idle(await SessionReflect({ client: second.client } as any))
    expect(first.calls.toast).toHaveLength(1)
    expect(second.calls.toast).toHaveLength(0)
  })

  test("a new script file or a queued cue is enough on its own", async () => {
    const created = fakeClient({ messages: [assistant(tool("write", { filePath: "/p/run.sh" }, { exists: false }))] })
    await idle(await SessionReflect({ client: created.client } as any), "s2")
    expect(created.calls.toast[0].body.message).toContain("1 actions, 1 new script file(s)")

    const queued = fakeClient({ messages: [user("hi")] })
    const hooks: any = await SessionReflect({ client: queued.client } as any)
    await send(hooks, "s3", "from now on always use x")
    await idle(hooks, "s3")
    expect(queued.calls.toast[0].body.message).toContain("0 actions, 1 correction cue(s)")
  })

  test("quiet session stays silent", async () => {
    const { client, calls } = fakeClient({ messages: [user("hi"), assistant(tool("read", {}), tool("edit", {}), text("done"))] })
    await idle(await SessionReflect({ client } as any))
    expect(calls.toast).toHaveLength(0)
    expect(existsSync(join(home, "markers"))).toBe(false)
  })

  test("child sessions never get a reminder", async () => {
    const { client, calls } = fakeClient({ parentID: "root", messages: busy })
    await idle(await SessionReflect({ client } as any))
    expect(calls.toast).toHaveLength(0)
  })

  test("no reminder right after the reflect command ran", async () => {
    const { client, calls } = fakeClient({ messages: [user(`${TEMPLATE_HEADING}\n\nx`), ...busy] })
    await idle(await SessionReflect({ client } as any))
    expect(calls.toast).toHaveLength(0)
  })

  test("REMIND_ONCE=0 reminds on every idle", async () => {
    process.env.SESSION_SELF_IMPROVE_REMIND_ONCE = "0"
    const { client, calls } = fakeClient({ messages: busy })
    const hooks: any = await SessionReflect({ client } as any)
    await idle(hooks)
    await idle(hooks)
    expect(calls.toast).toHaveLength(2)
  })

  test("other events are ignored", async () => {
    const { client, calls } = fakeClient({ messages: busy })
    const hooks: any = await SessionReflect({ client } as any)
    await hooks.event({ event: { type: "session.updated", properties: { sessionID: "s1" } } })
    expect(calls.messages).toBe(0)
  })
})

describe("command", () => {
  test("config hook registers the command and keeps the others", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    const cfg: any = { command: { other: { template: "x" } }, agent: { a: { mode: "primary" } } }
    await hooks.config(cfg)
    expect(cfg.command.other).toEqual({ template: "x" })
    expect(cfg.command[COMMAND_NAME].description).toBeString()
    expect(cfg.command[COMMAND_NAME].template.startsWith(TEMPLATE_HEADING)).toBe(true)
    expect(cfg.command[COMMAND_NAME].template).toContain("$ARGUMENTS")
    expect(cfg.agent).toEqual({ a: { mode: "primary" } })

    const empty: any = {}
    await hooks.config(empty)
    expect(Object.keys(empty.command)).toEqual([COMMAND_NAME])
  })

  test("template has no accidental numbered placeholders or shell blocks", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    const cfg: any = {}
    await hooks.config(cfg)
    const template: string = cfg.command[COMMAND_NAME].template
    expect(template).not.toMatch(/\$\d/)
    expect(template).not.toContain("!`")
  })

  test("running the command puts the real session id into the prompt", async () => {
    const hooks: any = await SessionReflect({ client: fakeClient().client } as any)
    const cfg: any = {}
    await hooks.config(cfg)
    const parts: any[] = [{ type: "text", text: cfg.command[COMMAND_NAME].template }]
    await hooks["command.execute.before"]({ command: COMMAND_NAME, sessionID: "ses_real123", arguments: "" }, { parts })
    expect(parts[0].text).toContain("Current session id: ses_real123")
    expect(parts[0].text).not.toContain("__SESSION_ID__")

    const other = [{ type: "text", text: "__SESSION_ID__" }]
    await hooks["command.execute.before"]({ command: "other", sessionID: "ses_x", arguments: "" }, { parts: other })
    expect(other[0].text).toBe("__SESSION_ID__")
  })
})
