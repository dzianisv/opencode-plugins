import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const evalsDir = path.resolve(__dirname, "..", "evals")

const env = { ...process.env }
const rawBase = env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_API_BASE_URL

if (rawBase) {
  try {
    const url = new URL(rawBase)
    const baseHost = `${url.protocol}//${url.host}`
    if (baseHost && rawBase !== baseHost) {
      env.AZURE_OPENAI_BASE_URL = baseHost
      env.AZURE_OPENAI_API_BASE_URL = baseHost
    }
  } catch {
    // Leave env as-is if AZURE_OPENAI_BASE_URL is not a valid URL
  }
}

const args = ["promptfoo", "eval", ...process.argv.slice(2)]
const result = spawnSync("npx", args, {
  cwd: evalsDir,
  env,
  stdio: "inherit",
})

process.exit(result.status ?? 1)
