import { loadInstruction, reminderText } from "./opencode/core"

/** opencode v2 entry: v2 loads `server.ts` and calls `setup`; v1 loads `opencode/plugin.ts` via package.json `main`. */
export default {
  id: "overhelm",
  async setup(ctx: any) {
    if (process.env.OVERHELM_ENABLED === "0") return

    const isChild = new Map<string, boolean>()
    const childSession = async (id: string) => {
      if (!isChild.has(id)) {
        const info = await ctx.session.get({ sessionID: id }).catch(() => undefined)
        isChild.set(id, Boolean(info?.parentID))
      }
      return isChild.get(id)
    }

    await ctx.session.hook("context", async (event: any) => {
      const instruction = loadInstruction()
      if (!instruction.trim()) return
      const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
      if (sessionID && (await childSession(sessionID))) return
      ;(event.system ??= []).push({ type: "text", text: reminderText(instruction) })
    })
  },
}
