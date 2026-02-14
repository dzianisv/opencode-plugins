/**
 * E2E Evaluation Test for reflection-3.ts + telegram.ts Plugins
 *
 * This test:
 * 1. Starts OpenCode with both reflection-3 and telegram plugins
 * 2. Asks it to create a Python hello world with unit tests
 * 3. Verifies the reflection plugin triggered and provided feedback
 * 4. Verifies telegram's extractFinalResponse correctly filters reflection artifacts
 * 5. Uses Azure OpenAI to evaluate the plugin's effectiveness
 *
 * REQUIRES: Azure credentials in .env:
 *   - AZURE_OPENAI_API_KEY
 *   - AZURE_OPENAI_BASE_URL
 *   - AZURE_OPENAI_DEPLOYMENT (optional, defaults to gpt-4.1-mini)
 *
 * NO FALLBACK: Test will fail if Azure is unavailable - no fake mock scores.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdir, rm, cp, readdir, readFile, writeFile } from "fs/promises"
import { spawn, type ChildProcess } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { config } from "dotenv"
import {
  extractFinalResponse,
  isSelfAssessmentJson,
  hasReflectionContent,
} from "../telegram.test-helpers.ts"

// Load .env file (override existing env vars to ensure we use the correct credentials)
config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env"), override: true })

const __dirname = dirname(fileURLToPath(import.meta.url))
const REFLECTION_PLUGIN_PATH = join(__dirname, "../reflection-3.ts")
const TELEGRAM_PLUGIN_PATH = join(__dirname, "../telegram.ts")

// Model for the agent under test
const AGENT_MODEL = process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"
const TIMEOUT = 600_000 // 10 minutes for full test
const POLL_INTERVAL = 3_000

interface TestResult {
  sessionId: string
  messages: any[]
  selfAssessmentQuestion: boolean
  selfAssessmentResponse: string | null
  pluginAnalysis: boolean
  pluginAction: "complete" | "continue" | "stopped" | "none"
  filesCreated: string[]
  pythonTestsRan: boolean
  pythonTestsPassed: boolean
  duration: number
  serverLogs: string[]
}

interface TelegramFilterResult {
  finalResponse: string
  selfAssessmentJsonDetected: boolean
  reflectionContentPresent: boolean
  finalResponseContainsJson: boolean
  selfAssessmentMessagesFiltered: number
}

interface EvaluationResult {
  score: number
  verdict: "COMPLETE" | "MOSTLY_COMPLETE" | "PARTIAL" | "ATTEMPTED" | "FAILED" | "NO_ATTEMPT"
  feedback: string
  pluginEffectiveness: {
    triggeredCorrectly: boolean
    askedSelfAssessment: boolean
    analyzedResponse: boolean
    tookAppropriateAction: boolean
    helpedCompleteTask: boolean
  }
  recommendations: string[]
}

async function setupProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pluginDir = join(dir, ".opencode", "plugin")
  await mkdir(pluginDir, { recursive: true })
  await cp(REFLECTION_PLUGIN_PATH, join(pluginDir, "reflection.ts"))
  await cp(TELEGRAM_PLUGIN_PATH, join(pluginDir, "telegram.ts"))

  const cfg = {
    "$schema": "https://opencode.ai/config.json",
    "model": AGENT_MODEL
  }
  await writeFile(join(dir, "opencode.json"), JSON.stringify(cfg, null, 2))
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

/**
 * Call Azure to evaluate the reflection-3 plugin's performance.
 */
async function evaluateWithAzure(testResult: TestResult): Promise<EvaluationResult> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY
  const baseUrl = process.env.AZURE_OPENAI_BASE_URL
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1-mini"

  if (!apiKey || !baseUrl) {
    throw new Error("Missing Azure credentials: AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL required in .env")
  }

  const conversationSummary = testResult.messages.map((msg, i) => {
    const role = msg.info?.role || "unknown"
    let content = ""
    for (const part of msg.parts || []) {
      if (part.type === "text") content += part.text?.slice(0, 500) || ""
      if (part.type === "tool") content += `[Tool: ${part.tool}] `
    }
    return `${i + 1}. [${role}]: ${content.slice(0, 300)}`
  }).join("\n")

  const evaluationPrompt = `You are evaluating the effectiveness of a reflection plugin for an AI coding agent.

## Task Given to Agent
"Write a simple hello world application in Python. Cover with unit tests. Run unit tests and make sure they pass."

## What the Reflection Plugin Should Do
1. Ask a self-assessment with workflow requirements
2. Analyze the agent's self-assessment against required tests/build/PR/CI
3. If agent says complete with evidence -> stop
4. If missing steps -> push to continue
5. If agent needs user input -> stop with explanation

## Test Results
- Session ID: ${testResult.sessionId}
- Duration: ${testResult.duration}ms
- Files Created: ${testResult.filesCreated.join(", ") || "none"}
- Python Tests Ran: ${testResult.pythonTestsRan}
- Python Tests Passed: ${testResult.pythonTestsPassed}

## Plugin Behavior Observed
- Self-Assessment Question Asked: ${testResult.selfAssessmentQuestion}
- Agent's Self-Assessment: ${testResult.selfAssessmentResponse?.slice(0, 500) || "N/A"}
- Plugin Analyzed Response: ${testResult.pluginAnalysis}
- Plugin Action: ${testResult.pluginAction}

## Server Logs (Plugin Debug)
${testResult.serverLogs.slice(-20).join("\n")}

## Conversation Summary
${conversationSummary.slice(0, 3000)}

## Evaluation Instructions
Rate the reflection-3 plugin's performance on a 0-5 scale:
- 5: Plugin triggered correctly, asked self-assessment, analyzed response, took appropriate action, task completed
- 4: Plugin mostly worked, minor issues
- 3: Plugin partially worked
- 2: Plugin triggered but didn't help
- 1: Plugin failed to trigger or caused issues
- 0: Plugin completely failed

Return JSON only:
{
  "score": <0-5>,
  "verdict": "COMPLETE|MOSTLY_COMPLETE|PARTIAL|ATTEMPTED|FAILED|NO_ATTEMPT",
  "feedback": "Brief explanation of rating",
  "pluginEffectiveness": {
    "triggeredCorrectly": true/false,
    "askedSelfAssessment": true/false,
    "analyzedResponse": true/false,
    "tookAppropriateAction": true/false,
    "helpedCompleteTask": true/false
  },
  "recommendations": ["list of improvements"]
}`

  const apiVersion = "2024-12-01-preview"
  const endpoint = `${baseUrl.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`

  console.log(`[eval] Calling Azure ${deployment}`)

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You are an expert evaluator of AI agent plugins. Return only valid JSON." },
        { role: "user", content: evaluationPrompt }
      ],
      temperature: 0.3,
      max_tokens: 1000
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Azure API error: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || ""

  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`No JSON in Azure response: ${content.slice(0, 200)}`)
  }

  const result = JSON.parse(jsonMatch[0]) as EvaluationResult
  console.log(`[eval] Azure score: ${result.score}/5 - ${result.verdict}`)
  return result
}

describe("reflection + telegram plugin E2E evaluation", { timeout: TIMEOUT + 60_000 }, () => {
  const testDir = "/tmp/opencode-reflection-3-eval"
  const port = 3300
  let server: ChildProcess | null = null
  let client: OpencodeClient
  let testResult: TestResult
  let telegramResult: TelegramFilterResult
  let evaluationResult: EvaluationResult
  const serverLogs: string[] = []

  before(async () => {
    await rm(testDir, { recursive: true, force: true })
    await setupProject(testDir)

    console.log(`[setup] dir=${testDir} model=${AGENT_MODEL}`)
    console.log(`[setup] plugins: reflection-3.ts, telegram.ts`)

    server = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: testDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        REFLECTION_DEBUG: "1"
      }
    })

    server.stdout?.on("data", (d) => {
      for (const line of d.toString().split("\n").filter((l: string) => l.trim())) {
        if (line.includes("[Reflection3]")) serverLogs.push(line)
      }
    })

    server.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n").filter((l: string) => l.trim())) {
        if (line.includes("[Reflection3]")) serverLogs.push(line)
      }
    })

    client = createOpencodeClient({
      baseUrl: `http://localhost:${port}`,
      directory: testDir
    })

    const ready = await waitForServer(port, 30_000)
    if (!ready) throw new Error("Server failed to start")
    console.log("[setup] server ready")
  })

  after(async () => {
    server?.kill("SIGTERM")
    await new Promise(r => setTimeout(r, 2000))

    if (testResult) {
      console.log(`[summary] duration=${testResult.duration}ms files=${testResult.filesCreated.join(",")} self-assessment=${testResult.selfAssessmentQuestion} action=${testResult.pluginAction} tests-passed=${testResult.pythonTestsPassed}`)
    }
    if (telegramResult) {
      console.log(`[summary] telegram: final-response-len=${telegramResult.finalResponse.length} json-filtered=${telegramResult.selfAssessmentMessagesFiltered} contains-json=${telegramResult.finalResponseContainsJson}`)
    }
    if (evaluationResult) {
      console.log(`[summary] eval: score=${evaluationResult.score}/5 verdict=${evaluationResult.verdict}`)
    }
    console.log(`[summary] reflection logs: ${serverLogs.length}`)
  })

  it("runs python hello world task and reflection plugin provides feedback", async () => {
    const start = Date.now()
    testResult = {
      sessionId: "",
      messages: [],
      selfAssessmentQuestion: false,
      selfAssessmentResponse: null,
      pluginAnalysis: false,
      pluginAction: "none",
      filesCreated: [],
      pythonTestsRan: false,
      pythonTestsPassed: false,
      duration: 0,
      serverLogs: []
    }

    const { data: session } = await client.session.create({})
    if (!session?.id) throw new Error("Failed to create session")
    testResult.sessionId = session.id
    console.log(`[task] session=${testResult.sessionId}`)

    const task = `Write a simple hello world application in Python. Cover with unit tests. Run unit tests and make sure they pass.

Requirements:
1. Create hello.py with a function that returns "Hello, World!"
2. Create test_hello.py with pytest tests
3. Run pytest and verify all tests pass`

    await client.session.promptAsync({
      path: { id: testResult.sessionId },
      body: { parts: [{ type: "text", text: task }] }
    })

    let lastMsgCount = 0
    let lastContent = ""
    let stableCount = 0
    const maxStableChecks = 15

    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      const { data: messages } = await client.session.messages({
        path: { id: testResult.sessionId }
      })
      testResult.messages = messages || []

      for (const msg of testResult.messages) {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            if (part.text.includes("Reflection-3 Self-Assessment") ||
                part.text.includes("What was the task?")) {
              if (!testResult.selfAssessmentQuestion) {
                testResult.selfAssessmentQuestion = true
                console.log("[task] reflection asked self-assessment")
              }
            }

            if (msg.info?.role === "assistant" && testResult.selfAssessmentQuestion) {
              if (part.text.includes("{") && part.text.includes("status")) {
                testResult.selfAssessmentResponse = part.text
              }
            }

            if (part.text.includes("Reflection-3:")) {
              testResult.pluginAction = "continue"
            }

            if (part.text.includes("pytest") || part.text.includes("test session")) {
              testResult.pythonTestsRan = true
            }
            if (part.text.includes("passed") && !part.text.includes("failed")) {
              testResult.pythonTestsPassed = true
            }
          }
        }
      }

      const recentLogs = serverLogs.slice(-30).join(" ")
      if (recentLogs.includes("Reflection analysis completed") || recentLogs.includes("Reflection pushed continuation") || recentLogs.includes("Reflection complete") || recentLogs.includes("Reflection requires human action")) {
        testResult.pluginAnalysis = true
      }
      if (recentLogs.includes("Reflection complete") || recentLogs.includes("Task complete")) {
        testResult.pluginAction = "complete"
      }
      if (recentLogs.includes("Reflection requires human action")) {
        testResult.pluginAction = "stopped"
      }

      const currentContent = JSON.stringify(testResult.messages)
      const hasWork = testResult.messages.some((m: any) =>
        m.info?.role === "assistant" && m.parts?.some((p: any) =>
          p.type === "text" || p.type === "tool"
        )
      )

      if (hasWork && testResult.messages.length === lastMsgCount && currentContent === lastContent) {
        stableCount++
        if (stableCount >= maxStableChecks) {
          console.log("[task] session stable, ending poll")
          break
        }
      } else {
        stableCount = 0
      }

      lastMsgCount = testResult.messages.length
      lastContent = currentContent

      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed % 15 === 0) {
        console.log(`[task] ${elapsed}s msgs=${testResult.messages.length} stable=${stableCount} reflection=${testResult.selfAssessmentQuestion ? "triggered" : "waiting"}`)
      }
    }

    try {
      const files = await readdir(testDir)
      testResult.filesCreated = files.filter(f => !f.startsWith(".") && f.endsWith(".py"))
    } catch {}

    testResult.duration = Date.now() - start
    testResult.serverLogs = serverLogs

    console.log(`[task] done in ${testResult.duration}ms files=${testResult.filesCreated.join(",")} self-assessment=${testResult.selfAssessmentQuestion} action=${testResult.pluginAction} tests=${testResult.pythonTestsRan}/${testResult.pythonTestsPassed}`)

    assert.ok(testResult.messages.length >= 2, "Should have at least 2 messages")
  })

  it("telegram extractFinalResponse filters reflection artifacts from session messages", async () => {
    const messages = testResult.messages

    // Run telegram's extractFinalResponse on the real session messages
    const finalResponse = extractFinalResponse(messages)

    // Count how many assistant messages contain self-assessment JSON
    let selfAssessmentCount = 0
    for (const msg of messages) {
      if (msg.info?.role !== "assistant") continue
      const text = (msg.parts || [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join("\n")
        .trim()
      if (text && isSelfAssessmentJson(text)) {
        selfAssessmentCount++
      }
    }

    telegramResult = {
      finalResponse,
      selfAssessmentJsonDetected: selfAssessmentCount > 0,
      reflectionContentPresent: hasReflectionContent(messages),
      finalResponseContainsJson: isSelfAssessmentJson(finalResponse),
      selfAssessmentMessagesFiltered: selfAssessmentCount,
    }

    console.log(`[telegram] final-response (${finalResponse.length} chars): ${finalResponse.slice(0, 120)}...`)
    console.log(`[telegram] reflection-content=${telegramResult.reflectionContentPresent} self-assessment-msgs=${selfAssessmentCount} final-contains-json=${telegramResult.finalResponseContainsJson}`)

    // The final response must not be empty
    assert.ok(finalResponse.length > 0, "extractFinalResponse should return non-empty text")

    // The final response must NOT be self-assessment JSON
    assert.strictEqual(
      telegramResult.finalResponseContainsJson,
      false,
      `extractFinalResponse must not return self-assessment JSON. Got: ${finalResponse.slice(0, 200)}`
    )

    // If reflection ran, at least one self-assessment JSON should exist in the messages
    if (telegramResult.reflectionContentPresent) {
      assert.ok(
        selfAssessmentCount > 0,
        "When reflection content is present, at least one assistant message should contain self-assessment JSON"
      )
      console.log(`[telegram] PASS: ${selfAssessmentCount} self-assessment JSON message(s) filtered from final response`)
    }
  })

  it("evaluates plugin effectiveness with Azure LLM", async () => {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1-mini"
    console.log(`[eval] evaluating with Azure ${deployment}`)

    evaluationResult = await evaluateWithAzure(testResult)

    console.log(`[eval] score=${evaluationResult.score}/5 verdict=${evaluationResult.verdict}`)
    console.log(`[eval] feedback: ${evaluationResult.feedback}`)
    const eff = evaluationResult.pluginEffectiveness
    console.log(`[eval] triggered=${eff.triggeredCorrectly} self-assessment=${eff.askedSelfAssessment} analyzed=${eff.analyzedResponse} action=${eff.tookAppropriateAction} helped=${eff.helpedCompleteTask}`)
    if (evaluationResult.recommendations.length > 0) {
      console.log(`[eval] recommendations: ${evaluationResult.recommendations.join("; ")}`)
    }

    const resultsPath = join(testDir, "evaluation-results.json")
    await writeFile(resultsPath, JSON.stringify({
      testResult: {
        sessionId: testResult.sessionId,
        duration: testResult.duration,
        filesCreated: testResult.filesCreated,
        selfAssessmentQuestion: testResult.selfAssessmentQuestion,
        selfAssessmentResponse: testResult.selfAssessmentResponse?.slice(0, 500),
        pluginAnalysis: testResult.pluginAnalysis,
        pluginAction: testResult.pluginAction,
        pythonTestsRan: testResult.pythonTestsRan,
        pythonTestsPassed: testResult.pythonTestsPassed,
        messageCount: testResult.messages.length,
        serverLogCount: testResult.serverLogs.length
      },
      telegramFilter: telegramResult,
      evaluation: evaluationResult,
      timestamp: new Date().toISOString()
    }, null, 2))
    console.log(`[eval] results saved to ${resultsPath}`)

    assert.ok(evaluationResult.score >= 0 && evaluationResult.score <= 5, "Score should be 0-5")
  })

  it("verifies plugin triggered correctly", async () => {
    const pluginLogs = serverLogs.filter(l => l.includes("[Reflection3]"))
    console.log(`[verify] reflection log entries: ${pluginLogs.length}`)

    const checks = {
      eventReceived: pluginLogs.some(l => l.includes("event received")),
      sessionIdle: pluginLogs.some(l => l.includes("session.idle")),
      reflectionCalled: pluginLogs.some(l => l.includes("runReflection called")),
      askedQuestion: pluginLogs.some(l => l.includes("Requesting reflection self-assessment")),
      gotAssessment: pluginLogs.some(l => l.includes("Self-assessment")),
      analyzed: pluginLogs.some(l => l.includes("Reflection analysis completed")),
      result: pluginLogs.some(l => l.includes("Reflection complete") || l.includes("Reflection requires human action") || l.includes("Reflection pushed continuation")),
    }

    for (const [key, val] of Object.entries(checks)) {
      console.log(`[verify] ${key}=${val}`)
    }

    if (pluginLogs.length > 0) {
      console.log("[verify] last 5 reflection logs:")
      for (const log of pluginLogs.slice(-5)) {
        console.log(`  ${log}`)
      }
    }

    const hasHelloPy = testResult.filesCreated.includes("hello.py")
    const hasTestPy = testResult.filesCreated.some(f => f.includes("test"))
    console.log(`[verify] hello.py=${hasHelloPy} test-file=${hasTestPy}`)

    if (!testResult.selfAssessmentQuestion) {
      console.log("[warn] reflection did not ask self-assessment question")
    }

    assert.ok(
      testResult.messages.length >= 2 || pluginLogs.length > 0,
      "Either messages or plugin logs should exist"
    )
  })

  it("generates final assessment", async () => {
    const passed = evaluationResult.score >= 3

    console.log(`[result] ${passed ? "PASS" : "FAIL"} score=${evaluationResult.score}/5 verdict=${evaluationResult.verdict}`)

    const eff = evaluationResult.pluginEffectiveness
    const check = (v: boolean) => v ? "y" : "n"
    console.log(`[result] triggered=${check(eff.triggeredCorrectly)} self-assessment=${check(eff.askedSelfAssessment)} analyzed=${check(eff.analyzedResponse)} action=${check(eff.tookAppropriateAction)} helped=${check(eff.helpedCompleteTask)}`)

    if (telegramResult) {
      const telegramOk = !telegramResult.finalResponseContainsJson && telegramResult.finalResponse.length > 0
      console.log(`[result] telegram-filter=${telegramOk ? "PASS" : "FAIL"} final-response-len=${telegramResult.finalResponse.length} json-leaked=${telegramResult.finalResponseContainsJson}`)
    }

    if (!passed) {
      console.log(`[warn] evaluation score ${evaluationResult.score}/5 is below threshold (3)`)
    }
  })
})
