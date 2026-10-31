import { createOpencode } from "@opencode-ai/sdk"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MARKER = "ZEBRA-7731"
const file = join(mkdtempSync(join(tmpdir(), "overhelm-live-")), "overhelm.md")
writeFileSync(file, `End every reply with the exact token ${MARKER}.\n`)
process.env.OVERHELM_FILE = file

const model = (process.env.MAIN_MODEL ?? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash").split("/")
const plugin = `file://${join(import.meta.dir, "..", "plugin.ts")}`
const { client, server } = await createOpencode({ port: Number(process.env.PORT ?? 4098), config: { plugin: [plugin] } as any })

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))])

let code = 1
try {
  const session = await client.session.create({ body: { title: "overhelm e2e" } })
  const res = await withTimeout(
    client.session.prompt({
      path: { id: session.data!.id },
      body: { model: { providerID: model[0], modelID: model.slice(1).join("/") }, parts: [{ type: "text", text: "What is 2+2?" }] },
    }),
    90000,
  )
  const reply = (res.data?.parts ?? []).flatMap((p: any) => (p.type === "text" ? [p.text] : [])).join("")
  console.log("reply:", reply.slice(0, 200))
  code = reply.includes(MARKER) ? 0 : 1
  console.log(code === 0 ? "OK: the model received the injected instruction" : "FAILED: marker not in reply")
  await client.session.delete({ path: { id: session.data!.id } }).catch(() => {})
} catch (err) {
  console.log("ERROR:", err instanceof Error ? err.message : String(err))
} finally {
  server.close()
}
process.exit(code)
