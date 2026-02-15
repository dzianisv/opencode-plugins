#!/usr/bin/env bun
/**
 * opencode-worktree — Create a git worktree with symlinks and launch OpenCode.
 *
 * Usage:
 *   bun scripts/opencode-worktree.ts [branch-name]
 *
 * What it does:
 *   1. Creates a git worktree as a sibling of the current repo
 *   2. Fetches from origin
 *   3. Checks out origin/main or origin/master (whichever exists)
 *   4. Symlinks .env, .env.prod, .env.dev, node_modules into the worktree
 *   5. Launches opencode in the new worktree directory
 */

import { spawnSync } from "child_process";
import { existsSync, symlinkSync, lstatSync, readlinkSync } from "fs";
import { join, resolve, basename } from "path";

// ── Helpers ──────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd?: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const msg = (result.stderr || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status})${msg ? `: ${msg}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function git(args: string[], cwd?: string): string {
  return run("git", args, cwd);
}

function log(msg: string) {
  process.stderr.write(`${msg}\n`);
}

// ── Resolve repo root ────────────────────────────────────────────────

const repoRoot = git(["rev-parse", "--show-toplevel"]);
const parentDir = resolve(repoRoot, "..");

// ── Determine branch name ────────────────────────────────────────────

const branchArg = process.argv[2];
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

// Sanitize branch name: strip leading dots/slashes, collapse "..", remove
// characters invalid in git ref names (see git-check-ref-format(1)).
function sanitizeBranch(raw: string): string {
  let s = raw;
  s = s.replace(/^[./]+/, "");          // strip leading . or /
  s = s.replace(/\.{2,}/g, ".");        // collapse consecutive dots
  s = s.replace(/[\x00-\x1f\x7f ~^:?*[\]\\]/g, "-"); // invalid chars → dash
  s = s.replace(/\.lock(\/|$)/g, "$1"); // no ".lock" component
  s = s.replace(/\/{2,}/g, "/");        // collapse consecutive slashes
  s = s.replace(/[./]$/, "");           // no trailing . or /
  s = s.replace(/@\{/g, "at-");         // no @{
  return s || `worktree-${timestamp}`;
}

const branch = branchArg ? sanitizeBranch(branchArg) : `worktree-${timestamp}`;

// Sanitize for directory name: feat/foo → feat-foo
const dirName = `${basename(repoRoot)}-${branch.replace(/\//g, "-")}`;
const worktreePath = join(parentDir, dirName);

if (existsSync(worktreePath)) {
  log(`Error: worktree directory already exists at ${worktreePath}`);
  process.exit(1);
}

// ── Fetch from origin ────────────────────────────────────────────────

log(`Fetching from origin...`);
try {
  git(["fetch", "origin"], repoRoot);
} catch (e: any) {
  log(`Warning: fetch failed: ${e.message}`);
}

// ── Detect default branch (origin/main or origin/master) ─────────────

let defaultBranch: string;
try {
  const refs = git(["branch", "-r", "--list", "origin/main", "origin/master"], repoRoot);
  const lines = refs.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l === "origin/main")) {
    defaultBranch = "origin/main";
  } else if (lines.some((l) => l === "origin/master")) {
    defaultBranch = "origin/master";
  } else {
    // Fallback: try symbolic-ref
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repoRoot);
    defaultBranch = ref; // e.g. "origin/main"
  }
} catch {
  defaultBranch = "origin/main";
}

log(`Default branch: ${defaultBranch}`);

// ── Create worktree ──────────────────────────────────────────────────

log(`Creating worktree at ${worktreePath} (branch: ${branch}, base: ${defaultBranch})...`);
git(["worktree", "add", "-b", branch, worktreePath, defaultBranch], repoRoot);

// ── Checkout the remote default branch into the worktree ─────────────
// The worktree already starts from defaultBranch, but ensure we're at
// the exact remote HEAD.
try {
  git(["reset", "--hard", defaultBranch], worktreePath);
} catch (e: any) {
  log(`Warning: reset to ${defaultBranch} failed: ${e.message}`);
}

// ── Symlink shared files ─────────────────────────────────────────────

const filesToSymlink = [".env", ".env.prod", ".env.dev", "node_modules"];

for (const name of filesToSymlink) {
  const source = join(repoRoot, name);
  const target = join(worktreePath, name);

  if (!existsSync(source)) {
    // Source doesn't exist in main repo — skip silently
    continue;
  }

  // Remove existing file/dir in worktree if present (git may have checked one out)
  if (existsSync(target)) {
    try {
      // Check if it's already a correct symlink
      if (lstatSync(target).isSymbolicLink() && readlinkSync(target) === source) {
        log(`  ✓ ${name} (already symlinked)`);
        continue;
      }
    } catch {
      // fall through to removal
    }

    // Remove the existing entry so we can replace with symlink
    try {
      run("rm", ["-rf", target]);
    } catch {
      log(`  Warning: could not remove existing ${name} in worktree`);
      continue;
    }
  }

  try {
    symlinkSync(source, target);
    log(`  ✓ ${name} → ${source}`);
  } catch (e: any) {
    log(`  Warning: failed to symlink ${name}: ${e.message}`);
  }
}

// ── Launch opencode ──────────────────────────────────────────────────

log(`\nWorktree ready at ${worktreePath}`);
log(`Launching opencode...\n`);

const oc = spawnSync("opencode", [], {
  cwd: worktreePath,
  stdio: "inherit",
  env: process.env,
});

// ── Auto-cleanup after opencode exits ────────────────────────────────
// Remove the worktree and branch if there are no uncommitted, unstashed,
// or unpushed changes.  If anything is dirty, keep it and inform the user.

function worktreeIsClean(): { clean: boolean; reason?: string } {
  try {
    // 1. Uncommitted changes (staged or unstaged)
    const status = git(["status", "--porcelain"], worktreePath);
    if (status.length > 0) {
      return { clean: false, reason: "uncommitted changes" };
    }

    // 2. Stash entries
    const stash = git(["stash", "list"], worktreePath);
    if (stash.length > 0) {
      return { clean: false, reason: "stashed changes" };
    }

    // 3. Unpushed commits — compare HEAD to its upstream
    try {
      const unpushed = git(["log", "@{u}..HEAD", "--oneline"], worktreePath);
      if (unpushed.length > 0) {
        return { clean: false, reason: "unpushed commits" };
      }
    } catch {
      // No upstream set — check if branch has any commits beyond the base
      try {
        const unpushed = git(["log", `${defaultBranch}..HEAD`, "--oneline"], worktreePath);
        if (unpushed.length > 0) {
          return { clean: false, reason: "unpushed commits (no upstream)" };
        }
      } catch {
        // Can't determine — be safe and keep it
        return { clean: false, reason: "unable to determine push status" };
      }
    }

    return { clean: true };
  } catch (e: any) {
    return { clean: false, reason: `check failed: ${e.message}` };
  }
}

const { clean, reason } = worktreeIsClean();

if (clean) {
  log(`\nWorktree is clean — removing ${worktreePath} and branch ${branch}...`);
  try {
    git(["worktree", "remove", "--force", worktreePath], repoRoot);
    log(`  ✓ worktree removed`);
  } catch (e: any) {
    log(`  Warning: failed to remove worktree: ${e.message}`);
  }
  try {
    git(["branch", "-D", branch], repoRoot);
    log(`  ✓ branch ${branch} deleted`);
  } catch (e: any) {
    log(`  Warning: failed to delete branch: ${e.message}`);
  }
} else {
  log(`\nKeeping worktree at ${worktreePath} (${reason}).`);
  log(`To remove manually:\n  git worktree remove ${worktreePath} && git branch -D ${branch}`);
}

process.exit(oc.status ?? 1);
