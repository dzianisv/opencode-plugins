import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MARKER = "BANANA-4417"
const dir = mkdtempSync(join(tmpdir(), "supervisor-multistep-"))
const rules = join(dir, "RULES.md")
writeFileSync(rules, `Every reply must end with the exact token ${MARKER}.\n`)
process.env.SUPERVISOR_RULES = rules
process.env.SUPERVISOR_HOME = join(dir, "home")
const log = join(dir, "home", "audits.jsonl")

const port = Number(process.env.PORT ?? 4098)
const model = (process.env.MAIN_MODEL ?? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash").split("/")
const plugin = `file://${join(import.meta.dir, "..", "opencode", "plugin.ts")}`
const { client, server } = await createOpencode({ port, config: { plugin: [plugin] } as any })

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))])
const textOf = (res: any) => (res.data?.parts ?? []).flatMap((p: any) => (p.type === "text" ? [p.text] : [])).join("")
const ask = async (id: string, text: string) =>
  withTimeout(
    client.session.prompt({ path: { id }, body: { model: { providerID: model[0], modelID: model.slice(1).join("/") }, parts: [{ type: "text", text }] } }),
    120000,
  )

let code = 1
try {
  const session = await client.session.create({ body: { title: "supervisor multistep" } })
  const id = session.data!.id
  console.log("turn 1:", textOf(await ask(id, "What is 2+2? Answer in one word.")).slice(0, 80).replace(/\n/g, " "))

  const deadline = Date.now() + 90000
  const verdict = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.sessionID === id) : undefined)
  while (Date.now() < deadline && !verdict()) await new Promise((r) => setTimeout(r, 1000))
  const entry = verdict()
  console.log("audit:", entry ? `${entry.verdict} ${entry.error ?? ""}` : "none logged")

  const target = join(dir, "note.txt")
  const reply = textOf(await ask(id, `Use your write tool to create ${target} containing the word hi, then tell me when it is done.`))
  console.log("turn 2 (after a tool call):", reply.slice(0, 160).replace(/\n/g, " "))
  console.log("file written:", existsSync(target))
  const seen = reply.includes(MARKER)
  code = entry?.verdict === "FAIL" && existsSync(target) && seen ? 0 : 1
  console.log(code === 0 ? "OK: feedback reached the model after a tool call" : "FAILED: marker missing or no FAIL audit")
  await client.session.delete({ path: { id } }).catch(() => {})
} catch (err) {
  console.log("ERROR:", err instanceof Error ? err.message : String(err))
} finally {
  server.close()
  Bun.spawnSync(["sh", "-c", `p=$(lsof -ti tcp:${port} -sTCP:LISTEN); [ -n "$p" ] && kill $p; true`])
}
process.exit(code)
