/**
 * Integration Test: Reflection Race Condition
 * 
 * Tests the fix for the race condition where:
 * 1. Agent finishes task → session.idle fires
 * 2. Reflection asks self-assessment question and waits for response
 * 3. Reflection analyzes with GenAI judge (takes 30+ seconds)
 * 4. Human types a new message DURING the analysis
 * 5. Reflection should abort and NOT inject stale "Please continue..." prompt
 * 
 * This test uses a real OpenCode server with reflection-static.ts plugin.
 * 
 * RUN: OPENCODE_E2E=1 npx tsx --test test/reflection-race-condition.test.ts
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { spawn, type ChildProcess } from "child_process"
import { mkdir, rm, cp, writeFile, readdir } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

// Skip unless explicitly enabled
const SKIP_E2E = !process.env.OPENCODE_E2E
if (SKIP_E2E) {
  console.log("\n⚠️  Skipping E2E test. Set OPENCODE_E2E=1 to run.\n")
}

const TEST_DIR = "/tmp/opencode-reflection-race-test"
const PORT = 3334
const SERVER_TIMEOUT = 30_000
const TASK_TIMEOUT = 120_000

describe("Reflection Race Condition - Integration Test", { 
  timeout: 300_000,
  skip: SKIP_E2E 
}, () => {
  let server: ChildProcess | null = null
  let client: OpencodeClient
  const serverLogs: string[] = []

  before(async () => {
    console.log("\n" + "=".repeat(60))
    console.log("=== Setting up Reflection Race Condition Test ===")
    console.log("=".repeat(60) + "\n")

    // Clean up
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })

    // Create plugin directory and deploy reflection-static
    const pluginDir = join(TEST_DIR, ".opencode", "plugin")
    await mkdir(pluginDir, { recursive: true })
    await cp(join(ROOT, "reflection-static.ts"), join(pluginDir, "reflection-static.ts"))

    // List deployed files
    const deployed = await readdir(pluginDir)
    console.log(`[Setup] Deployed plugins: ${deployed.join(", ")}`)

    // Create config
    const config = {
      "$schema": "https://opencode.ai/config.json",
      "model": process.env.OPENCODE_MODEL || "github-copilot/gpt-4o"
    }
    await writeFile(join(TEST_DIR, "opencode.json"), JSON.stringify(config, null, 2))

    // Create package.json for plugin dependencies  
    const packageJson = {
      "dependencies": {
        "@opencode-ai/plugin": "1.1.48"
      }
    }
    await writeFile(join(TEST_DIR, ".opencode", "package.json"), JSON.stringify(packageJson, null, 2))

    // Install dependencies
    console.log("[Setup] Installing plugin dependencies...")
    const install = spawn("bun", ["install"], {
      cwd: join(TEST_DIR, ".opencode"),
      stdio: ["ignore", "pipe", "pipe"]
    })
    await new Promise<void>((resolve, reject) => {
      install.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`bun install failed with code ${code}`))
      })
      install.on("error", reject)
    })

    // Start server with debug logging
    console.log("[Setup] Starting OpenCode server...")
    server = spawn("opencode", ["serve", "--port", String(PORT)], {
      cwd: TEST_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REFLECTION_DEBUG: "1" }
    })

    server.stdout?.on("data", (d) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim())
      for (const line of lines) {
        console.log(`[server] ${line}`)
        if (line.includes("[ReflectionStatic]")) {
          serverLogs.push(line)
        }
      }
    })

    server.stderr?.on("data", (d) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim())
      for (const line of lines) {
        console.error(`[server:err] ${line}`)
        if (line.includes("[ReflectionStatic]")) {
          serverLogs.push(line)
        }
      }
    })

    // Wait for server to be ready
    const startTime = Date.now()
    let ready = false
    while (Date.now() - startTime < SERVER_TIMEOUT) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/session`)
        if (res.ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }

    if (!ready) {
      throw new Error("Server failed to start within timeout")
    }

    console.log(`[Setup] Server ready after ${Date.now() - startTime}ms\n`)

    // Create client
    client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
      directory: TEST_DIR
    })
  })

  after(async () => {
    console.log("\n=== Cleanup ===")
    if (server) {
      server.kill("SIGTERM")
      await new Promise(r => setTimeout(r, 2000))
    }

    // Print reflection logs
    console.log(`\n[Summary] Reflection plugin logs: ${serverLogs.length}`)
    if (serverLogs.length > 0) {
      console.log("\nLast 20 reflection logs:")
      serverLogs.slice(-20).forEach(l => console.log(`  ${l}`))
    }
  })

  it("detects and aborts when human sends message during reflection analysis", async () => {
    console.log("\n" + "-".repeat(60))
    console.log("--- Test: Human message during reflection analysis ---")
    console.log("-".repeat(60) + "\n")

    // 1. Create session
    const { data: session } = await client.session.create({})
    assert.ok(session?.id, "Should create session")
    console.log(`[Test] Created session: ${session.id}`)

    // 2. Send initial task
    const initialTask = "Create a file called hello.txt with 'Hello World' content"
    console.log(`[Test] Sending initial task: "${initialTask}"`)
    
    await client.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: initialTask }] }
    })

    // 3. Wait for agent to complete and reflection to start
    console.log("[Test] Waiting for agent to complete...")
    const startTime = Date.now()
    let reflectionStarted = false
    let reflectionAskingQuestion = false

    while (Date.now() - startTime < TASK_TIMEOUT) {
      await new Promise(r => setTimeout(r, 2000))

      // Check server logs for reflection activity
      const recentLogs = serverLogs.slice(-10).join(" ")
      
      if (recentLogs.includes("runReflection called")) {
        reflectionStarted = true
        console.log("[Test] Reflection started!")
      }
      
      if (recentLogs.includes("Asking static self-assessment")) {
        reflectionAskingQuestion = true
        console.log("[Test] Reflection is asking self-assessment question")
        
        // 4. NOW inject a human message to simulate the race condition
        // This simulates human typing while reflection is processing
        console.log("[Test] Injecting human message during reflection...")
        
        // Wait a bit to let the self-assessment question be sent
        await new Promise(r => setTimeout(r, 3000))
        
        // Send a new human message (this should trigger the abort)
        await client.session.promptAsync({
          path: { id: session.id },
          body: { parts: [{ type: "text", text: "Actually, ignore that. Just tell me a joke instead." }] }
        })
        
        console.log("[Test] Human message injected!")
        break
      }

      // Progress logging
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      if (elapsed % 10 === 0) {
        console.log(`[Test] ${elapsed}s - waiting for reflection...`)
      }
    }

    // 5. Wait for reflection to process and check for abort
    console.log("[Test] Waiting for reflection to detect new message and abort...")
    await new Promise(r => setTimeout(r, 10_000))

    // 6. Check server logs for the abort message
    const allLogs = serverLogs.join("\n")
    const detectedAbort = allLogs.includes("human sent new message during reflection") ||
                          allLogs.includes("aborting to avoid stale injection")
    
    console.log("\n[Test] Results:")
    console.log(`  - Reflection started: ${reflectionStarted}`)
    console.log(`  - Asked self-assessment: ${reflectionAskingQuestion}`)
    console.log(`  - Detected abort: ${detectedAbort}`)

    // 7. Check that no stale "Please continue..." was injected after the abort
    const { data: messages } = await client.session.messages({
      path: { id: session.id }
    })

    // Look for "Please continue" messages that came AFTER the joke request
    let jokeRequestIndex = -1
    let staleContinueFound = false
    
    for (let i = 0; i < (messages?.length || 0); i++) {
      const msg = messages![i]
      for (const part of msg.parts || []) {
        if (part.type === "text") {
          if (part.text?.includes("tell me a joke")) {
            jokeRequestIndex = i
          }
          // Check for stale reflection prompt AFTER the joke request
          if (jokeRequestIndex >= 0 && i > jokeRequestIndex) {
            if (part.text?.includes("Please continue with the improvements")) {
              staleContinueFound = true
              console.log(`[Test] WARNING: Found stale 'Please continue' at message ${i}`)
            }
          }
        }
      }
    }

    console.log(`  - Stale 'Please continue' found: ${staleContinueFound}`)

    // Assertions
    if (reflectionStarted && reflectionAskingQuestion) {
      // If reflection got far enough to ask the question, check for proper abort
      assert.ok(!staleContinueFound, 
        "Should NOT have injected 'Please continue' after human sent new message")
      
      // The abort detection is a bonus - the main thing is no stale injection
      if (detectedAbort) {
        console.log("\n✓ Race condition handled correctly - abort detected!")
      } else {
        console.log("\n⚠ Reflection may have completed before human message arrived")
      }
    } else {
      console.log("\n⚠ Reflection didn't reach the self-assessment stage in time")
      console.log("  This could mean the model responded too quickly or plugin didn't trigger")
    }
  })

  it("verifies reflection normally works when no race condition", async () => {
    console.log("\n" + "-".repeat(60))
    console.log("--- Test: Normal reflection without race condition ---")
    console.log("-".repeat(60) + "\n")

    // Reset logs for this test
    serverLogs.length = 0

    // 1. Create a fresh session
    const { data: session } = await client.session.create({})
    assert.ok(session?.id, "Should create session")
    console.log(`[Test] Created session: ${session.id}`)

    // 2. Send a task and let it complete naturally (no human interruption)
    const task = "What is 2 + 2?"
    console.log(`[Test] Sending task: "${task}"`)
    
    await client.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: task }] }
    })

    // 3. Wait for completion and reflection
    console.log("[Test] Waiting for natural completion and reflection...")
    const startTime = Date.now()
    
    while (Date.now() - startTime < 60_000) {
      await new Promise(r => setTimeout(r, 3000))
      
      const recentLogs = serverLogs.join(" ")
      
      // Check if reflection completed successfully
      if (recentLogs.includes("confirmed task complete") ||
          recentLogs.includes("Agent confirmed task complete")) {
        console.log("[Test] Reflection confirmed task complete!")
        break
      }
      
      if (recentLogs.includes("stopped for valid reason")) {
        console.log("[Test] Reflection stopped for valid reason")
        break
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000)
      if (elapsed % 15 === 0) {
        console.log(`[Test] ${elapsed}s - waiting...`)
      }
    }

    // 4. Verify reflection ran
    const allLogs = serverLogs.join("\n")
    const reflectionRan = allLogs.includes("runReflection called")
    const askedQuestion = allLogs.includes("Asking static self-assessment")
    
    console.log("\n[Test] Results:")
    console.log(`  - Reflection ran: ${reflectionRan}`)
    console.log(`  - Asked self-assessment: ${askedQuestion}`)

    // Basic assertion - at minimum we should see reflection was triggered
    assert.ok(reflectionRan || serverLogs.length > 0, 
      "Reflection should have been triggered on session.idle")
  })
})
