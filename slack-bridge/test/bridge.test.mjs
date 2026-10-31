import test from "node:test"
import assert from "node:assert/strict"
import {
  BUSY_NOTICE,
  MAX_TEXT,
  canRespondToPermission,
  chunks,
  getStoredSession,
  isAllowed,
  keyFor,
  loadMapFromJSON,
  parseModel,
  permissionContext,
  respondToPermission,
  routeAction,
  routeMessage,
  runWithSessionLock,
  serializeMapToJSON,
  toMrkdwn,
} from "../lib.mjs"

test("keyFor joins channel and thread", () => {
  assert.equal(keyFor("C123", "1700000000.000100"), "C123:1700000000.000100")
})

test("message routing starts DMs, resumes threads, and ignores unrelated channel messages", () => {
  const dm = routeMessage({ channel: "D123", channelType: "im", text: "hello" })
  assert.deepEqual(dm, { kind: "dm", channel: "D123", thread: null, key: "im:D123" })
  assert.deepEqual(routeAction(dm, {}), { kind: "start" })
  assert.deepEqual(routeAction(dm, { "im:D123": "s1" }), { kind: "continue", sessionId: "s1" })

  const thread = routeMessage({ channel: "C123", channelType: "channel", threadTs: "1700.01", text: "follow up" })
  assert.deepEqual(thread, { kind: "thread", channel: "C123", thread: "1700.01", key: "C123:1700.01" })
  assert.deepEqual(routeAction(thread, { "C123:1700.01": "s2" }), { kind: "continue", sessionId: "s2" })
  assert.deepEqual(routeAction(thread, {}), { kind: "ignore" })
  assert.deepEqual(routeMessage({ channel: "C123", channelType: "channel", text: "root message" }), { kind: "ignore" })
  assert.deepEqual(routeMessage({ channel: "C123", channelType: "channel", threadTs: "1700.01", botUserId: "U123", text: "hey <@U123> please run" }), { kind: "ignore" })
  assert.equal(routeMessage({ channel: "C123", channelType: "channel", threadTs: "1700.01", botUserId: "U123", text: "hey <@U456> please run" }).kind, "thread")
})

test("parseModel splits provider/model", () => {
  assert.deepEqual(parseModel("opencode/deepseek-v4.1-flash-free"), {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
  })
})

test("parseModel rejects incomplete values", () => {
  assert.equal(parseModel(""), null)
  assert.equal(parseModel("opencode"), null)
  assert.equal(parseModel("/model"), null)
  assert.equal(parseModel("provider/"), null)
})

test("toMrkdwn converts common markdown", () => {
  assert.equal(toMrkdwn("**bold**"), "*bold*")
  assert.equal(toMrkdwn("# Heading"), "*Heading*")
  assert.equal(toMrkdwn("[docs](https://example.com)"), "<https://example.com|docs>")
})

test("chunks keeps every part within the limit", () => {
  const parts = chunks("a".repeat(8000))
  assert.equal(parts.length, 3)
  for (const part of parts) assert.ok(part.length <= MAX_TEXT)
})

test("chunks prefers newline boundaries", () => {
  const parts = chunks("a".repeat(3000) + "\n" + "b".repeat(3000))
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000])
})

test("allowlist denies everyone when empty", () => {
  assert.equal(isAllowed("U123", new Set()), false)
  assert.equal(isAllowed("U123", new Set(["U123"])), true)
  assert.equal(isAllowed("U456", new Set(["U123"])), false)
})

test("permissionContext maps DM and thread session keys", () => {
  assert.deepEqual(permissionContext({ "im:D123": "s1" }, "s1"), {
    key: "im:D123",
    channel: "D123",
    thread: undefined,
  })
  assert.deepEqual(permissionContext({ "C123:1700.01": "s2" }, "s2"), {
    key: "C123:1700.01",
    channel: "C123",
    thread: "1700.01",
  })
  assert.equal(permissionContext({}, "missing"), null)
})

test("getStoredSession clears deleted sessions and persists the removal", async () => {
  const state = { "im:D123": "s1" }
  let saved = false
  const session = await getStoredSession({
    state,
    key: "im:D123",
    fetchSession: async () => ({ error: { message: "not found" } }),
    saveState: () => { saved = true },
  })
  assert.equal(session, null)
  assert.deepEqual(state, {})
  assert.equal(saved, true)
})

test("getStoredSession reuses valid persisted sessions", async () => {
  const state = { "im:D123": "s1" }
  let fetched = null
  const session = await getStoredSession({
    state,
    key: "im:D123",
    fetchSession: async (id) => { fetched = id; return { data: { id } } },
    saveState: () => assert.fail("valid session should not rewrite state"),
  })
  assert.equal(session, "s1")
  assert.equal(fetched, "s1")
})

test("session state maps survive JSON restart and reject invalid content", () => {
  const pending = new Map([["p1", { sessionID: "s1", permissionID: "p1", channel: "D123", messageTs: "1700.02" }]])
  assert.deepEqual([...loadMapFromJSON(serializeMapToJSON(pending))], [...pending])
  assert.deepEqual([...loadMapFromJSON("not-json")], [])
  assert.deepEqual([...loadMapFromJSON("[]")], [])
})

test("permission actions require allowed user, same channel/message, and live session mapping", () => {
  const pending = { sessionID: "s1", key: "C123:1700.01", channel: "C123", messageTs: "1700.02" }
  const args = {
    allowedUsers: new Set(["U123"]),
    userId: "U123",
    channelId: "C123",
    messageTs: "1700.02",
    pending,
    state: { "C123:1700.01": "s1" },
  }
  assert.equal(canRespondToPermission(args), true)
  assert.equal(canRespondToPermission({ ...args, userId: "U456" }), false)
  assert.equal(canRespondToPermission({ ...args, channelId: "C456" }), false)
  assert.equal(canRespondToPermission({ ...args, messageTs: "1700.03" }), false)
  assert.equal(canRespondToPermission({ ...args, state: { "C123:1700.01": "s2" } }), false)
})

test("permission API errors are not treated as successful responses", async () => {
  const opencode = {
    postSessionIdPermissionsPermissionId: async () => ({ error: { message: "not found" } }),
  }
  await assert.rejects(
    respondToPermission(opencode, { sessionID: "s1", permissionID: "p1", response: "once", directory: "/repo" }),
    /permission response failed/,
  )
})

test("permission API success is returned", async () => {
  const expected = { data: true }
  const opencode = { postSessionIdPermissionsPermissionId: async () => expected }
  const result = await respondToPermission(opencode, {
    sessionID: "s1",
    permissionID: "p1",
    response: "once",
    directory: "/repo",
  })
  assert.equal(result, expected)
})

test("session lock cleans up when placeholder creation fails", async () => {
  const active = new Set()
  const cleaned = []
  await assert.rejects(
    runWithSessionLock({
      active,
      sessionId: "s1",
      cleanup: (id) => { active.delete(id); cleaned.push(id) },
      run: async () => { throw new Error("Slack placeholder failed") },
    }),
    /Slack placeholder failed/,
  )
  assert.equal(active.has("s1"), false)
  assert.deepEqual(cleaned, ["s1"])
})

test("session lock stays active for tool calls until idle cleanup", async () => {
  const active = new Set()
  let cleaned = false
  const result = await runWithSessionLock({
    active,
    sessionId: "s1",
    cleanup: () => { cleaned = true },
    run: async () => ({ pending: true }),
  })
  assert.deepEqual(result, { pending: true })
  assert.equal(active.has("s1"), true)
  assert.equal(cleaned, false)
})

test("busy notice tells users their message was not queued and to resend", () => {
  assert.match(BUSY_NOTICE, /not sent/)
  assert.match(BUSY_NOTICE, /resend/i)
})
