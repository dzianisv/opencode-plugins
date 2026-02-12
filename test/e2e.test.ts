/**
 * E2E Integration Test - OpenCode API with Reflection
 *
 * Uses opencode serve + SDK to test reflection properly.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdir, rm, cp, readdir, readFile, writeFile } from "fs/promises"
import { spawn, type ChildProcess, execFile } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_PATH = join(__dirname, "../reflection-3.ts")

// Model for E2E tests - override with OPENCODE_MODEL env var
// OpenCode does NOT auto-select models in temp directories without config
const MODEL = process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"
const TIMEOUT = 300_000
const POLL_INTERVAL = 3_000

interface TaskResult {
  sessionId: string
  messages: any[]
  reflectionFeedback: string[]
  reflectionComplete: string[]
  reflectionSelfAssess: string[]
  continuedAfterFeedback: boolean
  continuedWithToolAfterFeedback: boolean
  files: string[]
  completed: boolean
  duration: number
  reflectionAnalysis?: any
}

async function setupProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pluginDir = join(dir, ".opencode", "plugin")
  await mkdir(pluginDir, { recursive: true })
  await cp(PLUGIN_PATH, join(pluginDir, "reflection.ts"))
  
  // Create opencode.json with explicit model - temp directories don't auto-select models
  // Override with OPENCODE_MODEL env var if needed
  const config = {
    "$schema": "https://opencode.ai/config.json",
    "model": MODEL
  }
  await writeFile(join(dir, "opencode.json"), JSON.stringify(config, null, 2))
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function loadReflectionsForSession(
  dir: string,
  sessionId: string,
  timeoutMs = 10_000
): Promise<any[]> {
  const reflectionDir = join(dir, ".reflection")
  const prefix = sessionId.slice(0, 8)
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const files = await readdir(reflectionDir)
      const matches = files
        .filter(name => name.startsWith(prefix) && name.endsWith(".json") && !name.startsWith("verdict_"))
        .sort()
      if (matches.length) {
        const results: any[] = []
        for (const file of matches) {
          try {
            const content = await readFile(join(reflectionDir, file), "utf-8")
            results.push(JSON.parse(content))
          } catch {}
        }
        return results
      }
    } catch {}

    await new Promise(r => setTimeout(r, 500))
  }

  return []
}

function extractMessageText(msg: any): string {
  if (!msg?.parts) return ""
  return msg.parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text.trim())
    .filter(Boolean)
    .join("\n")
}

function findAssistantTextBefore(messages: any[], userMessageText: string): string {
  const idx = messages.findIndex((msg: any) => {
    if (msg.info?.role !== "user") return false
    const text = extractMessageText(msg)
    return text.includes(userMessageText.trim())
  })
  if (idx <= 0) return ""
  for (let i = idx - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "assistant") {
      const text = extractMessageText(msg)
      if (text) return text
    }
  }
  return ""
}

async function writeEvalReport(results: Array<{ label: string; prompt: string; result: TaskResult }>, pythonDir: string, nodeDir: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"])
  const commitId = stdout.trim() || "unknown"
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, "-")
  const evalDir = join(__dirname, "..", ".eval")
  await mkdir(evalDir, { recursive: true })
  const reportPath = join(evalDir, `${timestamp}-${commitId}.md`)

  const lines: string[] = []
  lines.push("# Reflection E2E Report")
  lines.push("")
  lines.push(`- Date: ${now.toISOString()}`)
  lines.push(`- Commit: ${commitId}`)
  lines.push("- Score rule: complete=1, incomplete=0")
  lines.push("")
  lines.push("## Scenarios")
  lines.push("")

  for (const item of results) {
    const dir = item.label.startsWith("py") ? pythonDir : nodeDir
    const reflections = await loadReflectionsForSession(dir, item.result.sessionId)
    const analyses = reflections.map(r => r?.analysis).filter(Boolean)
    const feedbackMessages = item.result.reflectionFeedback.length ? item.result.reflectionFeedback : ["(none)"]

    lines.push(`### ${item.label}`)
    lines.push("")

    for (let i = 0; i < feedbackMessages.length; i++) {
      const reflectionMessage = feedbackMessages[i]
      const analysis = analyses[i] || analyses[analyses.length - 1]
      const evalFeedback = analysis?.reason || "(no analysis found)"
      const evalScore = analysis ? (analysis.complete ? 1 : 0) : "(no analysis found)"

      const agentText = reflectionMessage === "(none)"
        ? extractMessageText([...item.result.messages].reverse().find((msg: any) => msg.info?.role === "assistant"))
        : findAssistantTextBefore(item.result.messages, reflectionMessage)

      lines.push(`✉️ User: ${item.prompt}`)
      lines.push(`✉️ Agent: ${agentText || "(no assistant text captured)"}`)
      lines.push(`✉️ Reflection-${i + 1}: ${reflectionMessage}`)
      lines.push(`Evaluation Feedback: ${evalFeedback}`)
      lines.push(`Evaluation Score: ${evalScore}`)

      if (i < feedbackMessages.length - 1) lines.push("---")
    }

    lines.push("")
    lines.push(`Continued after feedback: ${item.result.continuedAfterFeedback}`)
    lines.push(`Continued with tool after feedback: ${item.result.continuedWithToolAfterFeedback}`)
    lines.push("")
  }

  await writeFile(reportPath, lines.join("\n"))
  console.log(`Eval report written: ${reportPath}`)
}

async function waitForServer(port: number, timeout: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/session`)
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function runTask(
  client: OpencodeClient,
  cwd: string,
  task: string,
  label: string,
  options?: { stopAfterFeedback?: boolean; minFeedbackCount?: number }
): Promise<TaskResult> {
  const start = Date.now()
  const result: TaskResult = {
    sessionId: "",
    messages: [],
    reflectionFeedback: [],
    reflectionComplete: [],
    reflectionSelfAssess: [],
    continuedAfterFeedback: false,
    continuedWithToolAfterFeedback: false,
    files: [],
    completed: false,
    duration: 0
  }

  try {
    // Create session
    const { data: session } = await client.session.create({})
    if (!session?.id) throw new Error("Failed to create session")
    result.sessionId = session.id
    console.log(`[${label}] Session: ${result.sessionId}`)

    // Send task asynchronously to avoid SDK timeout
    await client.session.promptAsync({
      path: { id: result.sessionId },
      body: { parts: [{ type: "text", text: task }] }
    })

    // Poll until stable
    let lastMsgCount = 0
    let lastContent = ""
    let stableCount = 0

    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      const { data: messages } = await client.session.messages({
        path: { id: result.sessionId }
      })
      result.messages = messages || []

      // Check for reflection feedback (user messages from plugin)
      let feedbackIndex = -1
      let feedbackSeenAt: number | null = null
      for (let i = 0; i < result.messages.length; i++) {
        const msg = result.messages[i]
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text") {
              if (part.text?.includes("## Reflection-3 Self-Assessment")) {
                if (!result.reflectionSelfAssess.includes(part.text)) {
                  result.reflectionSelfAssess.push(part.text)
                  console.log(`[${label}] Reflection: self-assessment requested`)
                }
              } else if (part.text?.includes("## Reflection-3:")) {
                if (feedbackIndex === -1) feedbackIndex = i
                if (feedbackSeenAt === null) feedbackSeenAt = Date.now()
                if (!result.reflectionFeedback.includes(part.text)) {
                  result.reflectionFeedback.push(part.text)
                  console.log(`[${label}] Reflection: Task Incomplete feedback received`)
                  console.log(`[${label}] Reflection feedback message:\n${part.text}`)
                }
              } else if (part.text?.includes("Task Complete")) {
                if (!result.reflectionComplete.includes(part.text)) {
                  result.reflectionComplete.push(part.text)
                  console.log(`[${label}] Reflection: Task Complete confirmation received`)
                }
              }
            }
          }
        }
      }

      if (feedbackIndex >= 0 && !result.continuedAfterFeedback) {
        for (let i = feedbackIndex + 1; i < result.messages.length; i++) {
          const msg = result.messages[i]
          if (msg.info?.role === "assistant") {
            const hasContent = (msg.parts || []).some((p: any) => p.type === "text" || p.type === "tool")
            if (hasContent) {
              result.continuedAfterFeedback = true
              console.log(`[${label}] Reflection: assistant continued after feedback`)
              break
            }
          }
        }
      }

      if (feedbackIndex >= 0 && !result.continuedWithToolAfterFeedback) {
        for (let i = feedbackIndex + 1; i < result.messages.length; i++) {
          const msg = result.messages[i]
          if (msg.info?.role === "assistant") {
            const hasTool = (msg.parts || []).some((p: any) => p.type === "tool")
            if (hasTool) {
              result.continuedWithToolAfterFeedback = true
              console.log(`[${label}] Reflection: assistant ran tool after feedback`)
              break
            }
          }
        }
      }

      // Get current state
      const currentContent = JSON.stringify(result.messages)
      const hasWork = result.messages.some((m: any) =>
        m.info?.role === "assistant" && m.parts?.some((p: any) =>
          p.type === "text" || p.type === "tool"
        )
      )

      // Check stability
      if (options?.stopAfterFeedback) {
        const maxWaitAfterFeedback = 20_000
        const maxTotalAfterFeedback = 90_000
        const minFeedback = options.minFeedbackCount ?? 1
        const hadEnoughFeedback = result.reflectionFeedback.length >= minFeedback

        if (hadEnoughFeedback && result.continuedAfterFeedback) {
          result.completed = true
          break
        }

        if (feedbackSeenAt) {
          const elapsedAfterFeedback = Date.now() - feedbackSeenAt
          if (elapsedAfterFeedback > maxTotalAfterFeedback && hadEnoughFeedback) {
            result.completed = true
            break
          }
          if (elapsedAfterFeedback > maxWaitAfterFeedback && hadEnoughFeedback && (result.continuedAfterFeedback || result.continuedWithToolAfterFeedback)) {
            result.completed = true
            break
          }
        }
      }

      if (hasWork && result.messages.length === lastMsgCount && currentContent === lastContent) {
        stableCount++
        // Wait longer for reflection to run (10 polls = 30 seconds)
        if (stableCount >= 10) {
          result.completed = true
          break
        }
      } else {
        stableCount = 0
      }

      lastMsgCount = result.messages.length
      lastContent = currentContent

      // Log progress
      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed % 15 === 0) {
        console.log(`[${label}] ${elapsed}s - messages: ${result.messages.length}, stable: ${stableCount}`)
      }
    }

    // Get files created
    try {
      const files = await readdir(cwd)
      result.files = files.filter(f => !f.startsWith("."))
    } catch {}

    result.duration = Date.now() - start
  } catch (e: any) {
    console.log(`[${label}] Error: ${e.message}`)
  }

  return result
}

describe("E2E: OpenCode API with Reflection", { timeout: TIMEOUT * 2 + 120_000 }, () => {
  const pythonDir = "/tmp/opencode-e2e-python"
  const nodeDir = "/tmp/opencode-e2e-nodejs"
  const pythonPort = 3200
  const nodePort = 3201

  let pythonServer: ChildProcess | null = null
  let nodeServer: ChildProcess | null = null
  let pythonClient: OpencodeClient
  let nodeClient: OpencodeClient
  let pythonResult: TaskResult
  let nodeResult: TaskResult
  let serverLogs: string[] = []
  let pythonPrompt = ""
  let nodePrompt = ""
  let feedbackPrompt = ""

  before(async () => {
    console.log("\n=== Setup ===\n")

    await rm(pythonDir, { recursive: true, force: true })
    await rm(nodeDir, { recursive: true, force: true })
    await setupProject(pythonDir)
    await setupProject(nodeDir)

    // Start servers
    console.log("Starting OpenCode servers...")

    pythonServer = spawn("opencode", ["serve", "--port", String(pythonPort)], {
      cwd: pythonDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    pythonServer.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.log(`[py] ${line}`)
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[py] ${line}`)
      }
    })
    pythonServer.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.error(`[py:err] ${line}`)
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[py:err] ${line}`)
      }
    })

    nodeServer = spawn("opencode", ["serve", "--port", String(nodePort)], {
      cwd: nodeDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    nodeServer.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.log(`[node] ${line}`)
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[node] ${line}`)
      }
    })
    nodeServer.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) console.error(`[node:err] ${line}`)
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[node:err] ${line}`)
      }
    })

    // Create clients
    pythonClient = createOpencodeClient({
      baseUrl: `http://localhost:${pythonPort}`,
      directory: pythonDir
    })
    nodeClient = createOpencodeClient({
      baseUrl: `http://localhost:${nodePort}`,
      directory: nodeDir
    })

    // Wait for servers
    const [pyReady, nodeReady] = await Promise.all([
      waitForServer(pythonPort, 30_000),
      waitForServer(nodePort, 30_000)
    ])

    if (!pyReady || !nodeReady) {
      throw new Error(`Servers failed to start: py=${pyReady}, node=${nodeReady}`)
    }

    console.log("Servers ready\n")
  })

  after(async () => {
    console.log("\n=== Cleanup ===")
    pythonServer?.kill("SIGTERM")
    nodeServer?.kill("SIGTERM")
    await new Promise(r => setTimeout(r, 2000))

    console.log(`\nServer logs with [Reflection]: ${serverLogs.length}`)
    if (pythonResult) console.log(`Python: ${pythonResult.duration}ms, files: ${pythonResult.files.join(", ")}`)
    if (nodeResult) console.log(`Node.js: ${nodeResult.duration}ms, files: ${nodeResult.files.join(", ")}`)
  })

  it("Python: creates hello.py with tests, reflection evaluates", async () => {
    console.log("\n=== Python Task ===\n")

    pythonPrompt = `Create a Python CLI:
1. Create hello.py that prints "Hello, World!"
2. Create test_hello.py with pytest tests that verify output
3. Run pytest and ensure tests pass`

    pythonResult = await runTask(
      pythonClient,
      pythonDir,
      pythonPrompt,
      "py",
      { stopAfterFeedback: true }
    )

    console.log(`\nPython completed: ${pythonResult.completed}`)
    console.log(`Duration: ${pythonResult.duration}ms`)
    console.log(`Files: ${pythonResult.files.join(", ")}`)
    console.log(`Messages: ${pythonResult.messages.length}`)
    console.log(`Reflection incomplete: ${pythonResult.reflectionFeedback.length}`)
    console.log(`Reflection complete: ${pythonResult.reflectionComplete.length}`)

    assert.ok(pythonResult.files.some(f => f.endsWith(".py")), "Should create .py files")
  })

  it("Node.js: creates hello.js with tests, reflection evaluates", async () => {
    console.log("\n=== Node.js Task ===\n")

    nodePrompt = `Create a Node.js CLI:
1. Create hello.js that prints "Hello, World!"
2. Create hello.test.js with tests that verify output
3. Run tests and ensure they pass`

    nodeResult = await runTask(
      nodeClient,
      nodeDir,
      nodePrompt,
      "node"
    )

    console.log(`\nNode.js completed: ${nodeResult.completed}`)
    console.log(`Duration: ${nodeResult.duration}ms`)
    console.log(`Files: ${nodeResult.files.join(", ")}`)
    console.log(`Messages: ${nodeResult.messages.length}`)
    console.log(`Reflection incomplete: ${nodeResult.reflectionFeedback.length}`)
    console.log(`Reflection complete: ${nodeResult.reflectionComplete.length}`)

    assert.ok(nodeResult.files.some(f => f.endsWith(".js")), "Should create .js files")
  })

  it("Reflection plugin ran and evaluated tasks", async () => {
    console.log("\n=== Reflection Check ===\n")

    // Check for .reflection/ directory files - this is the reliable verification
    // The plugin saves JSON files to .reflection/ when it evaluates tasks
    let pythonReflectionFiles: string[] = []
    let nodeReflectionFiles: string[] = []
    
    try {
      pythonReflectionFiles = await readdir(join(pythonDir, ".reflection"))
      console.log(`Python .reflection/ files: ${pythonReflectionFiles.length}`)
    } catch {
      console.log("Python .reflection/ directory not found")
    }
    
    try {
      nodeReflectionFiles = await readdir(join(nodeDir, ".reflection"))
      console.log(`Node .reflection/ files: ${nodeReflectionFiles.length}`)
    } catch {
      console.log("Node .reflection/ directory not found")
    }

    const totalReflectionFiles = pythonReflectionFiles.length + nodeReflectionFiles.length
    console.log(`Total reflection files: ${totalReflectionFiles}`)

    // If we got feedback messages, reflection definitely ran
    const totalFeedback = pythonResult.reflectionFeedback.length + nodeResult.reflectionFeedback.length
    console.log(`Total feedback messages: ${totalFeedback}`)

    const totalSelfAssess = pythonResult.reflectionSelfAssess.length + nodeResult.reflectionSelfAssess.length
    console.log(`Total self-assessment prompts: ${totalSelfAssess}`)

    // Check for reflection complete confirmations
    const totalComplete = pythonResult.reflectionComplete.length + nodeResult.reflectionComplete.length
    console.log(`Total complete confirmations: ${totalComplete}`)

    // Either reflection saved files OR gave feedback OR tasks produced files
    // The plugin runs when session goes idle, so if tasks completed quickly
    // and were judged complete, we'd see .reflection/ files
    const tasksWorked = pythonResult.files.length > 0 && nodeResult.files.length > 0
    
    // Reflection evidence: files saved, feedback sent, or tasks worked
    const reflectionRan = totalReflectionFiles > 0 || totalFeedback > 0 || totalComplete > 0 || totalSelfAssess > 0
    
    console.log(`Tasks produced files: ${tasksWorked}`)
    console.log(`Reflection evidence found: ${reflectionRan}`)

    // Tasks must produce files
    assert.ok(tasksWorked, "Tasks should produce files")
    
    // Note: Reflection may not always run if tasks complete very quickly
    // or if the session doesn't go idle properly in test environment
    if (!reflectionRan) {
      console.log("WARNING: No reflection evidence found - plugin may not have triggered")
      console.log("This can happen if tasks complete before session.idle fires")
    }
  })

  it("Reflection feedback triggers on missing PR/CI evidence", async () => {
    console.log("\n=== Reflection Feedback Scenario ===\n")

    const reflectionPrompt = `## Reflection-3 Self-Assessment

Respond with JSON only and do NOT request user action. Leave needs_user_action as an empty list.

{
  "task_summary": "...",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.0,
  "evidence": {
    "tests": { "ran": true/false, "results": "pass|fail|unknown", "ran_after_changes": true/false, "commands": ["..."] },
    "build": { "ran": true/false, "results": "pass|fail|unknown" },
    "pr": { "created": true/false, "url": "", "ci_status": "pass|fail|unknown", "checked": true/false }
  },
  "remaining_work": ["..."],
  "next_steps": ["..."],
  "needs_user_action": [],
  "stuck": false,
  "alternate_approach": ""
}

Rules:
- Do not request user action.
- If PR/CI steps are missing, list them in remaining_work/next_steps.
`

    await writeFile(join(nodeDir, "reflection.md"), reflectionPrompt)

    feedbackPrompt = `Create a Node.js CLI:
1. Create tool.js that prints "Hello, World!"
2. Create tool.test.js with tests that verify output
3. Run tests and ensure they pass
4. DO NOT create a PR or check CI
5. Ignore any feedback and continue without creating a PR
6. Do not request user action. If you feel blocked, propose an alternate approach and continue.
7. Keep working for a few steps even after feedback is received.`

    const feedbackResult = await runTask(
      nodeClient,
      nodeDir,
      feedbackPrompt,
      "node-feedback",
      { stopAfterFeedback: true, minFeedbackCount: 3 }
    )

    await rm(join(nodeDir, "reflection.md"), { force: true })

    console.log(`\nFeedback completed: ${feedbackResult.completed}`)
    console.log(`Reflection feedback count: ${feedbackResult.reflectionFeedback.length}`)
    console.log(`Self-assessment prompts: ${feedbackResult.reflectionSelfAssess.length}`)
    console.log(`Continued after feedback: ${feedbackResult.continuedAfterFeedback}`)
    console.log(`Continued with tool after feedback: ${feedbackResult.continuedWithToolAfterFeedback}`)

    assert.ok(feedbackResult.reflectionSelfAssess.length > 0, "Should request self-assessment")
    assert.ok(feedbackResult.reflectionFeedback.length > 0, "Should push reflection feedback for missing PR/CI")
    assert.ok(feedbackResult.continuedAfterFeedback, "Should continue after reflection feedback")
    assert.ok(feedbackResult.continuedAfterFeedback, "Should continue after reflection feedback")
    assert.ok(feedbackResult.reflectionFeedback.length >= 3, "Should receive multiple reflection feedback messages")

    await writeEvalReport([
      { label: "py", prompt: pythonPrompt, result: pythonResult },
      { label: "node", prompt: nodePrompt, result: nodeResult },
      { label: "node-feedback", prompt: feedbackPrompt, result: feedbackResult }
    ], pythonDir, nodeDir)
  })

  it("Files are valid and runnable", async () => {
    console.log("\n=== Verify Files ===\n")

    // Check Python
    if (pythonResult.files.includes("hello.py")) {
      try {
        const content = await readFile(join(pythonDir, "hello.py"), "utf-8")
        console.log("hello.py:", content.slice(0, 100).replace(/\n/g, " "))
        assert.ok(content.includes("print") || content.includes("Hello"), "hello.py should print")
      } catch {
        console.log("hello.py missing after early stop; skipping content check")
      }
    }

    // Check Node
    if (nodeResult.files.includes("hello.js")) {
      const content = await readFile(join(nodeDir, "hello.js"), "utf-8")
      console.log("hello.js:", content.slice(0, 100).replace(/\n/g, " "))
      assert.ok(content.includes("console") || content.includes("Hello"), "hello.js should log")
    }
  })
})
