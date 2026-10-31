import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_TEXT, loadInstruction, reminderText } from "../core"

const dir = mkdtempSync(join(tmpdir(), "overhelm-"))
const file = join(dir, "sub", "overhelm.md")
process.env.OVERHELM_FILE = file

const { Overhelm } = await import("../plugin")

const user = (id: string, sessionID = "s1") => ({ info: { id, role: "user", sessionID }, parts: [{ type: "text", text: "hi" }] as any[] })
const assistant = () => ({ info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [] as any[] })
const client = (parentID?: string): any => ({ session: { get: async () => ({ data: { parentID } }) } })

describe("loadInstruction", () => {
  test("creates the default file when missing and returns it", () => {
    expect(existsSync(file)).toBe(false)
    expect(loadInstruction(file)).toBe(DEFAULT_TEXT)
    expect(readFileSync(file, "utf8")).toBe(DEFAULT_TEXT)
  })
  test("returns the edited file content", () => {
    writeFileSync(file, "BE BRIEF\n")
    expect(loadInstruction(file)).toBe("BE BRIEF\n")
  })
  test("falls back to the default when the path cannot be created", () => {
    expect(loadInstruction("/dev/null/nope/overhelm.md")).toBe(DEFAULT_TEXT)
  })
})

describe("reminderText", () => {
  test("wraps and trims", () => {
    expect(reminderText("A\nB\n")).toBe("<system-reminder>\nA\nB\n</system-reminder>")
  })
})

describe("plugin", () => {
  test("adds one synthetic reminder to the last user message only", async () => {
    writeFileSync(file, "BE BRIEF\n")
    const hooks: any = await Overhelm({ client: client() } as any)
    const output = { messages: [user("u1"), assistant(), user("u2")] }
    await hooks["experimental.chat.messages.transform"]({}, output)
    expect(output.messages[0].parts).toHaveLength(1)
    expect(output.messages[2].parts).toHaveLength(2)
    expect(output.messages[2].parts[1].synthetic).toBe(true)
    expect(output.messages[2].parts[1].text).toContain("BE BRIEF")
  })

  test("does not add it twice to the same message", async () => {
    const hooks: any = await Overhelm({ client: client() } as any)
    const output = { messages: [user("u3")] }
    await hooks["experimental.chat.messages.transform"]({}, output)
    await hooks["experimental.chat.messages.transform"]({}, output)
    expect(output.messages[0].parts).toHaveLength(2)
  })

  test("skips child sessions and empty instructions", async () => {
    const child: any = await Overhelm({ client: client("parent") } as any)
    const a = { messages: [user("u4", "child1")] }
    await child["experimental.chat.messages.transform"]({}, a)
    expect(a.messages[0].parts).toHaveLength(1)

    writeFileSync(file, "  \n")
    const top: any = await Overhelm({ client: client() } as any)
    const b = { messages: [user("u5", "top1")] }
    await top["experimental.chat.messages.transform"]({}, b)
    expect(b.messages[0].parts).toHaveLength(1)
  })

  test("OVERHELM_ENABLED=0 registers no hooks", async () => {
    process.env.OVERHELM_ENABLED = "0"
    expect(await Overhelm({ client: client() } as any)).toEqual({})
    delete process.env.OVERHELM_ENABLED
  })
})
