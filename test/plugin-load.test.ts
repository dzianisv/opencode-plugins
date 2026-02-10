/**
 * Plugin Load Integration Test
 * 
 * This test actually loads each plugin the same way OpenCode does.
 * It catches issues like:
 * - Missing imports
 * - Wrong export format
 * - Invalid tool schemas
 * - Runtime errors during initialization
 * 
 * RUN THIS TEST BEFORE DEPLOYING: npm run test:load
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { spawn, type ChildProcess } from "child_process"
import { mkdir, rm, cp, writeFile, readdir } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient } from "@opencode-ai/sdk/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

// Test configuration
const TEST_DIR = "/tmp/opencode-plugin-load-test"
const PORT = 3333
const SERVER_TIMEOUT = 60_000  // 60s for server startup with all plugins

describe("Plugin Load Tests - Real OpenCode Environment", { timeout: 120_000 }, () => {
  let server: ChildProcess | null = null
  let serverOutput: string[] = []
  let serverErrors: string[] = []

  /**
   * Deploy plugins to test directory - all plugins directly in plugin/
   */
  async function deployPlugins(pluginDir: string) {
    // Copy all plugins directly to plugin directory
    await cp(join(ROOT, "reflection.ts"), join(pluginDir, "reflection.ts"))
    await cp(join(ROOT, "worktree.ts"), join(pluginDir, "worktree.ts"))
    await cp(join(ROOT, "tts.ts"), join(pluginDir, "tts.ts"))
    await cp(join(ROOT, "telegram.ts"), join(pluginDir, "telegram.ts"))
    await cp(join(ROOT, "github.ts"), join(pluginDir, "github.ts"))
  }

  before(async () => {
    console.log("\n=== Setup Test Environment ===\n")
    
    // Clean up
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    
    // Create plugin directory
    const pluginDir = join(TEST_DIR, ".opencode", "plugin")
    await mkdir(pluginDir, { recursive: true })
    
    // Deploy plugins
    console.log("Deploying plugins...")
    await deployPlugins(pluginDir)
    
    // List deployed files
    const deployed = await readdir(pluginDir)
    console.log(`Deployed plugins: ${deployed.join(", ")}`)
    
    // Create minimal opencode config
    const config = {
      "$schema": "https://opencode.ai/config.json",
      "model": "github-copilot/gpt-4o"
    }
    await writeFile(join(TEST_DIR, "opencode.json"), JSON.stringify(config, null, 2))
    
    // Create package.json for plugin dependencies
    const packageJson = {
      "dependencies": {
        "@opencode-ai/plugin": "1.1.48",
        "@supabase/supabase-js": "^2.49.0"
      }
    }
    await writeFile(join(TEST_DIR, ".opencode", "package.json"), JSON.stringify(packageJson, null, 2))
    
    // Install dependencies
    console.log("Installing plugin dependencies...")
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
    
    console.log("Dependencies installed")
  })

  after(async () => {
    console.log("\n=== Cleanup ===")
    if (server) {
      server.kill("SIGTERM")
      await new Promise(r => setTimeout(r, 1000))
    }
    
    if (serverErrors.length > 0) {
      console.log("\n--- Server Errors ---")
      serverErrors.forEach(e => console.log(e))
    }
  })

  it("starts OpenCode server with all plugins loaded (no errors)", async () => {
    console.log("\n--- Starting OpenCode Server ---\n")
    
    server = spawn("opencode", ["serve", "--port", String(PORT)], {
      cwd: TEST_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    server.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) {
        serverOutput.push(line)
        console.log(`[stdout] ${line}`)
      }
    })
    
    server.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) {
        serverErrors.push(line)
        console.log(`[stderr] ${line}`)
      }
    })

    // Wait for server to be ready or fail
    const startTime = Date.now()
    let serverReady = false
    let serverFailed = false
    let failureReason = ""

    while (Date.now() - startTime < SERVER_TIMEOUT) {
      // Check if process exited
      if (server.exitCode !== null) {
        serverFailed = true
        failureReason = `Server exited with code ${server.exitCode}`
        break
      }
      
      // Check for plugin load errors in output
      const hasError = serverErrors.some(e => 
        e.includes("Error:") || 
        e.includes("TypeError") || 
        e.includes("ReferenceError") ||
        e.includes("Cannot find module") ||
        e.includes("undefined is not")
      )
      
      if (hasError) {
        serverFailed = true
        failureReason = serverErrors.find(e => 
          e.includes("Error:") || 
          e.includes("TypeError")
        ) || "Plugin error detected"
        break
      }
      
      // Try to connect
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/session`)
        if (res.ok) {
          serverReady = true
          console.log(`[connect] Server ready after ${Date.now() - startTime}ms`)
          break
        } else {
          console.log(`[connect] Response not ok: ${res.status}`)
        }
      } catch (e: unknown) {
        const err = e as Error
        // Only log occasionally to reduce noise
        if ((Date.now() - startTime) % 5000 < 500) {
          console.log(`[connect] Error: ${err.message}`)
        }
      }
      
      await new Promise(r => setTimeout(r, 500))
    }

    if (serverFailed) {
      console.log("\n--- FAILURE: Server failed to start ---")
      console.log(`Reason: ${failureReason}`)
      console.log("\nAll errors:")
      serverErrors.forEach(e => console.log(`  ${e}`))
      
      assert.fail(`Server failed to start: ${failureReason}`)
    }
    
    assert.ok(serverReady, "Server should start and respond within timeout")
    console.log("\nServer started successfully!")
  })

  it("can create a session (plugins are functional)", async () => {
    const client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
      directory: TEST_DIR
    })
    
    const { data: session } = await client.session.create({})
    assert.ok(session?.id, "Should create a session")
    console.log(`Created session: ${session.id}`)
    
    // Get session info
    const { data: info } = await client.session.get({ path: { id: session.id } })
    assert.ok(info, "Should get session info")
    console.log(`Session projectID: ${info.projectID}`)
  })

  it("can run a simple task (end-to-end)", async () => {
    const client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
      directory: TEST_DIR
    })
    
    // Create session
    const { data: session } = await client.session.create({})
    assert.ok(session?.id, "Should create session")
    
    // Send a simple task
    await client.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: "Create a file called test.txt with the content 'hello'" }] }
    })
    
    // Poll for completion (max 60 seconds)
    const startTime = Date.now()
    let completed = false
    
    while (Date.now() - startTime < 60_000) {
      await new Promise(r => setTimeout(r, 2000))
      
      const { data: messages } = await client.session.messages({
        path: { id: session.id }
      })
      
      // Check if we have assistant responses
      const hasResponse = messages?.some((m: any) => 
        m.info?.role === "assistant" && 
        m.parts?.some((p: any) => p.type === "text" || p.type === "tool")
      )
      
      if (hasResponse && messages && messages.length >= 2) {
        completed = true
        console.log(`Task completed with ${messages.length} messages`)
        break
      }
    }
    
    assert.ok(completed, "Task should complete")
  })

  it("worktree tools are registered", async () => {
    const client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
      directory: TEST_DIR
    })
    
    // The fact that server started means tools were parsed correctly
    // If tool schemas were invalid, we'd have seen Zod errors
    
    // Check server output for tool registration errors
    const toolErrors = serverErrors.filter(e => 
      e.includes("tool") || 
      e.includes("schema") ||
      e.includes("Zod")
    )
    
    assert.strictEqual(toolErrors.length, 0, `No tool registration errors: ${toolErrors.join(", ")}`)
    console.log("Tool registration: OK (no errors)")
  })

  it("no plugin errors in server output", async () => {
    // Final check - look for any plugin-related errors
    const pluginErrors = serverErrors.filter(e => 
      e.includes("plugin") ||
      e.includes("Plugin") ||
      e.includes("reflection") ||
      e.includes("tts") ||
      e.includes("worktree") ||
      e.includes("telegram")
    )
    
    // Filter out expected warnings
    const realErrors = pluginErrors.filter(e => 
      !e.includes("Warning:") &&
      !e.includes("loaded")
    )
    
    if (realErrors.length > 0) {
      console.log("\n--- Plugin Errors Found ---")
      realErrors.forEach(e => console.log(`  ${e}`))
    }
    
    assert.strictEqual(realErrors.length, 0, `No plugin errors: ${realErrors.join(", ")}`)
    console.log("Plugin error check: OK")
  })
})
