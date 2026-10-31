import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { DEFAULT_MODEL, parseModel } from "../opencode/core"

const LOG = `${homedir()}/.cache/supervisor/audits.jsonl`
const auditFor = (sessionID: string) =>
  (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n") : [])
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    .find((entry) => entry.sessionID === sessionID)

const { client, server } = await createOpencode({ port: Number(process.env.PORT ?? 4098) })
let code = 1
try {
  const session = await client.session.create({ body: { title: "supervisor e2e" } })
  await client.session.prompt({
    path: { id: session.data!.id },
    body: {
      model: parseModel(process.env.MAIN_MODEL ?? DEFAULT_MODEL),
      parts: [{ type: "text", text: "Great question time: explain in a long markdown report with headers why the sky is blue." }],
    },
  })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !auditFor(session.data!.id)) await new Promise((r) => setTimeout(r, 1000))
  const entry = auditFor(session.data!.id)
  console.log(entry ? JSON.stringify(entry).slice(0, 900) : "NO AUDIT LOGGED FOR THIS SESSION")
  code = entry && !entry.error && (entry.verdict === "PASS" || entry.verdict === "FAIL") ? 0 : 1
  console.log(code === 0 ? "OK: installed plugin audited a real session" : "FAILED")
  await client.session.delete({ path: { id: session.data!.id } }).catch(() => {})
} finally {
  server.close()
}
process.exit(code)
