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

process.exit(oc.status ?? 1);
