# Feature: Worktree Management Plugin - Agent Delegation

Issue: User requested ability to delegate tasks to a new agent in the new worktree.
Started: 2026-01-30

## Goal
Enhance `worktree_create` to support an optional `agent` parameter. If provided, the new OpenCode session launched in the worktree will be initialized with that agent (e.g., `opencode run "Start working on feature X"`).

## Tasks

- [x] Task 1: Update `worktree_create` signature
  - Add `prompt` or `task` argument (string, optional).
- [x] Task 2: Modify launch script
  - If `prompt` is provided, launch OpenCode with `opencode run "<prompt>"`.
  - If no prompt, launch with `opencode`.
- [x] Task 3: Verify
  - Test locally.
  - Commit: Worktree agent delegation support

## Completed

- [x] Implemented Immediate Global TTS Stop
  - Modified `tts.ts` to use a global stop signal file.
  - Updated `execAndTrack` to poll for the stop signal and kill active processes.
  - Updated `playAudioFile` to check for stop signal before starting.
  - Updated `setTTSEnabled` to trigger the global stop signal when disabling TTS.
  - Verified with typecheck and unit tests.
- [x] Task that was done
  - Commit: abc123
  - Notes: What was actually implemented
