#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { App } from "@slack/bolt"
import { createOpencodeClient } from "@opencode-ai/sdk"
import {
  BUSY_NOTICE,
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
} from "./lib.mjs"

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096"
const DIRECTORY = path.resolve(process.env.OPENCODE_DIRECTORY || process.cwd())
const MODEL = process.env.OPENCODE_MODEL || ""
const AGENT = process.env.OPENCODE_AGENT || ""
const AUTO_APPROVE = process.env.SLACK_AUTO_APPROVE === "1"
const ALLOWED = new Set(
  (process.env.SLACK_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
const STATE_DIR = process.env.OPENCODE_SLACK_STATE || path.join(os.homedir(), ".local/state/opencode-slack")
const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json")
const PERMISSIONS_FILE = path.join(STATE_DIR, "permissions.json")
const ACTIVE_FILE = path.join(STATE_DIR, "active.json")
const UPDATE_MS = 1200

if (!BOT_TOKEN || !APP_TOKEN) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required")
  process.exit(1)
}

fs.mkdirSync(STATE_DIR, { recursive: true })

const opencode = createOpencodeClient({ baseUrl: OPENCODE_URL })
const app = new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true })

const state = loadState()
const placeholders = loadActiveSessions()
const active = new Set(placeholders.keys())
const assistantMessages = new Map()
const lastUpdate = new Map()
const latestText = new Map()
const pendingPermissions = loadPendingPermissions()
let botUserId = ""

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"))
  } catch {
    return {}
  }
}

function saveState() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

function loadPendingPermissions() {
  try {
    return loadMapFromJSON(fs.readFileSync(PERMISSIONS_FILE, "utf8"))
  } catch {
    return new Map()
  }
}

function savePendingPermissions() {
  fs.writeFileSync(PERMISSIONS_FILE, serializeMapToJSON(pendingPermissions), { mode: 0o600 })
}

function loadActiveSessions() {
  try {
    return loadMapFromJSON(fs.readFileSync(ACTIVE_FILE, "utf8"))
  } catch {
    return new Map()
  }
}

function saveActiveSessions() {
  fs.writeFileSync(ACTIVE_FILE, serializeMapToJSON(placeholders), { mode: 0o600 })
}

function modelBody() {
  const model = parseModel(MODEL)
  return model ? { model } : {}
}

function agentBody() {
  return AGENT ? { agent: AGENT } : {}
}

function isAllowedUser(userId) {
  return isAllowed(userId, ALLOWED)
}

async function sayThread(client, channel, thread, text) {
  const parts = chunks(toMrkdwn(text)).filter(Boolean)
  for (const part of parts) {
    await client.chat.postMessage({ channel, ...(thread ? { thread_ts: thread } : {}), text: part, mrkdwn: true })
  }
}

async function createSession(channel, thread, prompt, stateKey = keyFor(channel, thread)) {
  const title = (prompt || `Slack ${channel} ${thread}`).slice(0, 120)
  const r = await opencode.session.create({ body: { title }, query: { directory: DIRECTORY } })
  if (r.error || !r.data?.id) throw new Error(`session.create failed: ${JSON.stringify(r.error)}`)
  state[stateKey] = r.data.id
  saveState()
  return r.data.id
}

async function getSessionByKey(key) {
  return getStoredSession({
    state,
    key,
    fetchSession: (id) => opencode.session.get({ path: { id }, query: { directory: DIRECTORY } }),
    saveState,
  })
}

async function getSession(channel, thread) {
  return getSessionByKey(keyFor(channel, thread))
}

async function updatePlaceholder(client, channel, ts, text) {
  const body = text.trim() || "_Working..._"
  await client.chat.update({ channel, ts, text: toMrkdwn(body).slice(0, 39000), mrkdwn: true })
}

async function handlePrompt({ client, channel, thread, text, userId, eventTs, sessionId: existingSessionId }) {
  const isDM = channel.startsWith("D")
  const sessionKey = isDM ? `im:${channel}` : keyFor(channel, thread)
  const sessionId = existingSessionId || (isDM
    ? await getSessionByKey(sessionKey) || (await createSession(channel, "im", text, sessionKey))
    : await getSession(channel, thread))

  if (!sessionId) {
    await sayThread(client, channel, thread, "No active opencode session for this thread. Mention the bot to start one.")
    return
  }

  if (active.has(sessionId)) {
    await sayThread(client, channel, thread, BUSY_NOTICE)
    return
  }

  await runWithSessionLock({ active, sessionId, cleanup: cleanupSession, run: async () => {
    let placeholderTs
    try {
      const placeholder = await client.chat.postMessage({
        channel,
        ...(thread ? { thread_ts: thread } : {}),
        text: "_Working..._",
        mrkdwn: true,
      })
      if (placeholder.ok === false || !placeholder.ts) throw new Error("Slack could not create response placeholder")
      placeholderTs = placeholder.ts
      placeholders.set(sessionId, { channel, ts: placeholderTs })
      saveActiveSessions()
      lastUpdate.set(sessionId, 0)
      latestText.delete(sessionId)

      const r = await opencode.session.prompt({
        path: { id: sessionId },
        query: { directory: DIRECTORY },
        body: {
          ...modelBody(),
          ...agentBody(),
          parts: [{ type: "text", text }],
        },
      })

      if (r.error) throw new Error(r.error?.data?.message || JSON.stringify(r.error))
      if (r.data?.info?.finish === "tool-calls") return { pending: true }
      const answer = (r.data?.parts || [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n\n")
        .trim()
      await updatePlaceholder(client, channel, placeholderTs, answer || "_Done. No text response._")
    } catch (err) {
      const msg = `opencode error: ${err?.message || String(err)}`
      if (placeholderTs) await updatePlaceholder(client, channel, placeholderTs, msg).catch(() => {})
      else await sayThread(client, channel, thread, "Could not start the opencode response. Please retry.").catch(() => {})
      console.error(`[prompt] ${sessionId} ${msg}`)
    }
  } })
}

async function lastAssistantText(sessionId) {
  const r = await opencode.session.messages({ path: { id: sessionId }, query: { directory: DIRECTORY } })
  const messages = r.data || []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role !== "assistant") continue
    const text = (messages[i].parts || [])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}

function cleanupSession(sessionId) {
  active.delete(sessionId)
  assistantMessages.delete(sessionId)
  placeholders.delete(sessionId)
  saveActiveSessions()
  lastUpdate.delete(sessionId)
  latestText.delete(sessionId)
}

async function startThread({ client, channel, thread, text, userId, eventTs, isDM }) {
  const sessionId = await createSession(channel, isDM ? "im" : thread, text, isDM ? `im:${channel}` : keyFor(channel, thread))
  await handlePrompt({ client, channel, thread, text, userId, eventTs, sessionId })
}

async function onMention({ event, client }) {
  if (!event.text || !event.user) return
  if (!isAllowedUser(event.user)) return
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim()
  if (!text) return
  const thread = event.thread_ts || event.ts
  const existing = await getSession(event.channel, thread)
  if (!existing) {
    await startThread({ client, channel: event.channel, thread, text, userId: event.user, eventTs: event.ts, isDM: false })
  } else {
    await handlePrompt({ client, channel: event.channel, thread, text, userId: event.user, eventTs: event.ts, sessionId: existing })
  }
}

async function onMessage({ message, client }) {
  if (!message.text || !message.user) return
  if (message.bot_id || message.user === botUserId) return
  if (message.subtype && !["thread_broadcast"].includes(message.subtype)) return
  if (!isAllowedUser(message.user)) return

  const route = routeMessage({
    channel: message.channel,
    channelType: message.channel_type,
    threadTs: message.thread_ts,
    text: message.text,
    botUserId,
  })
  const next = routeAction(route, state)
  if (route.kind === "dm") {
    const sessionId = await getSessionByKey(route.key)
    if (!sessionId) {
      await startThread({ client, channel: route.channel, thread: null, text: message.text, userId: message.user, eventTs: message.ts, isDM: true })
    } else {
      await handlePrompt({ client, channel: route.channel, thread: null, text: message.text, userId: message.user, eventTs: message.ts, sessionId })
    }
    return
  }

  if (route.kind !== "thread" || next.kind !== "continue") return
  const sessionId = await getSession(route.channel, route.thread)
  if (!sessionId) return
  await handlePrompt({ client, channel: route.channel, thread: route.thread, text: message.text, userId: message.user, eventTs: message.ts, sessionId })
}

async function onPermission(perm) {
  if (!perm?.sessionID) return
  const context = permissionContext(state, perm.sessionID)
  if (!context) return
  if (AUTO_APPROVE) {
    try {
      await respondToPermission(opencode, {
        sessionID: perm.sessionID,
        permissionID: perm.id,
        response: "always",
        directory: DIRECTORY,
      })
      return
    } catch (err) {
      console.error("[permission:auto-approve]", err.message)
    }
  }
  const title = perm.permission || perm.title || perm.type || "Permission request"
  const patterns = perm.patterns || perm.pattern
  const detail = patterns ? `${title}: ${Array.isArray(patterns) ? patterns.join(", ") : patterns}` : title
  const message = await app.client.chat.postMessage({
    channel: context.channel,
    ...(context.thread ? { thread_ts: context.thread } : {}),
    text: `Permission required: ${detail}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Permission required*\n${detail}` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Allow once" }, action_id: "perm_once", value: perm.id },
          { type: "button", text: { type: "plain_text", text: "Always" }, action_id: "perm_always", value: perm.id },
          { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "perm_reject", value: perm.id, style: "danger" },
        ],
      },
    ],
  })
  if (message.ok === false || !message.ts) throw new Error("Slack could not post permission request")
  pendingPermissions.set(perm.id, {
    sessionID: perm.sessionID,
    permissionID: perm.id,
    key: context.key,
    channel: context.channel,
    messageTs: message.ts,
  })
  savePendingPermissions()
}

function wireActions() {
  for (const [action, response] of [
    ["perm_once", "once"],
    ["perm_always", "always"],
    ["perm_reject", "reject"],
  ]) {
    app.action(action, async ({ action: a, ack, respond, body }) => {
      await ack()
      const pending = pendingPermissions.get(a.value)
      const allowed = canRespondToPermission({
        allowedUsers: ALLOWED,
        userId: body.user?.id,
        channelId: body.channel?.id,
        messageTs: body.message?.ts,
        pending,
        state,
      })
      if (!allowed) {
        await respond({ response_type: "ephemeral", text: "This permission action is not authorized or has expired." })
        return
      }
      try {
        await respondToPermission(opencode, {
          sessionID: pending.sessionID,
          permissionID: pending.permissionID,
          response,
          directory: DIRECTORY,
        })
      } catch (err) {
        console.error("[permission:response]", err.message)
        await respond({ response_type: "ephemeral", text: "Permission response failed. Try again." })
        return
      }
      pendingPermissions.delete(a.value)
      savePendingPermissions()
      await respond({ replace_original: true, text: `Permission ${response}.` })
    })
  }
}

async function subscribeEvents() {
  const events = await opencode.event.subscribe({ query: { directory: DIRECTORY } })
  console.log("[events] subscribed")
  for await (const event of events.stream) {
    if (event.type === "session.error") console.log("[event] session.error", event.properties?.sessionID)
    if (event.type === "message.updated") {
      const info = event.properties.info
      if (info.role === "assistant") assistantMessages.set(info.sessionID, info.id)
      continue
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type !== "text" || !part.text) continue
      const assistantId = assistantMessages.get(part.sessionID)
      if (!assistantId || part.messageID !== assistantId) continue
      if (!active.has(part.sessionID)) continue
      const slot = placeholders.get(part.sessionID)
      if (!slot) continue
      latestText.set(part.sessionID, part.text)
      const now = Date.now()
      if (now - (lastUpdate.get(part.sessionID) || 0) < UPDATE_MS) continue
      lastUpdate.set(part.sessionID, now)
      await updatePlaceholder(app.client, slot.channel, slot.ts, part.text).catch(() => {})
      continue
    }

    if (event.type === "session.idle") {
      const sid = event.properties.sessionID
      const slot = placeholders.get(sid)
      if (!slot) continue
      const fetched = await lastAssistantText(sid).catch(() => "")
      const text = fetched || latestText.get(sid) || "_Done. No text response._"
      await updatePlaceholder(app.client, slot.channel, slot.ts, text).catch(() => {})
      cleanupSession(sid)
      continue
    }

    if (event.type === "permission.asked" || event.type === "permission.updated") {
      await onPermission(event.properties).catch((err) => console.error("[permission]", err.message))
      continue
    }

    if (event.type === "session.error") {
      const sid = event.properties.sessionID
      const key = Object.entries(state).find(([, id]) => id === sid)?.[0]
      if (!key) continue
      const channel = key.startsWith("im:") ? key.slice(3) : key.split(":")[0]
      const thread = key.startsWith("im:") ? undefined : key.split(":")[1]
      const msg = event.properties.error?.data?.message || "opencode session error"
      await app.client.chat.postMessage({ channel, ...(thread ? { thread_ts: thread } : {}), text: `opencode error: ${msg}` }).catch(() => {})
    }
  }
  console.log("[events] stream ended")
}

async function main() {
  if (ALLOWED.size === 0) throw new Error("SLACK_ALLOWED_USERS must list authorized Slack user IDs")
  wireActions()
  app.event("app_mention", async ({ event, client }) => {
    await onMention({ event, client }).catch((err) => console.error("[mention]", err.message))
  })
  app.message(async ({ message, client }) => {
    await onMessage({ message, client }).catch((err) => console.error("[message]", err.message))
  })
  await app.start()
  const auth = await app.client.auth.test()
  botUserId = auth.user_id
  console.log(`opencode-slack bridge up: team=${auth.team} bot=${auth.user_id} dir=${DIRECTORY} model=${MODEL || "server-default"}`)
  subscribeEvents().catch((err) => {
    console.error("[events] stream failed:", err.message)
    process.exit(1)
  })
}

process.on("SIGINT", async () => {
  await app.stop().catch(() => {})
  process.exit(0)
})
process.on("SIGTERM", async () => {
  await app.stop().catch(() => {})
  process.exit(0)
})

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
