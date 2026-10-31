import type { Plugin } from "@opencode-ai/plugin"
import { loadInstruction, PART_PREFIX, reminderText } from "./core"

export const Overhelm: Plugin = async ({ client }) => {
  if (process.env.OVERHELM_ENABLED === "0") return {}

  const isChild = new Map<string, boolean>()
  const childSession = async (id: string) => {
    if (!isChild.has(id)) {
      const res = await client.session.get({ path: { id } }).catch(() => undefined)
      isChild.set(id, Boolean(res?.data?.parentID))
    }
    return isChild.get(id)
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const lastUserIdx = output.messages.findLastIndex((m) => m.info.role === "user")
      if (lastUserIdx < 0) return
      const user = output.messages[lastUserIdx]
      if (user.parts.some((p: any) => typeof p.id === "string" && p.id.startsWith(PART_PREFIX))) return
      if (await childSession(user.info.sessionID)) return

      const instruction = loadInstruction()
      if (!instruction.trim()) return
      user.parts.push({
        id: `${PART_PREFIX}_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
        messageID: user.info.id,
        sessionID: user.info.sessionID,
        type: "text",
        text: reminderText(instruction),
        synthetic: true,
      } as any)
    },
  }
}
