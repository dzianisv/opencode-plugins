export const MAX_TEXT = 3500
export const BUSY_NOTICE = "Still working on the previous message. This message was not sent; resend it after the current reply finishes."

export function keyFor(channel, thread) {
  return `${channel}:${thread}`
}

export function routeMessage({ channel, channelType, threadTs, text, botUserId }) {
  if (!channel || !text) return { kind: "ignore" }
  const isDM = channel.startsWith("D") || channelType === "im"
  if (!isDM && botUserId && text.includes(`<@${botUserId}>`)) return { kind: "ignore" }
  if (isDM) return { kind: "dm", channel, thread: null, key: `im:${channel}` }
  if (!threadTs) return { kind: "ignore" }
  return { kind: "thread", channel, thread: threadTs, key: keyFor(channel, threadTs) }
}

export function routeAction(route, state) {
  if (route.kind === "ignore") return { kind: "ignore" }
  const sessionId = state[route.key]
  if (route.kind === "dm" && !sessionId) return { kind: "start" }
  if (!sessionId) return { kind: "ignore" }
  return { kind: "continue", sessionId }
}

export async function getStoredSession({ state, key, fetchSession, saveState }) {
  const sessionID = state[key]
  if (!sessionID) return null
  const result = await fetchSession(sessionID)
  if (result?.error) {
    const status = result.error?.data?.statusCode ?? result.error?.statusCode ?? result.error?.status
    if (status !== 404) throw new Error(`opencode session lookup failed${status ? ` (${status})` : ""}`)
    delete state[key]
    saveState()
    return null
  }
  if (!result?.data?.id) throw new Error("opencode session lookup returned no session")
  return sessionID
}

export function loadMapFromJSON(json) {
  try {
    const value = JSON.parse(json)
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map()
    return new Map(Object.entries(value).filter(([, entry]) => entry && typeof entry === "object"))
  } catch {
    return new Map()
  }
}

export function serializeMapToJSON(map) {
  return JSON.stringify(Object.fromEntries(map), null, 2)
}

export function isPermissionPending(pending, permissionID) {
  return pending.has(permissionID)
}

export function sessionFinished(messages) {
  const assistant = [...messages].reverse().find((message) => message.info?.role === "assistant")
  return Boolean(assistant && (assistant.info?.time?.completed || assistant.info?.error))
}

export function assistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role !== "assistant") continue
    const text = (messages[i].parts || [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}

export function dedupePromise(pending, key, run) {
  const existing = pending.get(key)
  if (existing) return existing
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (pending.get(key) === promise) pending.delete(key)
    })
  pending.set(key, promise)
  return promise
}

export function parseModel(value) {
  if (!value) return null
  const i = value.indexOf("/")
  if (i < 1 || i === value.length - 1) return null
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) }
}

export function toMrkdwn(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
    .replace(/`([^`\n]+)`/g, "`$1`")
}

export function chunks(text, max = MAX_TEXT) {
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) out.push(rest)
  return out
}

export function isAllowed(userId, allowedUsers) {
  return Boolean(userId && allowedUsers.has(userId))
}

export function permissionContext(state, sessionID) {
  const entry = Object.entries(state).find(([, id]) => id === sessionID)
  if (!entry) return null

  const [key] = entry
  if (key.startsWith("im:")) return { key, channel: key.slice(3), thread: undefined }

  const i = key.indexOf(":")
  if (i < 1) return null
  return { key, channel: key.slice(0, i), thread: key.slice(i + 1) }
}

export function canRespondToPermission({ allowedUsers, userId, channelId, messageTs, pending, state }) {
  return Boolean(
    pending &&
      pending.resolved !== true &&
      isAllowed(userId, allowedUsers) &&
      channelId === pending.channel &&
      messageTs === pending.messageTs &&
      state[pending.key] === pending.sessionID,
  )
}

export async function respondToPermission(opencode, { sessionID, permissionID, response, directory }) {
  const result = await opencode.postSessionIdPermissionsPermissionId({
    path: { id: sessionID, permissionID },
    query: { directory },
    body: { response },
  })
  if (result?.error) throw new Error("opencode permission response failed")
  return result
}

export async function runWithSessionLock({ active, sessionId, cleanup, run }) {
  active.add(sessionId)
  let pending = false
  try {
    const result = await run()
    pending = result?.pending === true
    return result
  } finally {
    if (!pending) cleanup(sessionId)
  }
}
