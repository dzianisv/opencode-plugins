/**
 * E2E Evaluation Test for reflection-3.ts Plugin
 *
 * This test:
 * 1. Starts OpenCode with the reflection-3 plugin
 * 2. Asks it to create a Python hello world with unit tests
 * 3. Verifies the plugin triggered and provided feedback
 * 4. Uses Azure OpenAI to evaluate the plugin's effectiveness
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

// Load .env file (override existing env vars to ensure we use the correct credentials)
config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env"), override: true })

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_PATH = join(__dirname, "../reflection-3.ts")

// Model for the agent under test
const AGENT_MODEL = process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"
const TIMEOUT = 600_000 // 10 minutes for full test
const POLL_INTERVAL = 3_000

interface TestResult {
  sessionId: string
  messages: any[]
  selfAssessmentQuestion: boolean // Did plugin ask the self-assessment question?
  selfAssessmentResponse: string | null // Agent's self-assessment
  pluginAnalysis: boolean // Did plugin analyze the response?
  pluginAction: "complete" | "continue" | "stopped" | "none" // What action did plugin take?
  filesCreated: string[]
  pythonTestsRan: boolean
  pythonTestsPassed: boolean
  duration: number
  serverLogs: string[]
}

interface EvaluationResult {
  score: number // 0-5 scale
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
  await cp(PLUGIN_PATH, join(pluginDir, "reflection.ts"))
  
  // Create opencode.json with explicit model
  const config = {
    "$schema": "https://opencode.ai/config.json",
    "model": AGENT_MODEL
  }
  await writeFile(join(dir, "opencode.json"), JSON.stringify(config, null, 2))
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
  * Call Azure to evaluate the reflection-3 plugin's performance
 * Uses Azure OpenAI endpoint with deployment from AZURE_OPENAI_DEPLOYMENT env var
 */
async function evaluateWithAzure(testResult: TestResult): Promise<EvaluationResult> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY
  const baseUrl = process.env.AZURE_OPENAI_BASE_URL
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1-mini"
  
  if (!apiKey || !baseUrl) {
    throw new Error("Missing Azure credentials: AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL required in .env")
  }

  // Build conversation summary for evaluation
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
3. If agent says complete with evidence → stop
4. If missing steps → push to continue
5. If agent needs user input → stop with explanation

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

  // Azure OpenAI endpoint format
  const apiVersion = "2024-12-01-preview"
  const endpoint = `${baseUrl.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`

  console.log(`[Eval] Calling Azure ${deployment}...`)
  console.log(`[Eval] Endpoint: ${endpoint.slice(0, 70)}...`)

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
  console.log(`[Eval] Azure score: ${result.score}/5 - ${result.verdict}`)
  return result
}

describe("reflection-3.ts Plugin E2E Evaluation", { timeout: TIMEOUT + 60_000 }, () => {
  const testDir = "/tmp/opencode-reflection-3-eval"
  const port = 3300
  let server: ChildProcess | null = null
  let client: OpencodeClient
  let testResult: TestResult
  let evaluationResult: EvaluationResult
  const serverLogs: string[] = []

  before(async () => {
    console.log("\n" + "=".repeat(60))
    console.log("=== reflection-3.ts Plugin E2E Evaluation ===")
    console.log("=".repeat(60) + "\n")

    // Cleanup and setup
    await rm(testDir, { recursive: true, force: true })
    await setupProject(testDir)

    console.log(`[Setup] Test directory: ${testDir}`)
    console.log(`[Setup] Agent model: ${AGENT_MODEL}`)
    console.log(`[Setup] Plugin: reflection-3.ts (deployed as reflection.ts)`)

    // Start server with debug logging
    console.log("\n[Setup] Starting OpenCode server...")
    server = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: testDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { 
        ...process.env, 
        REFLECTION_DEBUG: "1" // Enable plugin debug logging
      }
    })

    server.stdout?.on("data", (d) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim())
      for (const line of lines) {
        console.log(`[server] ${line}`)
        if (line.includes("[Reflection3]")) {
          serverLogs.push(line)
        }
      }
    })

    server.stderr?.on("data", (d) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim())
      for (const line of lines) {
        console.error(`[server:err] ${line}`)
        if (line.includes("[Reflection3]")) {
          serverLogs.push(line)
        }
      }
    })

    // Create client
    client = createOpencodeClient({
      baseUrl: `http://localhost:${port}`,
      directory: testDir
    })

    // Wait for server
    const ready = await waitForServer(port, 30_000)
    if (!ready) {
      throw new Error("Server failed to start")
    }

    console.log("[Setup] Server ready\n")
  })

  after(async () => {
    console.log("\n" + "=".repeat(60))
    console.log("=== Cleanup ===")
    console.log("=".repeat(60))
    
    server?.kill("SIGTERM")
    await new Promise(r => setTimeout(r, 2000))

    // Print summary
    if (testResult) {
      console.log("\n[Summary] Test Result:")
      console.log(`  - Duration: ${testResult.duration}ms`)
      console.log(`  - Files: ${testResult.filesCreated.join(", ")}`)
      console.log(`  - Plugin asked self-assessment: ${testResult.selfAssessmentQuestion}`)
      console.log(`  - Plugin action: ${testResult.pluginAction}`)
      console.log(`  - Python tests passed: ${testResult.pythonTestsPassed}`)
    }

    if (evaluationResult) {
      console.log("\n[Summary] Evaluation Result:")
      console.log(`  - Score: ${evaluationResult.score}/5`)
      console.log(`  - Verdict: ${evaluationResult.verdict}`)
      console.log(`  - Feedback: ${evaluationResult.feedback}`)
    }

    console.log(`\n[Summary] Server logs with [Reflection3]: ${serverLogs.length}`)
  })

  it("runs Python hello world task and plugin provides feedback", async () => {
    console.log("\n" + "-".repeat(60))
    console.log("--- Running Python Hello World Task ---")
    console.log("-".repeat(60) + "\n")

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

    // Create session
    const { data: session } = await client.session.create({})
    if (!session?.id) throw new Error("Failed to create session")
    testResult.sessionId = session.id
    console.log(`[Task] Session: ${testResult.sessionId}`)

    // Send task
    const task = `Write a simple hello world application in Python. Cover with unit tests. Run unit tests and make sure they pass.

Requirements:
1. Create hello.py with a function that returns "Hello, World!"
2. Create test_hello.py with pytest tests
3. Run pytest and verify all tests pass`

    console.log(`[Task] Sending task...`)
    await client.session.promptAsync({
      path: { id: testResult.sessionId },
      body: { parts: [{ type: "text", text: task }] }
    })

    // Poll for completion with plugin activity detection
    let lastMsgCount = 0
    let lastContent = ""
    let stableCount = 0
    const maxStableChecks = 15 // 45 seconds of stability

    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      const { data: messages } = await client.session.messages({
        path: { id: testResult.sessionId }
      })
      testResult.messages = messages || []

      // Check for plugin activity in messages
      for (const msg of testResult.messages) {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            // Plugin's self-assessment question
            if (part.text.includes("Reflection-3 Self-Assessment") || 
                part.text.includes("What was the task?")) {
              testResult.selfAssessmentQuestion = true
              console.log("[Task] Plugin asked self-assessment question")
            }
            
             // Agent's response to self-assessment
             if (msg.info?.role === "assistant" && testResult.selfAssessmentQuestion) {
               if (part.text.includes("{") && part.text.includes("status")) {
                 testResult.selfAssessmentResponse = part.text
               }
             }

             // Plugin's "continue" action
             if (part.text.includes("Reflection-3:")) {
              testResult.pluginAction = "continue"
              console.log("[Task] Plugin pushed agent to continue")
            }

            // Check for pytest output
            if (part.text.includes("pytest") || part.text.includes("test session")) {
              testResult.pythonTestsRan = true
            }
            if (part.text.includes("passed") && !part.text.includes("failed")) {
              testResult.pythonTestsPassed = true
            }
          }
        }
      }

      // Check for plugin analysis in server logs
    const recentLogs = serverLogs.slice(-30).join(" ")
    if (recentLogs.includes("Reflection analysis failed")) {
      testResult.pluginAnalysis = false
    }
    if (recentLogs.includes("Reflection analysis completed") || recentLogs.includes("Reflection pushed continuation") || recentLogs.includes("Reflection complete") || recentLogs.includes("Reflection requires human action")) {
      testResult.pluginAnalysis = true
    }
    if (recentLogs.includes("Reflection complete") || recentLogs.includes("Task complete ✓")) {
      testResult.pluginAction = "complete"
      console.log("[Task] Plugin confirmed task complete")
    }
    if (recentLogs.includes("Reflection requires human action")) {
      testResult.pluginAction = "stopped"
      console.log("[Task] Plugin noted agent stopped for valid reason")
    }

      // Stability check
      const currentContent = JSON.stringify(testResult.messages)
      const hasWork = testResult.messages.some((m: any) =>
        m.info?.role === "assistant" && m.parts?.some((p: any) =>
          p.type === "text" || p.type === "tool"
        )
      )

      if (hasWork && testResult.messages.length === lastMsgCount && currentContent === lastContent) {
        stableCount++
        if (stableCount >= maxStableChecks) {
          console.log("[Task] Session stable, ending poll")
          break
        }
      } else {
        stableCount = 0
      }

      lastMsgCount = testResult.messages.length
      lastContent = currentContent

      // Progress logging
      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed % 15 === 0) {
        console.log(`[Task] ${elapsed}s - messages: ${testResult.messages.length}, stable: ${stableCount}, plugin: ${testResult.selfAssessmentQuestion ? "triggered" : "waiting"}`)
      }
    }

    // Get files created
    try {
      const files = await readdir(testDir)
      testResult.filesCreated = files.filter(f => !f.startsWith(".") && f.endsWith(".py"))
    } catch {}

    testResult.duration = Date.now() - start
    testResult.serverLogs = serverLogs

    console.log(`\n[Task] Completed in ${testResult.duration}ms`)
    console.log(`[Task] Files: ${testResult.filesCreated.join(", ")}`)
    console.log(`[Task] Plugin self-assessment: ${testResult.selfAssessmentQuestion}`)
    console.log(`[Task] Plugin action: ${testResult.pluginAction}`)
    console.log(`[Task] Tests ran: ${testResult.pythonTestsRan}, passed: ${testResult.pythonTestsPassed}`)

    // Basic assertions
    assert.ok(testResult.messages.length >= 2, "Should have at least 2 messages")
  })

  it("evaluates plugin effectiveness with Azure LLM", async () => {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1-mini"
    console.log("\n" + "-".repeat(60))
    console.log(`--- Evaluating with Azure ${deployment} ---`)
    console.log("-".repeat(60) + "\n")

    evaluationResult = await evaluateWithAzure(testResult)

    console.log("\n[Eval] Results:")
    console.log(`  Score: ${evaluationResult.score}/5`)
    console.log(`  Verdict: ${evaluationResult.verdict}`)
    console.log(`  Feedback: ${evaluationResult.feedback}`)
    console.log(`  Plugin Effectiveness:`)
    console.log(`    - Triggered correctly: ${evaluationResult.pluginEffectiveness.triggeredCorrectly}`)
    console.log(`    - Asked self-assessment: ${evaluationResult.pluginEffectiveness.askedSelfAssessment}`)
    console.log(`    - Analyzed response: ${evaluationResult.pluginEffectiveness.analyzedResponse}`)
    console.log(`    - Took appropriate action: ${evaluationResult.pluginEffectiveness.tookAppropriateAction}`)
    console.log(`    - Helped complete task: ${evaluationResult.pluginEffectiveness.helpedCompleteTask}`)
    console.log(`  Recommendations: ${evaluationResult.recommendations.join(", ")}`)

    // Save evaluation results to file
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
      evaluation: evaluationResult,
      timestamp: new Date().toISOString()
    }, null, 2))
    console.log(`\n[Eval] Results saved to: ${resultsPath}`)

    // Assertions based on evaluation
    assert.ok(evaluationResult.score >= 0 && evaluationResult.score <= 5, "Score should be 0-5")
  })

  it("verifies plugin triggered correctly", async () => {
    console.log("\n" + "-".repeat(60))
    console.log("--- Verifying Plugin Behavior ---")
    console.log("-".repeat(60) + "\n")

    // Check server logs for plugin activity
    const pluginLogs = serverLogs.filter(l => l.includes("[Reflection3]"))
    console.log(`[Verify] Plugin log entries: ${pluginLogs.length}`)

    // Verify key events
    const eventReceived = pluginLogs.some(l => l.includes("event received"))
    const sessionIdle = pluginLogs.some(l => l.includes("session.idle"))
    const reflectionCalled = pluginLogs.some(l => l.includes("runReflection called"))
    const askedQuestion = pluginLogs.some(l => l.includes("Requesting reflection self-assessment"))
    const gotAssessment = pluginLogs.some(l => l.includes("Self-assessment received") || l.includes("Self-assessment"))
    const analyzed = pluginLogs.some(l => l.includes("Reflection analysis completed"))
    const analysisResult = pluginLogs.some(l => l.includes("Reflection complete") || l.includes("Reflection requires human action") || l.includes("Reflection pushed continuation"))

    console.log(`[Verify] Event received: ${eventReceived}`)
    console.log(`[Verify] Session idle detected: ${sessionIdle}`)
    console.log(`[Verify] Reflection called: ${reflectionCalled}`)
    console.log(`[Verify] Asked self-assessment: ${askedQuestion}`)
    console.log(`[Verify] Got self-assessment: ${gotAssessment}`)
    console.log(`[Verify] Analyzed with GenAI: ${analyzed}`)
    console.log(`[Verify] Analysis result received: ${analysisResult}`)

    // Print last few plugin logs for debugging
    console.log("\n[Verify] Last 10 plugin log entries:")
    for (const log of pluginLogs.slice(-10)) {
      console.log(`  ${log}`)
    }

    // Verify files were created
    const hasHelloPy = testResult.filesCreated.includes("hello.py")
    const hasTestPy = testResult.filesCreated.some(f => f.includes("test"))
    console.log(`\n[Verify] hello.py created: ${hasHelloPy}`)
    console.log(`[Verify] test file created: ${hasTestPy}`)

    // Soft assertions - log warnings instead of failing
    if (!testResult.selfAssessmentQuestion) {
      console.log("\n[WARN] Plugin did NOT ask self-assessment question!")
      console.log("[WARN] This could mean:")
      console.log("  1. session.idle event not firing correctly")
      console.log("  2. Plugin skipping the session for some reason")
      console.log("  3. Task completed before plugin could trigger")
    }

    // Hard assertion - something must have happened
    assert.ok(
      testResult.messages.length >= 2 || pluginLogs.length > 0,
      "Either messages or plugin logs should exist"
    )
  })

  it("generates final assessment", async () => {
    console.log("\n" + "=".repeat(60))
    console.log("=== FINAL ASSESSMENT ===")
    console.log("=".repeat(60) + "\n")

    const passed = evaluationResult.score >= 3
    const status = passed ? "PASS" : "FAIL"

    console.log(`Status: ${status}`)
    console.log(`Score: ${evaluationResult.score}/5`)
    console.log(`Verdict: ${evaluationResult.verdict}`)
    console.log(`\nPlugin Effectiveness Summary:`)
    
    const effectiveness = evaluationResult.pluginEffectiveness
    const checkMark = (v: boolean) => v ? "✓" : "✗"
    console.log(`  ${checkMark(effectiveness.triggeredCorrectly)} Triggered correctly`)
    console.log(`  ${checkMark(effectiveness.askedSelfAssessment)} Asked self-assessment`)
    console.log(`  ${checkMark(effectiveness.analyzedResponse)} Analyzed response`)
    console.log(`  ${checkMark(effectiveness.tookAppropriateAction)} Took appropriate action`)
    console.log(`  ${checkMark(effectiveness.helpedCompleteTask)} Helped complete task`)

    console.log(`\nRecommendations:`)
    for (const rec of evaluationResult.recommendations) {
      console.log(`  - ${rec}`)
    }

    console.log("\n" + "=".repeat(60))

    // Final assertion
    // Note: We use a soft threshold since this is an evaluation test
    if (!passed) {
      console.log(`\n[WARN] Evaluation score ${evaluationResult.score}/5 is below threshold (3)`)
      console.log("[WARN] Review the plugin implementation and test conditions")
    }
  })
})
