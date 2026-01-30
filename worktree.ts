import type { Plugin } from "@opencode-ai/plugin";
import { spawnSync, exec } from "child_process";
import { promisify } from "util";
import { join, resolve, basename } from "path";
import { existsSync } from "fs";

const execAsync = promisify(exec);

export const WorktreePlugin: Plugin = async (ctx) => {
  const { directory, client } = ctx;

  // Helper to execute git commands
  const git = async (args: string[], cwd = directory) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || "Git command failed");
    return result.stdout.trim();
  };

  return {
    tool: {
        worktree_create: {
          name: "worktree_create",
          description: "Create a new git worktree for a feature branch and open it in a new terminal with OpenCode.",
          args: {
            branch: { 
              type: "string", 
              description: "Name of the new feature branch (e.g. 'feat/new-ui')" 
            },
            base: { 
              type: "string", 
              description: "Base branch to start from (default: 'main' or 'master')" 
            },
            task: {
              type: "string",
              description: "Initial task/prompt for the agent in the new window (optional)"
            }
          },
          async execute(args: { branch: string, base?: string, task?: string }) {
            const { branch, task } = args;
            let { base } = args;
          if (!base) {
            try {
              const branches = await git(["branch", "-r"]);
              base = branches.includes("origin/main") ? "main" : "master";
            } catch {
              base = "main";
            }
          }

          // 2. Determine sibling path
          // If we are in /repo/foo, new worktree is /repo/branch-name
          const parentDir = resolve(directory, "..");
          const worktreePath = join(parentDir, branch.replace(/\//g, "-")); // sanitize branch name for dir
          
          if (existsSync(worktreePath)) {
            return `Worktree directory already exists at ${worktreePath}`;
          }

          try {
            // 3. Create worktree
            // git worktree add -b <branch> <path> <base>
            await git(["worktree", "add", "-b", branch, worktreePath, base]);
            
            // 4. Launch new OpenCode session in that directory
            // macOS only for now
            if (process.platform === "darwin") {
              const escapeShell = (s: string) => s.replace(/'/g, "'\\''");
              const escapeAppleScript = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

              const shellPath = escapeShell(worktreePath);
              let shellCmd = `cd '${shellPath}' && opencode`;
              
              if (task) {
                 shellCmd += ` run '${escapeShell(task)}'`;
              }

              const appleScriptCmd = escapeAppleScript(shellCmd);

              const script = `
                tell application "Terminal"
                  do script "${appleScriptCmd}"
                  activate
                end tell
              `;
              
              spawnSync("osascript", [], { input: script, encoding: "utf-8" });
              
              return `Created worktree at ${worktreePath} and launched OpenCode in new terminal.${task ? ` Task: "${task}"` : ""}`;
            } else {
              return `Created worktree at ${worktreePath}. (Auto-launch not supported on ${process.platform}, please cd there manually)`;
            }
          } catch (e: any) {
            return `Failed to create worktree: ${e.message}`;
          }
        }
      },
      worktree_list: {
        name: "worktree_list",
        description: "List all active git worktrees.",
        async execute() {
          try {
            const output = await git(["worktree", "list"]);
            return output;
          } catch (e: any) {
            return `Error listing worktrees: ${e.message}`;
          }
        }
      },
      worktree_delete: {
        name: "worktree_delete",
        description: "Delete a worktree and clean up.",
        args: {
          path: {
             type: "string",
             description: "Path to the worktree to remove (or branch name if directory matches)"
          },
          force: {
             type: "boolean",
             description: "Force remove even if dirty (git worktree remove --force)"
          }
        },
        async execute(args: { path: string, force?: boolean }) {
           const { path, force } = args;
           try {
             const args = ["worktree", "remove", path];
             if (force) args.push("--force");
             
             await git(args);
             return `Removed worktree at ${path}`;
           } catch(e: any) {
             return `Failed to remove worktree: ${e.message}`;
           }
        }
      },
      worktree_status: {
        name: "worktree_status",
        description: "Check current worktree state (dirty, branch, sessions).",
        async execute() {
          const status = await git(["status", "--porcelain"]);
          const branch = await git(["branch", "--show-current"]);
          const sessions = await client.session.list({ query: { directory } });
          
          return JSON.stringify({
            dirty: status.length > 0,
            currentBranch: branch,
            activeSessions: (sessions.data || []).filter((s: any) => s.directory === directory).length
          }, null, 2);
        }
      }
    }
  };
};

export default WorktreePlugin;
