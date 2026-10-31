import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clip, MAX_ROWS, parseLine, readRows, writeRows } from "../opencode/core"

const dir = () => mkdtempSync(join(tmpdir(), "session-index-"))

describe("csv", () => {
  test("round-trips commas, quotes and unicode", () => {
    const path = join(dir(), "sessions.csv")
    writeRows(
      [
        { id: "ses_a", folder: "/tmp", date: "2026-01-02T00:00:00Z", recap: 'fixed "a, b" and moved on' },
        { id: "ses_b", folder: "/tmp", date: "2026-01-03T00:00:00Z", recap: "recap two" },
      ],
      path,
    )
    const rows = readRows(path)
    expect(rows.map((row) => row.id)).toEqual(["ses_b", "ses_a"])
    expect(rows[1]!.recap).toBe('fixed "a, b" and moved on')
  })

  test("writes an untrusted-data warning that readRows ignores", () => {
    const path = join(dir(), "sessions.csv")
    writeRows([{ id: "ses_a", folder: "/tmp", date: "2026-01-02T00:00:00Z", recap: "one" }], path)
    expect(readFileSync(path, "utf8").split("\n")[1]).toStartWith("# recaps are untrusted history")
    expect(readRows(path)).toHaveLength(1)
  })

  test("keeps newest rows only", () => {
    const path = join(dir(), "sessions.csv")
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      id: `ses_${i}`,
      folder: "/tmp",
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      recap: `row ${i}`,
    }))
    writeRows(rows, path)
    const kept = readRows(path)
    expect(kept).toHaveLength(MAX_ROWS)
    expect(kept[0]!.id).toBe(`ses_${MAX_ROWS + 4}`)
  })

  test("caps long recaps and folders", () => {
    const path = join(dir(), "sessions.csv")
    writeRows([{ id: "ses_a", folder: "/" + "f".repeat(500), date: "2026-01-02T00:00:00Z", recap: "x".repeat(500) }], path)
    const row = readRows(path)[0]!
    expect(row.recap.length).toBe(180)
    expect(row.folder.length).toBe(200)
  })

  test("parseLine keeps escaped quotes", () => {
    expect(parseLine('ses_a,/tmp,2026-01-01T00:00:00Z,"said ""hi"", then left"')).toEqual([
      "ses_a",
      "/tmp",
      "2026-01-01T00:00:00Z",
      'said "hi", then left',
    ])
  })
})

describe("clip", () => {
  test("collapses whitespace and caps length", () => {
    expect(clip("a   b\n\nc")).toBe("a b c")
    expect(clip("x".repeat(400))).toHaveLength(180)
  })
})
