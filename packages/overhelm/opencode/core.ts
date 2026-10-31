import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_TEXT = "DO NOT OVERFLOW MY MIND\nREPLY SHORT\nSIMPLE ENGLISH\nDO NOT OVERCOMPLICATE\n"
export const PART_PREFIX = "prt_overhelm"

/** Path of the instruction file shared with the Claude Code hook; OVERHELM_FILE overrides it. */
export function instructionPath(): string {
  return process.env.OVERHELM_FILE ?? join(homedir(), ".agents", "overhelm.md")
}

/** Read the instruction, writing the default file first when it does not exist. */
export function loadInstruction(path = instructionPath()): string {
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, DEFAULT_TEXT)
    }
    return readFileSync(path, "utf8")
  } catch {
    return DEFAULT_TEXT
  }
}

/** Wrap the instruction the way other injected reminders are wrapped. */
export function reminderText(instruction: string): string {
  return `<system-reminder>\n${instruction.trim()}\n</system-reminder>`
}
