import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const MODEL = process.env.MAIN_MODEL ?? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
const [providerID, ...rest] = MODEL.split("/")
const model = { providerID, modelID: rest.join("/") }
const root = join(dirname(import.meta.path), "..")
const pluginURL = `file://${join(root, "plugin.ts")}`
const workdir = "/tmp/session-self-improve-live"
const target = join(workdir, "run.sh")
const home = mkdtempSync(join(tmpdir(), "session-self-improve-live-"))
const modules = join(root, "node_modules")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(500)
  }
  return false
}

const linked = !existsSync(modules)
if (linked) symlinkSync(join(homedir(), ".config", "opencode", "node_modules"), modules)
const checks: [string, boolean][] = []
const check = (name: string, ok: boolean) => {
  checks.push([name, ok])
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
}

let server: { close(): void } | undefined
let code = 1
const abort = new AbortController()
const cleanup = () => {
  abort.abort()
  server?.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  if (linked && existsSync(modules) && lstatSync(modules).isSymbolicLink()) rmSync(modules)
}
setTimeout(() => {
  console.log("FAILED: watchdog expired")
  cleanup()
  process.exit(1)
}, 480000)
try {
  const { createOpencode } = await import("@opencode-ai/sdk")
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  process.chdir(workdir)
  process.env.SESSION_SELF_IMPROVE_HOME = home
  process.env.SUPERVISOR_ENABLED = "0"

  const opened = await createOpencode({
    port: Number(process.env.PORT ?? 4097),
    timeout: 30000,
    config: { plugin: [pluginURL], permission: { "*": "allow" } } as any,
  })
  const { client } = opened
  server = opened.server

  const commands = ((await client.command.list()).data ?? []) as any[]
  const command = commands.find((c) => c.name === "session-self-improve")
  check("client.command.list() has session-self-improve", Boolean(command))
  check("command template starts with the heading and has $ARGUMENTS", Boolean(command?.template?.startsWith("# session-self-improve") && command.template.includes("$ARGUMENTS")))

  const toasts: any[] = []
  const stream = await client.event.subscribe({ signal: abort.signal } as any)
  void (async () => {
    try {
      for await (const event of stream.stream as AsyncIterable<any>) if (event.type === "tui.toast.show") toasts.push(event.properties)
    } catch {}
  })()

  const session = (await client.session.create({ body: { title: "session-self-improve e2e" } })).data!
  const messages = async (id: string) => (((await client.session.messages({ path: { id } })).data ?? []) as any[])
  const prompt = (id: string, text: string) =>
    client.session.prompt({ path: { id }, body: { model, parts: [{ type: "text", text }] } }).catch((e) => console.log("prompt error", String(e)))
  const settled = async (id: string, want: number) =>
    until(async () => (await messages(id)).filter((m) => m.info.role === "assistant" && m.info.time?.completed).length >= want, 120000)

  await prompt(session.id, `Create the file ${target} containing echo hi`)
  check("assistant turn completed", await settled(session.id, 1))
  const writes = (await messages(session.id)).flatMap((m) => m.parts).filter((p: any) => p.type === "tool" && p.tool === "write")
  console.log("write tool parts:", JSON.stringify(writes.map((p: any) => ({ status: p.state.status, input: p.state.input, metadata: { exists: p.state.metadata?.exists, filepath: p.state.metadata?.filepath } }))))
  check("agent created the script", existsSync(target) && readFileSync(target, "utf8").includes("echo hi"))
  check("write result metadata.exists === false", writes.some((p: any) => p.state.status === "completed" && p.state.metadata?.exists === false))

  check("toast appeared on idle", await until(() => toasts.length > 0, 30000))
  console.log("toast:", JSON.stringify(toasts[0] ?? null))
  check("toast mentions the new script file", Boolean(toasts[0]?.message?.includes("1 new script file(s)")))
  check("marker file written", existsSync(join(home, "markers", `${session.id}.mark`)))

  await prompt(session.id, "From now on always add a shebang line to shell scripts. Just reply ok.")
  await settled(session.id, 2)
  const queueFile = join(home, "queue", `${session.id}.jsonl`)
  const queued = existsSync(queueFile) ? readFileSync(queueFile, "utf8") : ""
  console.log("queue:", queued.trim())
  const record = queued.trim() ? JSON.parse(queued.trim().split("\n")[0]) : undefined
  check("cue record queued with kinds and messageID", Boolean(record?.kinds?.includes("rule") && String(record?.messageID).startsWith("msg_")))
  check("queue holds no prompt text", Boolean(queued) && !queued.toLowerCase().includes("shebang"))
  const userIDs = (await messages(session.id)).filter((m) => m.info.role === "user").map((m) => m.info.id)
  check("record points at a real user message", userIDs.includes(record?.messageID))
  check("only one reminder toast", toasts.length === 1)

  const second = (await client.session.create({ body: { title: "session-self-improve command" } })).data!
  const before = existsSync(join(home, "queue")) ? readFileSync(queueFile, "utf8") : ""
  void client.session.command({ path: { id: second.id }, body: { command: "session-self-improve", arguments: "--dry-run", model: MODEL } }).catch(() => {})
  let expanded = ""
  await until(async () => {
    const user = (await messages(second.id)).find((m) => m.info.role === "user")
    expanded = user?.parts?.find((p: any) => p.type === "text")?.text ?? ""
    return Boolean(expanded)
  }, 30000)
  check("command expands with the real session id and arguments", expanded.includes(`Current session id: ${second.id}`) && expanded.includes("Arguments: --dry-run"))
  check("expanded template is not queued as a cue", !existsSync(join(home, "queue", `${second.id}.jsonl`)) && before === (existsSync(queueFile) ? readFileSync(queueFile, "utf8") : ""))
  await client.session.abort({ path: { id: second.id } }).catch(() => {})

  for (const id of [session.id, second.id]) await client.session.delete({ path: { id } }).catch(() => {})
  code = checks.every(([, ok]) => ok) ? 0 : 1
  console.log(code === 0 ? "OK: all live checks passed" : "FAILED: " + checks.filter(([, ok]) => !ok).map(([n]) => n).join("; "))
} catch (err) {
  console.log("live check error:", err instanceof Error ? err.stack : String(err))
} finally {
  cleanup()
}
process.exit(code)
