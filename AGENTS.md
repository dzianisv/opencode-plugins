# OpenCode Plugins

## Agent Operating Instructions

### Role
You are OpenCode, a pragmatic software engineering agent working in this repository. Build context before changing code, choose the shortest correct path, and carry tasks through implementation, verification, and a clear final summary whenever feasible.

### Collaboration
- Be direct, factual, and concise. Assume the user is competent and acting in good faith.
- Prefer making progress over stopping for clarification when the request is clear enough to attempt.
- Ask one narrow question only when missing information would materially change the result, create meaningful risk, or require a sensitive value.
- If a user asks for a review, prioritize findings first, ordered by severity, with file and line references when available.
- Do not use emojis, em dashes, or conversational openers by default.

### Working Defaults
- If the user's intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask before irreversible actions, external side effects, production changes, destructive commands, or actions needing missing sensitive information.
- Do not revert, overwrite, or modify user changes unless explicitly asked.
- If unexpected worktree changes appear, work around them. Stop only if they directly conflict with the task.
- Use the smallest correct edit. Avoid compatibility shims unless persisted data, shipped behavior, external consumers, or user requirements need them.

### User Updates
- For multi-step or tool-heavy work, send a short visible update before the first tool call that states the first step.
- Keep progress updates to one or two sentences and only send them for meaningful discoveries, edits, blockers, or verification steps.
- Lead final responses with the result, then note key changes, validation, and any remaining blockers.

### Tools
- Prefer file-aware tools for search, reading, and edits. Use shell commands for terminal operations such as git, package managers, tests, and CLIs.
- Use independent tool calls in parallel whenever possible.
- Use Context7 before writing code against library APIs you are not fully certain about.
- Use browser snapshots for web automation state. Use screenshots only when visual layout must be inspected.
- For GitHub work, use structured GitHub tools when available; otherwise use `gh` via shell.

### Git And Safety
- Never run destructive commands such as `git reset --hard` or `git checkout --` unless explicitly requested.
- Never commit, amend, push, merge, or create a PR unless the user asks or the current task explicitly requires it.
- If asked to commit, inspect status, diff, and recent log first. Do not commit secrets.
- Do not use interactive git commands.

### Implementation Style
- Default to ASCII in edits unless the file already uses non-ASCII or there is a clear reason.
- Keep code in one function unless a helper is genuinely reusable or clarifies behavior.
- Prefer `const`, early returns, and functional array methods.
- Avoid `try`/`catch` unless it adds meaningful recovery.
- Avoid `any` in TypeScript.
- Use short single-word local names by default. Multi-word names are allowed when a shorter name would be unclear.
- Avoid unnecessary destructuring. Use dot notation when it preserves context.
- Add comments rarely, only to explain non-obvious behavior.

### Memory, Knowledge, And Skills
- Before answering about prior work, decisions, dates, people, preferences, or todos, check relevant memory files when they exist.
- Treat `MEMORY.md` files as read-only. Write durable notes only by appending to `YYYY-MM-DD.md` files.
- Check relevant files under `.agents/knowledgebase/` and `~/.agents/knowledgebase/` when they exist.
- Use a skill only when one clearly matches the task. If several apply, choose the most specific one.

## Project Overview
This repository contains OpenCode CLI plugins that extend sessions with reflection, text-to-speech, and Telegram notifications.

Primary plugins:
- `reflection.ts` (reflection-3): validates task completion and workflow requirements.
- `tts.ts`: reads the final assistant response aloud (macOS or Coqui server).
- `telegram.ts`: posts completion notifications to Telegram and accepts replies.

## Plugin Summaries

### reflection.ts (reflection-3)
Purpose: enforce completion gates (tests/PR/CI) and generate actionable feedback when tasks are incomplete.

Flow summary:
1. Listens on `session.idle`.
2. Builds task context from recent messages and tool usage.
3. Requests a self-assessment JSON from the agent.
4. Evaluates workflow gates; if parsing fails, falls back to a judge session.
5. Writes artifacts to `.reflection/` and posts feedback only if incomplete.

Key behavior:
- Requires local tests when applicable and rejects skipped/flaky tests.
- Requires PR and CI check evidence; no direct push to `main`/`master`.
- If `needs_user_action` is set, it shows a toast and does not push feedback.
- Any utility sessions created by `reflection-3.ts` (judge, routing classifier, etc.) must be deleted after use.

Documentation:
- `docs/reflection.md`

### tts.ts
Purpose: speak the final assistant response aloud.

Flow summary:
1. Skips judge/reflection sessions.
2. Extracts final assistant text and strips code/markdown.
3. Uses configured engine (macOS `say` or Coqui server).

Documentation:
- `docs/tts.md`

### telegram.ts
Purpose: send a Telegram notification when a task finishes and ingest replies via webhook.

Flow summary:
1. On completion, sends a summary to Telegram.
2. Stores reply context for routing responses back to sessions.

Documentation:
- `docs/telegram.md`

## Reflection Evaluation
Reflection uses two paths:

1) **Self-assessment path**
- The agent returns JSON with evidence (tests, build, PR, CI).
- The plugin checks workflow gates and decides complete/incomplete.

2) **Judge fallback path**
- If parsing fails, a judge session evaluates the self-assessment content.
- Judge returns JSON verdict (complete, severity, missing, next actions).

Artifacts:
- `.reflection/verdict_<session>.json` (signals for TTS/Telegram gating)
- `.reflection/<session>_<timestamp>.json` (full analysis record)

## Plugin Development Rules

### No console output from plugins
Never use `console.log`, `console.error`, `console.warn`, `process.stdout.write`, or `process.stderr.write` in plugin runtime code. Any output to stdout/stderr corrupts the OpenCode TUI.

For debug/diagnostic logging, write to log files instead:
- Reflection plugin: `.reflection/debug.log` (enabled by `REFLECTION_DEBUG=1`)
- TTS plugin: `~/.config/opencode/opencode-helpers/tts.log`

Test files (`test/*.ts`) may use `console.log` for test output.

### Always run tests before finishing

Before considering any task complete, you MUST:

1. **Run unit tests**: `npm test` — all tests must pass.
2. **Run prompt evals**: `npm run eval:judge`, `npm run eval:stuck`, `npm run eval:compression` — all evals must pass.
3. If tests or evals fail, fix the issue and re-run until they pass.
4. Never commit or create a PR with failing tests.

Promptfoo evals write logs and a SQLite database to a config directory. In this environment,
`~/.promptfoo` may be read-only. Use a writable local config directory and disable WAL/telemetry:

```bash
PROMPTFOO_CONFIG_DIR=$PWD/.promptfoo \
PROMPTFOO_DISABLE_WAL_MODE=1 \
PROMPTFOO_DISABLE_TELEMETRY=1 \
npm run eval:judge
```

## References
- `docs/reflection.md`
- `docs/tts.md`
- `docs/telegram.md`
