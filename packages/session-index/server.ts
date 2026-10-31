import { backfill, buildRow, enqueue, isMainSession, latestMessageTime, log, readRows, upsert, writeRows } from "./opencode/core"

const configured = Number(process.env.OPENCODE_SESSION_INDEX_IDLE_MS ?? 10 * 60_000)
const IDLE_MS = Number.isFinite(configured) && configured > 0 ? configured : 10 * 60_000
const MAX_RESCHEDULES = 3
const FINISHED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** Indexes finished sessions into ~/.agents/sessions.csv for cross-session lookup. */
export default {
  id: "session-index",
  async setup(ctx: any) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const attempts = new Map<string, number>()
    const controller = new AbortController()

    const cancel = (sessionID: string) => {
      const timer = timers.get(sessionID)
      if (timer) clearTimeout(timer)
      timers.delete(sessionID)
    }

    const schedule = (sessionID: string, finishedAt = Date.now()) => {
      cancel(sessionID)
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          void flush(sessionID, finishedAt)
        }, IDLE_MS),
      )
    }

    const flush = async (sessionID: string, finishedAt: number) => {
      if (latestMessageTime(sessionID) > finishedAt + 1_000) {
        const tries = (attempts.get(sessionID) ?? 0) + 1
        attempts.set(sessionID, tries)
        if (tries <= MAX_RESCHEDULES) return schedule(sessionID)
        log(`${sessionID} kept changing after finishing; indexing it anyway`)
      }
      attempts.delete(sessionID)
      const row = await buildRow(sessionID)
      if (row) await enqueue(() => upsert(row))
    }

    void enqueue(() => backfill())

    const subscribe = async () => {
      let backoff = 250
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            backoff = 250
            const sessionID = event?.data?.sessionID
            if (typeof sessionID !== "string") continue
            if (event.type === "session.execution.started") cancel(sessionID)
            if (FINISHED.has(event.type) && isMainSession(sessionID)) schedule(sessionID)
            if (event.type === "session.deleted") {
              cancel(sessionID)
              attempts.delete(sessionID)
              await enqueue(() => writeRows(readRows().filter((row) => row.id !== sessionID)))
            }
          }
          log("event stream ended; resubscribing")
        } catch (error) {
          if (controller.signal.aborted) return
          log(`event stream failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
    void subscribe()

    return () => {
      controller.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  },
}
