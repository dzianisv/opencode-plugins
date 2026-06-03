/**
 * Integration tests for the supervisor goal loop wired into runReflection.
 *
 * These drive the plugin's session.idle handler through a mocked OpenCode
 * client and assert the end-to-end goal behavior:
 *   (a) goal active + judge NOT complete  → continuation injected, attempts++
 *   (b) goal active + judge complete       → goal status "achieved", no continuation
 *   (c) goal at attempts cap               → goal status "exhausted", no continuation
 *
 * The mock client returns a deterministic self-assessment JSON for every
 * ephemeral judge/classifier session, so the parse-then-evaluate path is taken
 * (no real LLM). We use a non-coding task summary so no workflow gates apply and
 * the goal condition is the sole completion driver.
 */

import assert from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Reflection3Plugin, supervisorStore, resolveMaxAttempts } from "../reflection-3.ts"

const SID = "ses_integration"

// A non-coding task so requiresTests/PR/CI are all false and `complete` is
// driven solely by the self-assessment status/confidence.
const USER_TEXT = "Tell me a short story about a friendly cloud."

function mainMessages() {
  return [
    {
      id: "msg_user_1",
      info: { role: "user", time: { start: 1000 } },
      parts: [{ type: "text", text: USER_TEXT }],
    },
    {
      id: "msg_asst_1",
      info: { role: "assistant", time: { start: 2000, completed: 3000 } },
      parts: [{ type: "text", text: "Here is a little story." }],
    },
  ]
}

/**
 * Build a mock client. `assessment` is the JSON string the ephemeral judge /
 * classifier sessions "respond" with. Records all promptAsync calls so we can
 * detect a continuation injected into the MAIN session.
 */
function makeClient(assessment: string) {
  const prompts: Array<{ id: string; text: string }> = []
  let counter = 0
  const ephemeralIds = new Set<string>()
  const client: any = {
    session: {
      async create() {
        const id = `judge_${++counter}`
        ephemeralIds.add(id)
        return { data: { id } }
      },
      async messages({ path }: any) {
        if (ephemeralIds.has(path.id)) {
          return {
            data: [
              {
                id: `${path.id}_resp`,
                info: { role: "assistant", time: { start: 1, completed: 2 } },
                parts: [{ type: "text", text: assessment }],
              },
            ],
          }
        }
        return { data: mainMessages() }
      },
      async promptAsync({ path, body }: any) {
        const text = (body?.parts || []).map((p: any) => p.text).join("")
        prompts.push({ id: path.id, text })
        return {}
      },
      async delete() {
        return {}
      },
    },
  }
  return {
    client,
    prompts,
    continuationToMain: () => prompts.filter(p => p.id === SID),
  }
}

async function fireIdle(plugin: any) {
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: SID } } })
}

describe("supervisor integration: goal loop in runReflection", () => {
  it("(a) goal active + judge NOT complete → continuation injected and attempts incremented", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-int-a-"))
    await supervisorStore.setGoal(dir, SID, "do X")

    const notComplete = JSON.stringify({
      task_summary: "story",
      task_type: "other",
      status: "in_progress",
      confidence: 0.9,
      remaining_work: ["Make the story longer"],
      next_steps: ["Expand the story"],
    })
    const { client, continuationToMain } = makeClient(notComplete)
    const plugin = await Reflection3Plugin({ client, directory: dir } as any)

    await fireIdle(plugin)

    const cont = continuationToMain()
    assert.ok(cont.length >= 1, "a continuation should be injected into the main session")
    assert.match(cont[0].text, /Reflection-3:/, "injected text should be reflection feedback")

    const st = await supervisorStore.load(dir, SID)
    assert.strictEqual(st.goal?.status, "active")
    assert.strictEqual(st.goal?.attempts, 1, "attempts should be incremented to 1")
    assert.match(st.goal?.lastReason || "", /.+/, "lastReason should be recorded")
  }, 60000)

  it("(b) goal active + judge complete → status achieved and NO continuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-int-b-"))
    await supervisorStore.setGoal(dir, SID, "do X")

    const complete = JSON.stringify({
      task_summary: "story",
      task_type: "other",
      status: "complete",
      confidence: 0.95,
      remaining_work: [],
      next_steps: [],
    })
    const { client, continuationToMain } = makeClient(complete)
    const plugin = await Reflection3Plugin({ client, directory: dir } as any)

    await fireIdle(plugin)

    assert.strictEqual(continuationToMain().length, 0, "no continuation when goal achieved")
    const st = await supervisorStore.load(dir, SID)
    assert.strictEqual(st.goal?.status, "achieved")
    assert.strictEqual(st.goal?.attempts, 0, "attempts unchanged on achieved")
  }, 60000)

  it("(c) goal at attempts cap → status exhausted and NO continuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-int-c-"))
    // No config file / package.json in temp dir → config resolves to default 16.
    const cap = resolveMaxAttempts({})
    await supervisorStore.setGoal(dir, SID, "do X")
    const pre = await supervisorStore.load(dir, SID)
    // Mutate attempts to the cap so the FIRST decision exhausts the budget.
    await supervisorStore.save(dir, SID, {
      ...pre,
      goal: { ...pre.goal!, attempts: cap },
    })

    // Judge says NOT complete — but exhaustion is checked first, so it must
    // not matter; assert no continuation regardless.
    const notComplete = JSON.stringify({
      task_summary: "story",
      task_type: "other",
      status: "in_progress",
      confidence: 0.9,
      remaining_work: ["more"],
      next_steps: ["more"],
    })
    const { client, continuationToMain } = makeClient(notComplete)
    const plugin = await Reflection3Plugin({ client, directory: dir } as any)

    await fireIdle(plugin)

    assert.strictEqual(continuationToMain().length, 0, "no continuation when budget exhausted")
    const st = await supervisorStore.load(dir, SID)
    assert.strictEqual(st.goal?.status, "exhausted")
    assert.strictEqual(st.goal?.attempts, cap, "attempts not incremented on exhaustion")
  }, 60000)
})
