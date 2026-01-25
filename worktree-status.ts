import type { Plugin } from "@opencode-ai/plugin";
import { spawnSync } from "child_process";

export const WorktreeStatusPlugin: Plugin = async (ctx) => {
  const { directory, client } = ctx;

  return {
    tool: {
      worktree_status: {
        name: "worktree_status",
        description:
          "Check the current worktree state: dirty, busy, branch status, and active sessions.",
        async execute() {
          // Check if the worktree is dirty using git status
          const gitStatus = spawnSync("git", ["status", "--porcelain"], {
            cwd: directory,
            encoding: "utf-8",
          });
          
          // Get the current branch name
          const branchResult = spawnSync("git", ["branch", "--show-current"], {
            cwd: directory,
            encoding: "utf-8",
          });

          // List active OpenCode sessions
          const sessionsResult = await client.session.list({ query: { directory } });

          // Return the status as a JSON object
          return JSON.stringify({
            dirty: (gitStatus.stdout || "").trim().length > 0,
            busy: (sessionsResult.data || []).filter(
              (s: any) => s.directory === directory
            ).length > 1,
            currentBranch: (branchResult.stdout || "").trim(),
          });
        },
      },
    },
  };
};
export default WorktreeStatusPlugin;
