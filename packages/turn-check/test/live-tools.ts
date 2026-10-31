import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, rmSync } from "node:fs"
import { DEFAULT_MODEL, JUDGE_AGENT, judgeAgent, parseModel } from "../opencode/core"

const FILE = "/tmp/supervisor-tools-check.txt"
const model = parseModel(process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL)
const { client, server } = await createOpencode({
  port: Number(process.env.PORT ?? 4098),
  config: { agent: { [JUDGE_AGENT]: judgeAgent(process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL) } } as any,
})

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))])

async function attempt(agent: string) {
  rmSync(FILE, { force: true })
  const session = await client.session.create({ body: { title: `tools check ${agent}` } })
  let toolParts = 0
  let error = ""
  try {
    const res = await withTimeout(
      client.session.prompt({
        path: { id: session.data!.id },
        body: { agent, model, parts: [{ type: "text", text: `Use your bash tool to run exactly: echo TOOL_RAN > ${FILE}` }] },
      }),
      90000,
    )
    toolParts = (res.data?.parts ?? []).filter((p: any) => p.type === "tool").length
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const ran = existsSync(FILE)
  await client.session.delete({ path: { id: session.data!.id } }).catch(() => {})
  rmSync(FILE, { force: true })
  return { agent, toolParts, ran, error }
}

try {
  const control = await attempt("build")
  const judge = await attempt(JUDGE_AGENT)
  console.log("control (default agent):", JSON.stringify(control))
  console.log("judge agent:", JSON.stringify(judge))
  console.log(control.ran && !judge.ran && judge.toolParts === 0 ? "OK: tools run for the control and are blocked for the judge" : "INCONCLUSIVE or FAILED")
} finally {
  server.close()
}
process.exit(0)
