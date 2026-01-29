#!/usr/bin/env npx tsx
/**
 * Reflection Layer End-to-End Evaluator
 * 
 * Runs real agent tasks, captures reflection feedback, evaluates quality.
 * Outputs results to eval-${timestamp}-${commit}.md
 * 
 * Usage:
 *   npx tsx eval.ts
 *   npm run eval:e2e
 */

import { mkdir, rm, cp, readdir, readFile, writeFile } from "fs/promises"
import { spawn, execSync, type ChildProcess } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_PATH = join(__dirname, "reflection.ts")

// Config
const MODEL = process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"
const PORT = 7654
const TIMEOUT = 300_000        // 5 minutes max per task
const POLL_INTERVAL = 3_000    // Check every 3 seconds
const STABLE_POLLS_REQUIRED = 5  // Need 5 stable polls (15s of no new messages)

// Test cases for evaluation
interface TestCase {
  id: string
  task: string
  expectedComplete: boolean
  description: string
}

const TEST_CASES: TestCase[] = [
  {
    id: "simple-file",
    task: "Create a hello.js file that prints 'Hello World'",
    expectedComplete: true,
    description: "Simple file creation"
  },
  {
    id: "research",
    task: "What are the top 3 Node.js testing frameworks? Just list them, don't install anything.",
    expectedComplete: true,
    description: "Research task (no code)"
  },
  // Real-world scenarios from production sessions
  {
    id: "multi-step-test",
    task: "Create a utils.ts file with an add function, write a test for it, and run the test to verify it works",
    expectedComplete: true,
    description: "Multi-step task with test verification"
  },
  {
    id: "commit-without-test",
    task: "Create a simple greeter.ts file with a greet function, then run npm run typecheck to verify it compiles correctly.",
    expectedComplete: true,
    description: "Create file with type verification"
  },
  {
    id: "fix-and-verify",
    task: "Create a file called calc.ts with a divide function that returns a/b. The function has a bug - it doesn't handle division by zero. Fix the bug by adding a check, then verify the fix works.",
    expectedComplete: true,
    description: "Bug fix with verification (self-contained)"
  },
  {
    id: "refactor-task",
    task: "Create a file counter.ts with a Counter class that has increment() and getCount() methods. Make sure the code follows TypeScript best practices.",
    expectedComplete: true,
    description: "Code creation with quality requirements"
  }
]

// Full test suite - uncomment for comprehensive evaluation
// const FULL_TEST_CASES: TestCase[] = [
//   ...TEST_CASES,
//   {
//     id: "syntax-error",
//     task: "Create a file broken.js with invalid JavaScript syntax: function( {",
//     expectedComplete: true,
//     description: "Create file with intentional syntax error"
//   },
//   {
//     id: "multi-step",
//     task: "Create a utils.ts file with an add function, then create a test file that imports and tests it",
//     expectedComplete: true,
//     description: "Multi-step task with dependencies"
//   },
//   {
//     id: "bug-fix",
//     task: "Create a file divide.js with a divide function, but it has a bug: it doesn't handle division by zero. Then fix the bug.",
//     expectedComplete: true,
//     description: "Bug fix task"
//   }
// ]

interface EvalResult {
  testCase: TestCase
  taskInput: string
  agentOutput: string
  reflectionInput: string
  reflectionOutput: string
  evaluationScore: number
  evaluationFeedback: string
  passed: boolean
  durationMs: number
}

async function getCommitId(): Promise<string> {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}

async function setupProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pluginDir = join(dir, ".opencode", "plugin")
  await mkdir(pluginDir, { recursive: true })
  await cp(PLUGIN_PATH, join(pluginDir, "reflection.ts"))
  
  const config = {
    "$schema": "https://opencode.ai/config.json",
    "model": MODEL
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

async function runTask(
  client: OpencodeClient,
  testCase: TestCase
): Promise<EvalResult> {
  const start = Date.now()
  const result: EvalResult = {
    testCase,
    taskInput: testCase.task,
    agentOutput: "",
    reflectionInput: "",
    reflectionOutput: "",
    evaluationScore: 0,
    evaluationFeedback: "",
    passed: false,
    durationMs: 0
  }

  try {
    // Create session
    const { data: session } = await client.session.create({})
    if (!session?.id) throw new Error("Failed to create session")
    console.log(`[${testCase.id}] Session: ${session.id}`)

    // Send task
    await client.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: testCase.task }] }
    })

    // Poll until stable - must wait for assistant to have parts
    let lastMsgCount = 0
    let lastAssistantParts = 0
    let stableCount = 0

    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      const { data: messages } = await client.session.messages({
        path: { id: session.id }
      })

      const msgCount = messages?.length || 0
      
      // Count parts in the last assistant message
      const assistantMsgs = (messages || []).filter((m: any) => m.info?.role === "assistant")
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
      const assistantParts = lastAssistant?.parts?.length || 0
      
      console.log(`[${testCase.id}] Polling: ${msgCount} messages, assistant parts=${assistantParts}, stable=${stableCount}`)
      
      // Only consider stable if:
      // 1. We have at least 2 messages (user + assistant)
      // 2. The assistant message has at least 1 part
      // 3. Both message count AND part count are stable
      const isStable = msgCount === lastMsgCount && 
                       assistantParts === lastAssistantParts && 
                       msgCount >= 2 && 
                       assistantParts > 0
      
      if (isStable) {
        stableCount++
        if (stableCount >= STABLE_POLLS_REQUIRED) break
      } else {
        stableCount = 0
        lastMsgCount = msgCount
        lastAssistantParts = assistantParts
      }
    }

    // Extract results
    const { data: messages } = await client.session.messages({
      path: { id: session.id }
    })

    console.log(`[${testCase.id}] Messages count: ${messages?.length || 0}`)

    if (messages && messages.length > 0) {
      // Debug: show all message roles
      console.log(`[${testCase.id}] Message roles:`, messages.map((m: any) => m.info?.role))
      
      if (process.env.REFLECTION_DEBUG) {
        // Show all messages for debugging
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]
          console.log(`[${testCase.id}] Message ${i}: role=${m.info?.role}, parts=${m.parts?.length}`)
          if (m.parts && m.parts.length > 0) {
            const textParts = m.parts.filter((p: any) => p.type === "text")
            if (textParts.length > 0) {
              console.log(`[${testCase.id}] Message ${i} text preview:`, (textParts[0] as any).text?.slice(0, 100))
            }
          }
        }
      }

      // SDK returns Array<{ info: Message; parts: Array<Part> }>
      // Agent output = last assistant message
      const assistantMsgs = messages.filter((m: any) => m.info?.role === "assistant")
      if (assistantMsgs.length > 0) {
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
        result.agentOutput = extractTextContent(lastAssistant)
        console.log(`[${testCase.id}] Agent output length: ${result.agentOutput.length}`)
      }

      // Reflection messages (from reflection plugin feedback)
      const reflectionMsgs = messages.filter((m: any) => 
        m.info?.role === "user" && 
        extractTextContent(m).includes("Reflection")
      )
      
      if (reflectionMsgs.length > 0) {
        result.reflectionOutput = extractTextContent(reflectionMsgs[reflectionMsgs.length - 1])
      }

      // Build reflection input (what was sent to judge)
      result.reflectionInput = `Task: ${testCase.task}\nAgent Output: ${result.agentOutput.slice(0, 500)}...`
    }

    // Evaluate the result using LLM-as-judge
    const evaluation = await evaluateWithLLM(testCase.task, result.agentOutput, testCase.expectedComplete)
    result.evaluationScore = evaluation.score
    result.evaluationFeedback = evaluation.feedback
    result.passed = evaluation.score >= 3

  } catch (error: any) {
    result.evaluationFeedback = `Error: ${error.message}`
    result.evaluationScore = 0
  }

  result.durationMs = Date.now() - start
  return result
}

function extractTextContent(message: any): string {
  // SDK returns { info: Message, parts: Array<Part> }
  // parts are at the same level as info, not inside it
  const parts = message?.parts
  if (!parts || !Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text || "")
    .join("\n")
    .slice(0, 2000)
}

/**
 * LLM-as-Judge evaluation using GitHub Models API
 * Evaluates agent output against the task requirements
 */
async function evaluateWithLLM(
  task: string, 
  agentOutput: string,
  expectedComplete: boolean
): Promise<{ score: number; feedback: string }> {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN
  if (!GITHUB_TOKEN) {
    console.warn("[WARN] GITHUB_TOKEN not set, falling back to heuristic evaluation")
    return evaluateHeuristic(agentOutput, expectedComplete)
  }

  const evalPrompt = `You are an evaluation judge for AI coding agents.

## Task Given to Agent
${task}

## Agent's Response
${agentOutput.slice(0, 3000)}

## Expected Outcome
The task ${expectedComplete ? "should be completed successfully" : "may have intentional issues"}.

## Evaluation Criteria
1. **Task Completion** (0-2 points): Did the agent complete what was asked?
2. **Correctness** (0-2 points): Is the output correct and functional?
3. **Quality** (0-1 point): Code quality, explanations, best practices

## Instructions
Evaluate the agent's response. Be strict but fair.

Reply with JSON only:
{
  "score": <0-5>,
  "feedback": "<2-3 sentence evaluation explaining the score>"
}`

  try {
    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: evalPrompt }],
        temperature: 0.1,
        max_tokens: 500
      })
    })

    if (!response.ok) {
      console.warn(`[WARN] LLM eval failed: ${response.status}, falling back to heuristic`)
      return evaluateHeuristic(agentOutput, expectedComplete)
    }

    const data = await response.json() as any
    const content = data.choices?.[0]?.message?.content || ""
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn("[WARN] Could not parse LLM eval response, falling back to heuristic")
      return evaluateHeuristic(agentOutput, expectedComplete)
    }

    const verdict = JSON.parse(jsonMatch[0])
    return {
      score: Math.max(0, Math.min(5, verdict.score || 0)),
      feedback: verdict.feedback || "No feedback provided"
    }
  } catch (error: any) {
    console.warn(`[WARN] LLM eval error: ${error.message}, falling back to heuristic`)
    return evaluateHeuristic(agentOutput, expectedComplete)
  }
}

/**
 * Fallback heuristic evaluation when LLM is unavailable
 */
function evaluateHeuristic(agentOutput: string, expectedComplete: boolean): { score: number; feedback: string } {
  let score = 0
  const feedback: string[] = []

  if (agentOutput.length > 50) {
    score += 2
    feedback.push("Agent produced meaningful output")
  } else {
    feedback.push("Agent output too short or missing")
  }

  const completionIndicators = ["created", "done", "completed", "finished", "added", "wrote"]
  if (completionIndicators.some(ind => agentOutput.toLowerCase().includes(ind))) {
    score += 2
    feedback.push("Found completion indicators")
  }

  const errorIndicators = ["error", "failed", "exception", "cannot"]
  if (errorIndicators.some(ind => agentOutput.toLowerCase().includes(ind)) && expectedComplete) {
    score -= 1
    feedback.push("Found error indicators")
  }

  return {
    score: Math.max(0, Math.min(5, score)),
    feedback: `[Heuristic] ${feedback.join("; ")}`
  }
}

function scoreToVerdict(score: number): string {
  if (score === 5) return "COMPLETE"
  if (score === 4) return "MOSTLY_COMPLETE"
  if (score === 3) return "PARTIAL"
  if (score === 2) return "ATTEMPTED"
  if (score === 1) return "FAILED"
  return "NO_ATTEMPT"
}

async function generateReport(results: EvalResult[], commitId: string): Promise<string> {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)  // 2026-01-29
  const time = now.toISOString().slice(11, 16).replace(":", "-")  // 07-41
  const filename = `eval-report-${date}-${time}-${commitId}.md`
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const avgScore = (results.reduce((a, r) => a + r.evaluationScore, 0) / results.length).toFixed(1)
  
  let md = `# Agent Evaluation Report

**Date**: ${new Date().toISOString()}  
**Commit**: ${commitId}  
**Model**: ${MODEL}  
**Evaluator**: LLM-as-Judge (gpt-4o-mini)

---

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | ${results.length} |
| Passed (≥3) | ${passed} |
| Failed (<3) | ${failed} |
| Pass Rate | ${Math.round(passed / results.length * 100)}% |
| Avg Score | ${avgScore}/5 |

---

## Results

| Input | Output | Eval LLM Feedback | Score |
|-------|--------|-------------------|-------|
`

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const input = r.taskInput.slice(0, 60).replace(/\|/g, "\\|").replace(/\n/g, " ")
    const output = r.agentOutput.slice(0, 80).replace(/\|/g, "\\|").replace(/\n/g, " ") || "(no output)"
    const feedback = r.evaluationFeedback.slice(0, 100).replace(/\|/g, "\\|").replace(/\n/g, " ")
    const icon = r.passed ? "✅" : "❌"
    md += `| ${input}... | ${output}... | ${feedback}... | ${icon} ${r.evaluationScore}/5 |\n`
  }

  md += `\n---\n\n## Full Details\n`

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const verdict = scoreToVerdict(r.evaluationScore)
    const icon = r.passed ? "✅" : "❌"
    
    md += `
### Test ${i + 1}: ${r.testCase.description}

**Score**: ${icon} ${r.evaluationScore}/5 (${verdict})  
**Duration**: ${r.durationMs}ms

#### Task Input
\`\`\`
${r.taskInput}
\`\`\`

#### Agent Output
\`\`\`
${r.agentOutput.slice(0, 1500) || "(no output)"}${r.agentOutput.length > 1500 ? "\n... (truncated)" : ""}
\`\`\`

#### Eval LLM Feedback
> ${r.evaluationFeedback}

${r.reflectionOutput ? `#### Reflection Plugin Output\n\`\`\`\n${r.reflectionOutput.slice(0, 500)}\n\`\`\`\n` : ""}
---
`
  }

  md += `
## Scoring Rubric

| Score | Verdict | Criteria |
|-------|---------|----------|
| 5 | COMPLETE | Task fully accomplished, all requirements met |
| 4 | MOSTLY_COMPLETE | Task done with minor issues |
| 3 | PARTIAL | Core objective achieved but gaps remain |
| 2 | ATTEMPTED | Progress made but failed to complete |
| 1 | FAILED | Wrong approach or incorrect result |
| 0 | NO_ATTEMPT | No meaningful progress |

**Pass threshold**: Score ≥ 3
`

  const outputPath = join(__dirname, "evals", "results", filename)
  await mkdir(join(__dirname, "evals", "results"), { recursive: true })
  await writeFile(outputPath, md)
  console.log(`\nReport written to: ${outputPath}`)
  
  return md
}

async function main() {
  const commitId = await getCommitId()
  console.log(`Reflection Layer E2E Evaluation`)
  console.log(`Commit: ${commitId}`)
  console.log(`Model: ${MODEL}`)
  console.log(`Tests: ${TEST_CASES.length}`)
  console.log("")

  // Setup temp project
  const tmpDir = join(__dirname, ".eval-tmp")
  await rm(tmpDir, { recursive: true, force: true })
  await setupProject(tmpDir)

  // Start opencode serve
  console.log("Starting opencode serve...")
  const server = spawn("opencode", ["serve", "--port", String(PORT)], {
    cwd: tmpDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, REFLECTION_DEBUG: "1" }
  })

  let serverOutput = ""
  server.stdout?.on("data", (d) => serverOutput += d.toString())
  server.stderr?.on("data", (d) => serverOutput += d.toString())

  try {
    const ready = await waitForServer(PORT, 30_000)
    if (!ready) {
      console.error("Server failed to start")
      console.error(serverOutput)
      process.exit(1)
    }
    console.log("Server ready\n")

    const client = createOpencodeClient({ baseUrl: `http://localhost:${PORT}` })
    const results: EvalResult[] = []

    // Run each test case
    for (const testCase of TEST_CASES) {
      console.log(`Running: ${testCase.id} - ${testCase.description}`)
      const result = await runTask(client, testCase)
      results.push(result)
      console.log(`  Score: ${result.evaluationScore}/5 (${scoreToVerdict(result.evaluationScore)})`)
      console.log(`  Duration: ${result.durationMs}ms`)
      console.log("")
    }

    // Generate report
    const report = await generateReport(results, commitId)
    console.log("\n" + "=".repeat(80))
    console.log(report)

  } finally {
    server.kill()
    await rm(tmpDir, { recursive: true, force: true })
  }
}

main().catch(console.error)
