import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { spawn, spawnSync } from "child_process";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

// Configuration for worktree plugin
interface WorktreeConfig {
  serverUrl?: string;  // Default: auto-detect or http://localhost:4096
  serverPassword?: string;  // For authenticated servers
  serverPort?: number;  // Port for auto-started server (default: 4096)
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "worktree.json");
const SERVER_PID_PATH = join(homedir(), ".config", "opencode", "worktree-server.pid");
const DEFAULT_PORT = 4096;

function loadConfig(): WorktreeConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Try to detect the server URL from environment or config
function getServerUrl(config: WorktreeConfig): string {
  // Priority: config > env > default
  if (config.serverUrl) return config.serverUrl;
  if (process.env.OPENCODE_SERVER_URL) return process.env.OPENCODE_SERVER_URL;
  
  const port = config.serverPort || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

// Check if the server is running by hitting its health endpoint
async function isServerRunning(serverUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(`${serverUrl}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    return response.ok;
  } catch {
    return false;
  }
}

// Start opencode serve in the background
async function startServer(config: WorktreeConfig): Promise<{ url: string; started: boolean }> {
  const port = config.serverPort || DEFAULT_PORT;
  const serverUrl = `http://127.0.0.1:${port}`;
  
  // Check if already running
  if (await isServerRunning(serverUrl)) {
    return { url: serverUrl, started: false };
  }
  
  // Start the server in background
  const args = ["serve", "--port", String(port)];
  
  // Note: We don't set password here - user should set OPENCODE_SERVER_PASSWORD env var
  // or configure it in their shell profile for security
  
  const child = spawn("opencode", args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // Pass through password if configured
      ...(config.serverPassword ? { OPENCODE_SERVER_PASSWORD: config.serverPassword } : {})
    }
  });
  
  // Save PID for potential cleanup
  try {
    mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true });
    writeFileSync(SERVER_PID_PATH, String(child.pid));
  } catch {
    // Ignore PID save errors
  }
  
  // Detach from parent process
  child.unref();
  
  // Wait for server to be ready (up to 10 seconds)
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isServerRunning(serverUrl)) {
      return { url: serverUrl, started: true };
    }
  }
  
  throw new Error(`Server failed to start on port ${port} after 10 seconds`);
}

// Ensure server is running, starting it if necessary
async function ensureServer(config: WorktreeConfig): Promise<string> {
  const serverUrl = getServerUrl(config);
  
  if (await isServerRunning(serverUrl)) {
    return serverUrl;
  }
  
  // Server not running, start it
  const result = await startServer(config);
  return result.url;
}

export const WorktreePlugin: Plugin = async (ctx) => {
  const { directory, client } = ctx;
  const config = loadConfig();

  // Helper to execute git commands
  const git = async (args: string[], cwd = directory) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || "Git command failed");
    return result.stdout.trim();
  };

  // Helper to escape strings for shell
  const escapeShell = (s: string) => s.replace(/'/g, "'\\''");
  
  // Helper to escape strings for AppleScript
  const escapeAppleScript = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Launch a new terminal with opencode attach
  const launchTerminal = async (worktreePath: string, sessionId?: string): Promise<{ success: boolean; serverStarted?: boolean; error?: string }> => {
    if (process.platform !== "darwin") {
      return { success: false, error: `Auto-launch not supported on ${process.platform}` };
    }

    // Ensure server is running (starts it if needed)
    let serverUrl: string;
    let serverStarted = false;
    try {
      const wasRunning = await isServerRunning(getServerUrl(config));
      serverUrl = await ensureServer(config);
      serverStarted = !wasRunning;
    } catch (e: any) {
      return { success: false, error: `Failed to start server: ${e.message}` };
    }

    const shellPath = escapeShell(worktreePath);
    
    // Build the opencode attach command
    let shellCmd = `cd '${shellPath}' && opencode attach '${serverUrl}' --dir '${shellPath}'`;
    
    if (sessionId) {
      shellCmd += ` --session '${escapeShell(sessionId)}'`;
    }
    
    if (config.serverPassword) {
      shellCmd += ` --password '${escapeShell(config.serverPassword)}'`;
    }

    const appleScriptCmd = escapeAppleScript(shellCmd);

    const script = `
      tell application "Terminal"
        do script "${appleScriptCmd}"
        activate
      end tell
    `;
    
    const result = spawnSync("osascript", [], { input: script, encoding: "utf-8" });
    return { success: result.status === 0, serverStarted };
  };

  return {
    tool: {
      worktree_create: tool({
        description: `Create a new git worktree for a feature branch. Opens a new terminal with OpenCode attached to the server, allowing persistent multi-session development.

The new terminal will:
1. Connect to the existing OpenCode server (shared sessions)
2. Create a new session for the worktree directory
3. Optionally start with an initial task

This enables parallel development on multiple branches with separate TUI windows, all managed by a single server.`,
        args: {
          branch: tool.schema.string().describe("Name of the new feature branch (e.g. 'feat/new-ui')"),
          base: tool.schema.string().optional().describe("Base branch to start from (default: 'main' or 'master')"),
          task: tool.schema.string().optional().describe("Initial task/prompt for the agent in the new window")
        },
        async execute(args) {
          const { branch, task } = args;
          let base = args.base;
          
          // Auto-detect default branch
          if (!base) {
            try {
              const branches = await git(["branch", "-r"]);
              base = branches.includes("origin/main") ? "main" : "master";
            } catch {
              base = "main";
            }
          }

          // Determine sibling path (worktrees go next to the main repo)
          const parentDir = resolve(directory, "..");
          const worktreePath = join(parentDir, branch.replace(/\//g, "-"));
          
          if (existsSync(worktreePath)) {
            return `Worktree directory already exists at ${worktreePath}. Use worktree_list to see existing worktrees.`;
          }

          try {
            // 1. Create the git worktree
            await git(["worktree", "add", "-b", branch, worktreePath, base]);
            
            // 2. Create a new session for this worktree directory
            let sessionId: string | undefined;
            try {
              const { data: session } = await client.session.create({
                body: { directory: worktreePath } as any
              });
              sessionId = session?.id;
              
              // 3. If task provided, send it to the session
              if (sessionId && task) {
                await client.session.promptAsync({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: task }] }
                });
              }
            } catch (e: any) {
              // Session creation failed - might not be running as server
              // Still create worktree, just won't have pre-created session
              console.error(`[Worktree] Could not create session: ${e.message}`);
            }
            
            // 4. Launch terminal with opencode attach (macOS only)
            if (process.platform === "darwin") {
              const result = await launchTerminal(worktreePath, sessionId);
              
              if (result.success) {
                let msg = `Created worktree at ${worktreePath} on branch '${branch}' (from ${base}).`;
                if (result.serverStarted) {
                  msg += `\n\nStarted OpenCode server automatically.`;
                }
                msg += `\nLaunched OpenCode TUI attached to server.`;
                if (sessionId) {
                  msg += `\nSession ID: ${sessionId}`;
                }
                if (task) {
                  msg += `\nInitial task: "${task}"`;
                }
                return msg;
              } else {
                return `Created worktree at ${worktreePath} but failed to launch terminal: ${result.error}\n\nRun manually:\ncd '${worktreePath}' && opencode`;
              }
            } else {
              return `Created worktree at ${worktreePath}. Auto-launch not supported on ${process.platform}.\n\nRun manually:\ncd '${worktreePath}' && opencode`;
            }
          } catch (e: any) {
            return `Failed to create worktree: ${e.message}`;
          }
        }
      }),

      worktree_list: tool({
        description: "List all active git worktrees with their branches and paths.",
        args: {},
        async execute() {
          try {
            const output = await git(["worktree", "list", "--porcelain"]);
            
            // Parse porcelain output into structured data
            const worktrees: Array<{path: string, branch: string, head: string}> = [];
            let current: any = {};
            
            for (const line of output.split("\n")) {
              if (line.startsWith("worktree ")) {
                if (current.path) worktrees.push(current);
                current = { path: line.replace("worktree ", "") };
              } else if (line.startsWith("HEAD ")) {
                current.head = line.replace("HEAD ", "").slice(0, 8);
              } else if (line.startsWith("branch ")) {
                current.branch = line.replace("branch refs/heads/", "");
              }
            }
            if (current.path) worktrees.push(current);
            
            if (worktrees.length === 0) {
              return "No worktrees found.";
            }
            
            // Format output
            let result = "Active worktrees:\n\n";
            for (const wt of worktrees) {
              result += `  ${wt.path}\n`;
              result += `    Branch: ${wt.branch || "(detached)"}\n`;
              result += `    HEAD: ${wt.head}\n\n`;
            }
            
            return result;
          } catch (e: any) {
            return `Error listing worktrees: ${e.message}`;
          }
        }
      }),

      worktree_delete: tool({
        description: "Delete a worktree and optionally its branch. Warns if there are uncommitted changes.",
        args: {
          path: tool.schema.string().describe("Path to the worktree to remove"),
          force: tool.schema.boolean().optional().describe("Force remove even with uncommitted changes"),
          deleteBranch: tool.schema.boolean().optional().describe("Also delete the associated branch")
        },
        async execute(args) {
          const { path, force, deleteBranch } = args;
          
          try {
            // Check for uncommitted changes first
            if (!force) {
              try {
                const status = spawnSync("git", ["status", "--porcelain"], { 
                  cwd: path, 
                  encoding: "utf-8" 
                });
                if (status.stdout && status.stdout.trim().length > 0) {
                  return `Worktree at ${path} has uncommitted changes. Use force=true to remove anyway, or commit/stash changes first.\n\nChanges:\n${status.stdout}`;
                }
              } catch {
                // Can't check status, proceed with caution
              }
            }
            
            // Get branch name before removing (for optional branch deletion)
            let branchName: string | undefined;
            if (deleteBranch) {
              try {
                const result = spawnSync("git", ["branch", "--show-current"], {
                  cwd: path,
                  encoding: "utf-8"
                });
                branchName = result.stdout?.trim();
              } catch {
                // Can't get branch name
              }
            }
            
            // Remove the worktree
            const gitArgs = ["worktree", "remove", path];
            if (force) gitArgs.push("--force");
            
            await git(gitArgs);
            
            let result = `Removed worktree at ${path}`;
            
            // Optionally delete the branch
            if (deleteBranch && branchName) {
              try {
                await git(["branch", "-d", branchName]);
                result += `\nDeleted branch '${branchName}'`;
              } catch (e: any) {
                result += `\nNote: Could not delete branch '${branchName}': ${e.message}`;
                result += `\nYou may need to use: git branch -D ${branchName}`;
              }
            }
            
            return result;
          } catch (e: any) {
            return `Failed to remove worktree: ${e.message}`;
          }
        }
      }),

      worktree_status: tool({
        description: "Get detailed status of a worktree including uncommitted changes, branch info, and active sessions.",
        args: {
          path: tool.schema.string().optional().describe("Path to worktree (default: current directory)")
        },
        async execute(args) {
          const targetPath = args.path || directory;
          
          try {
            const status = spawnSync("git", ["status", "--porcelain"], {
              cwd: targetPath,
              encoding: "utf-8"
            });
            
            const branch = spawnSync("git", ["branch", "--show-current"], {
              cwd: targetPath,
              encoding: "utf-8"
            });
            
            const ahead = spawnSync("git", ["rev-list", "--count", "@{u}..HEAD"], {
              cwd: targetPath,
              encoding: "utf-8"
            });
            
            const behind = spawnSync("git", ["rev-list", "--count", "HEAD..@{u}"], {
              cwd: targetPath,
              encoding: "utf-8"
            });
            
            // Get sessions for this directory
            let sessionCount = 0;
            try {
              const sessions = await client.session.list({});
              sessionCount = (sessions.data || []).filter(
                (s: any) => s.directory === targetPath
              ).length;
            } catch {
              // Session listing failed
            }
            
            const changes = status.stdout?.trim() || "";
            const result = {
              path: targetPath,
              branch: branch.stdout?.trim() || "(detached)",
              dirty: changes.length > 0,
              uncommittedFiles: changes ? changes.split("\n").length : 0,
              aheadOfRemote: parseInt(ahead.stdout?.trim() || "0", 10),
              behindRemote: parseInt(behind.stdout?.trim() || "0", 10),
              activeSessions: sessionCount
            };
            
            // Format as readable output
            let output = `Worktree Status: ${result.path}\n`;
            output += `─────────────────────────────────────\n`;
            output += `Branch: ${result.branch}\n`;
            output += `Status: ${result.dirty ? `${result.uncommittedFiles} uncommitted file(s)` : "Clean"}\n`;
            
            if (result.aheadOfRemote > 0 || result.behindRemote > 0) {
              output += `Remote: `;
              if (result.aheadOfRemote > 0) output += `${result.aheadOfRemote} ahead `;
              if (result.behindRemote > 0) output += `${result.behindRemote} behind`;
              output += `\n`;
            }
            
            output += `Sessions: ${result.activeSessions} active\n`;
            
            if (changes) {
              output += `\nChanges:\n${changes}`;
            }
            
            return output;
          } catch (e: any) {
            return `Error getting status: ${e.message}`;
          }
        }
      }),

      worktree_attach: tool({
        description: "Open a new terminal attached to an existing worktree. Useful for resuming work on a worktree.",
        args: {
          path: tool.schema.string().describe("Path to the worktree"),
          session: tool.schema.string().optional().describe("Session ID to resume (optional)")
        },
        async execute(args) {
          const { path, session } = args;
          
          if (!existsSync(path)) {
            return `Worktree path does not exist: ${path}`;
          }
          
          if (process.platform !== "darwin") {
            return `Auto-launch not supported on ${process.platform}. Run manually:\ncd '${path}' && opencode`;
          }
          
          const result = await launchTerminal(path, session);
          
          if (result.success) {
            let msg = `Launched OpenCode TUI for worktree at ${path}`;
            if (session) {
              msg += ` (session: ${session})`;
            }
            if (result.serverStarted) {
              msg += `\nStarted OpenCode server automatically.`;
            }
            return msg;
          } else {
            return `Failed to launch terminal: ${result.error}\n\nRun manually:\ncd '${path}' && opencode`;
          }
        }
      })
    }
  };
};

export default WorktreePlugin;
