export const MAX_TEXT = 3500

export function keyFor(channel, thread) {
  return `${channel}:${thread}`
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
