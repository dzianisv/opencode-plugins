import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { existsSync } from "fs";

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
      worktree_create: tool({
        description: "Create a new git worktree for a feature branch and open it in a new terminal with OpenCode.",
        args: {
          branch: tool.schema.string().describe("Name of the new feature branch (e.g. 'feat/new-ui')"),
          base: tool.schema.string().optional().describe("Base branch to start from (default: 'main' or 'master')"),
          task: tool.schema.string().optional().describe("Initial task/prompt for the agent in the new window")
        },
        async execute(args) {
          const { branch, task } = args;
          let base = args.base;
          
          if (!base) {
            try {
              const branches = await git(["branch", "-r"]);
              base = branches.includes("origin/main") ? "main" : "master";
            } catch {
              base = "main";
            }
          }

          // Determine sibling path
          const parentDir = resolve(directory, "..");
          const worktreePath = join(parentDir, branch.replace(/\//g, "-"));
          
          if (existsSync(worktreePath)) {
            return `Worktree directory already exists at ${worktreePath}`;
          }

          try {
            // Create worktree
            await git(["worktree", "add", "-b", branch, worktreePath, base]);
            
            // Launch new OpenCode session (macOS only)
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
      }),

      worktree_list: tool({
        description: "List all active git worktrees.",
        args: {},
        async execute() {
          try {
            const output = await git(["worktree", "list"]);
            return output;
          } catch (e: any) {
            return `Error listing worktrees: ${e.message}`;
          }
        }
      }),

      worktree_delete: tool({
        description: "Delete a worktree and clean up.",
        args: {
          path: tool.schema.string().describe("Path to the worktree to remove (or branch name if directory matches)"),
          force: tool.schema.boolean().optional().describe("Force remove even if dirty (git worktree remove --force)")
        },
        async execute(args) {
          const { path, force } = args;
          try {
            const gitArgs = ["worktree", "remove", path];
            if (force) gitArgs.push("--force");
            
            await git(gitArgs);
            return `Removed worktree at ${path}`;
          } catch (e: any) {
            return `Failed to remove worktree: ${e.message}`;
          }
        }
      }),

      worktree_status: tool({
        description: "Check current worktree state (dirty, branch, sessions).",
        args: {},
        async execute() {
          try {
            const status = await git(["status", "--porcelain"]);
            const branch = await git(["branch", "--show-current"]);
            const sessions = await client.session.list({ query: { directory } });
            
            return JSON.stringify({
              dirty: status.length > 0,
              currentBranch: branch,
              activeSessions: (sessions.data || []).filter((s: any) => s.directory === directory).length
            }, null, 2);
          } catch (e: any) {
            return `Error getting status: ${e.message}`;
          }
        }
      })
    }
  };
};

export default WorktreePlugin;
