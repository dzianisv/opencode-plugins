import { describe, expect, test } from "bun:test"
import { attachFeedback, auditorSystem, formatFeedback, hasAgentWork, isHeadlessRun, isRealUserMessage, judgeAgent, parseModel, parseVerdict, prDraft, pruneAuditLines, renderTranscript, type Msg } from "../opencode/core"

const msg = (id: string, role: string, parts: any[]): Msg => ({ info: { id, role }, parts })
const text = (t: string, extra: object = {}) => ({ type: "text", text: t, ...extra })
const tool = (name: string, input: object, output = "") => ({ type: "tool", tool: name, state: { status: "completed", input, output } })

describe("parseModel", () => {
  test("keeps slashes inside the model id", () => {
    expect(parseModel("fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash")).toEqual({
      providerID: "fireworks-ai",
      modelID: "accounts/fireworks/models/deepseek-v4p1-flash",
    })
  })
})

describe("renderTranscript", () => {
  test("renders user text, assistant text and one line per tool call", () => {
    const out = renderTranscript(
      [
        msg("1", "user", [text("fix the bug")]),
        msg("2", "assistant", [text("on it"), tool("bash", { command: "go test ./..." }, "ok pkg 0.1s")]),
      ],
      10000,
    )
    expect(out).toContain("[#0 USER]\nfix the bug")
    expect(out).toContain("[#1 ASSISTANT]\non it\n  tool bash: go test ./... -> ok pkg 0.1s")
  })

  test("skips synthetic and ignored parts", () => {
    const out = renderTranscript([msg("1", "user", [text("hi"), text("<system-reminder>x</system-reminder>", { synthetic: true }), text("old", { ignored: true })])], 1000)
    expect(out).toBe("[#0 USER]\nhi")
  })

  test("over the limit keeps every user message and drops the oldest agent output first", () => {
    const msgs = [
      msg("1", "user", [text("first ask")]),
      msg("2", "assistant", [text("old ".repeat(900))]),
      msg("3", "user", [text("second ask")]),
      msg("4", "assistant", [text("new ".repeat(900))]),
    ]
    const out = renderTranscript(msgs, 4000)
    expect(out).toContain("first ask")
    expect(out).toContain("second ask")
    expect(out).toContain("[1 earlier agent message(s) omitted]")
    expect(out).toContain("new new")
    expect(out).not.toContain("old old")
  })

  test("agent output is one unbroken run ending at the newest, never a gap-filled mix", () => {
    const a = (id: string, t: string) => msg(id, "assistant", [text(t)])
    const out = renderTranscript([a("1", "OLD"), a("2", "MIDDLE".repeat(400)), a("3", "NEW".repeat(200))], 2500)
    expect(out).toContain("NEWNEW")
    expect(out).not.toContain("MIDDLE")
    expect(out).not.toContain("OLD")
    expect(out).toContain("[2 earlier agent message(s) omitted]")
  })

  test("always keeps the newest agent message even when it alone exceeds the limit", () => {
    const out = renderTranscript([msg("1", "user", [text("ask")]), msg("2", "assistant", [text("z".repeat(9000))])], 3000)
    expect(out).toContain("zzz")
  })

  test("clips long tool output", () => {
    const out = renderTranscript([msg("1", "assistant", [tool("bash", { command: "cat big" }, "x".repeat(2000))])], 10000)
    expect(out.length).toBeLessThan(500)
  })

  test("includes the PR title and body so the auditor can judge them", () => {
    const command = `T=/tmp/x; cat > $T/body.md <<'EOF'
BFS rebuilds on Go 1.26.10. The changesets bump service and benthos.
EOF
gh pr create --title "fix(security): long title" --body-file $T/body.md`
    const out = renderTranscript([msg("1", "assistant", [tool("shell", { command }, "https://github.com/x/y/pull/1")])], 10000)
    expect(out).toContain("pr-title: fix(security): long title")
    expect(out).toContain("pr-body: BFS rebuilds on Go 1.26.10")
  })

  test("prDraft ignores commands that are not PR writes", () => {
    expect(prDraft("gh pr view 1 --json body")).toBe("")
  })
})

describe("hasAgentWork", () => {
  test("false when only the user has spoken", () => {
    expect(hasAgentWork([msg("1", "user", [text("hi")])])).toBe(false)
  })
  test("true after assistant text or a tool call", () => {
    expect(hasAgentWork([msg("1", "user", [text("hi")]), msg("2", "assistant", [text("hello")])])).toBe(true)
    expect(hasAgentWork([msg("1", "user", [text("hi")]), msg("2", "assistant", [tool("bash", {})])])).toBe(true)
  })
  test("only looks after the latest user message", () => {
    expect(hasAgentWork([msg("1", "assistant", [text("old")]), msg("2", "user", [text("new")])])).toBe(false)
  })
})

describe("parseVerdict", () => {
  test("parses fenced JSON and caps violations at five", () => {
    const violations = Array.from({ length: 8 }, (_, i) => ({ rule: `rule ${i}`, evidence: "#1 q", fix: "do x" }))
    const v = parseVerdict("```json\n" + JSON.stringify({ verdict: "FAIL", violations }) + "\n```")
    expect(v?.verdict).toBe("FAIL")
    expect(v?.violations).toHaveLength(5)
  })
  test("PASS with no violations", () => {
    expect(parseVerdict('{"verdict":"PASS","violations":[]}')).toEqual({ verdict: "PASS", violations: [] })
  })
  test("a FAIL with no usable violations is rejected, not treated as PASS", () => {
    expect(parseVerdict('{"verdict":"FAIL","violations":[{"rule":" "}]}')).toBeNull()
    expect(parseVerdict('{"verdict":"FAIL"}')).toBeNull()
  })
  test("PASS ignores any listed violations", () => {
    expect(parseVerdict('{"verdict":"PASS","violations":[{"rule":"x"}]}')).toEqual({ verdict: "PASS", violations: [] })
  })
  test("rejects garbage and unknown verdicts", () => {
    expect(parseVerdict("I think it is fine")).toBeNull()
    expect(parseVerdict('{"verdict":"MAYBE"}')).toBeNull()
    expect(parseVerdict("{not json}")).toBeNull()
  })
})

describe("judgeAgent", () => {
  test("denies every tool with a wildcard rule and pins the model", () => {
    const agent = judgeAgent("p/m")
    expect(agent.permission).toEqual({ "*": "deny" })
    expect(agent.model).toBe("p/m")
    expect(agent.mode).toBe("subagent")
    expect(agent.hidden).toBe(true)
  })
})

describe("formatFeedback and auditorSystem", () => {
  test("lists each violation with evidence and fix", () => {
    const out = formatFeedback([{ rule: "Max 6 lines", evidence: "#4 12 lines", fix: "shorten" }])
    expect(out).toContain("- Max 6 lines (#4 12 lines) Fix: shorten")
  })
  test("embeds the rules", () => {
    expect(auditorSystem("NO FLUFF")).toContain("RULES:\nNO FLUFF")
  })
})

describe("isHeadlessRun", () => {
  const bun = ["bun", "/$bunfs/root/src/index.js"]
  test("true for `opencode run`, also after global options", () => {
    expect(isHeadlessRun([...bun, "run", "--model", "x", "hi"])).toBe(true)
    expect(isHeadlessRun([...bun, "--pure", "run", "hi"])).toBe(true)
    expect(isHeadlessRun([...bun, "--log-level", "ERROR", "run", "hi"])).toBe(true)
  })

  test("false for the TUI, serve, web and other subcommands", () => {
    expect(isHeadlessRun([...bun])).toBe(false)
    expect(isHeadlessRun([...bun, "serve"])).toBe(false)
    expect(isHeadlessRun([...bun, "web"])).toBe(false)
    expect(isHeadlessRun([...bun, "/some/project"])).toBe(false)
    expect(isHeadlessRun([...bun, "--log-level", "run"])).toBe(false)
    expect(isHeadlessRun([...bun, "session", "run"])).toBe(false)
  })

  test("false for interactive run modes", () => {
    expect(isHeadlessRun([...bun, "run", "--mini"])).toBe(false)
    expect(isHeadlessRun([...bun, "run", "-i"])).toBe(false)
  })

  test("SUPERVISOR_AUDIT_RUN=1 forces auditing", () => {
    expect(isHeadlessRun([...bun, "run", "hi"], { SUPERVISOR_AUDIT_RUN: "1" })).toBe(false)
    expect(isHeadlessRun([...bun, "run", "hi"], { SUPERVISOR_AUDIT_RUN: "0" })).toBe(true)
  })
})

describe("feedback helpers", () => {
  test("isRealUserMessage needs a non-synthetic text part on a user message", () => {
    expect(isRealUserMessage(msg("1", "user", [text("hi")]))).toBe(true)
    expect(isRealUserMessage(msg("1", "user", [{ type: "compaction" }]))).toBe(false)
    expect(isRealUserMessage(msg("1", "user", [text("x", { synthetic: true })]))).toBe(false)
    expect(isRealUserMessage(msg("1", "assistant", [text("hi")]))).toBe(false)
  })

  test("attachFeedback adds one synthetic note and never a second", () => {
    const m = msg("1", "user", [text("hi")])
    expect(attachFeedback(m, "fix it")).toBe(true)
    expect(attachFeedback(m, "fix it")).toBe(false)
    expect(m.parts).toHaveLength(2)
    expect(m.parts[1]).toMatchObject({ type: "text", synthetic: true, messageID: "1" })
    expect(m.parts[1].text).toContain("fix it")
  })
})

describe("pruneAuditLines", () => {
  const now = Date.parse("2026-10-13T00:00:00Z")
  const day = 86400000
  const line = (daysAgo: number) => JSON.stringify({ time: new Date(now - daysAgo * day).toISOString() })

  test("keeps recent lines and drops old, corrupt and time-less ones", () => {
    const out = pruneAuditLines([line(40), line(29), "garbage", "{}", '{"time":"nope"}', "", line(1)].join("\n") + "\n", now, 30 * day)
    expect(out).toBe(`${line(29)}\n${line(1)}\n`)
  })

  test("returns an empty string when nothing is kept", () => {
    expect(pruneAuditLines(line(99) + "\n", now, 30 * day)).toBe("")
  })
})
