# turn-check (opencode and Claude Code)

## Problem

`~/.agents/AGENTS.md` is read once at session start. Nothing checks, after the agent stops, that
it followed those rules. Existing plugins only cover slices: `tool-guard` fires fixed
reminders at tool time, `reply-style` regex-lints reply length and banned words.

## What it does

When a session goes idle, a cheap model reads the whole user/assistant transcript and the rules in
AGENTS.md and returns PASS or a short list of violations with quoted evidence. Violations show as a
toast and are added as a note to your next message so the agent corrects course.

## Design

| Piece | Choice | Why |
|---|---|---|
| Trigger | `event` hook, `session.idle`. Not loaded in a headless `opencode run` (argv subcommand is `run`, no `--mini`/`-i`) unless `SUPERVISOR_AUDIT_RUN=1` | Fires when the agent stops; no polling. `run` exits at idle, so an audit could not deliver and would leave a child session behind |
| Input | `client.session.messages`: every user message, assistant text, one line per tool call. A `gh pr create`/`pr edit` command also adds its `--title` and body from the heredoc or the `--body-file` path, because tool args are clipped at 200 characters | Judge behaviour, not just wording |
| Judge | `fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash` (env `SUPERVISOR_MODEL`) | Cheap and fast; rules are explicit |
| Call | Throwaway child session, `session.prompt` with `agent: supervisor-judge`, `model`, `system`, then delete. The plugin registers that agent in its `config` hook with `permission: {"*": "deny"}` and `hidden: true` | Reuses opencode auth; no keys in the plugin. A wildcard deny hides every tool, MCP tools included. If the agent is missing the prompt fails and the audit is skipped, so it fails closed |
| Timeout | The prompt and the wait for the reply share one deadline (`SUPERVISOR_JUDGE_TIMEOUT`, default 120 s). On timeout the plugin calls `session.abort` and throws, so the audit is retried on the next idle | A hung judge cannot block a session's audits forever |
| Cleanup | At plugin start (fire and forget, errors ignored) it deletes sessions that have a `parentID`, are titled exactly `supervisor audit`, are older than 5 minutes and are not being audited by this instance. Top-level sessions are never deleted | Removes children left behind when the parent process exited mid-audit |
| Loop guard | Skip sessions that have a `parentID`; mark a message audited only after a valid verdict | The audit session goes idle too; failed audits retry on the next idle |
| Overlap | An idle during a running audit queues one follow-up audit | The newest turn is never left unchecked |
| Rules | Read `~/.agents/AGENTS.md` on every audit (env `SUPERVISOR_RULES`) | Edits apply immediately |
| Output | JSON only: `{verdict, violations:[{rule, evidence, fix}]}`, max 5. A FAIL with no usable violations is rejected as malformed | Parseable; evidence stops guessing; never records a bad reply as a pass |
| Feedback | Toast now; synthetic note via `experimental.chat.messages.transform`. opencode reloads messages from the database on every step, so a note added once is gone after the first tool call. The plugin remembers the user message id it injected into (per session) and adds the same note (part id `prt_supervisor...`, never twice to one message) on every step of that turn. A new audit's note is attached only when the latest user message has a non-synthetic text part and is not already tracked, so a compaction request never consumes it. The stored note is dropped when another user message becomes the latest, or when a PASS audit clears pending | Delivers to the agent for the whole turn without auto-prompting, so no fix loops |
| Record | `$SUPERVISOR_HOME/audits.jsonl` (default `~/.cache/supervisor`, read at call time). Directory mode 0700, file mode 0600. Entries older than 30 days and corrupt lines are removed at plugin start (atomic rewrite) | Measure false positives later; keep the log private and small |

## Claude Code version

Same auditor text, rules, truncation, verdict parsing and feedback text, ported to Python 3.9 (`claude/core.py`). State and log files are created 0600 in a 0700 directory.

| Step | What happens |
|---|---|
| `Stop` hook (`claude/stop.py`) | Skips if `SUPERVISOR_ENABLED=0`, `stop_hook_active`, `SUPERVISOR_CHILD=1` or no transcript. Otherwise starts `claude/audit.py` detached (`start_new_session`) and exits 0 with no output |
| Audit child | Waits `SUPERVISOR_SETTLE_SECONDS`, takes a per-session lock. The check, stale-lock removal and creation run under a `flock` guard file, so two audits that find the same stale lock cannot both take it. A lock is released only by its owner. A Stop during a running audit sets a rerun flag; the running child audits again when it finishes |
| Transcript | Parses the session JSONL: real user prompts (no tool results, `isMeta`, `<system-reminder>`, `<command-`, `<local-command`, `Caveat:`), assistant text, one line per tool call with its clipped result. Skips the audit if the agent did nothing after the last user message or the newest message uuid was already audited |
| Judge | `opencode run --pure --format json --title "supervisor audit" --dir <temp dir> --model <model>` with the prompt (auditor text + rules + transcript) written to its stdin, so it never appears in `ps` or hits the argument limit, and with `OPENCODE_CONFIG_CONTENT={"permission":{"*":"deny"}}`, `SUPERVISOR_ENABLED=0`, `SUPERVISOR_CHILD=1`. `--pure` loads no plugins, so no recursion. Own process group, killed whole after `SUPERVISOR_JUDGE_TIMEOUT` (default 240 s). The reply is the joined `text` events of the JSON stream. `opencode run` saves a session with the full transcript, so afterwards the audit runs `opencode session delete <sessionID>` (id read from the JSON events, 20 s limit, failures ignored). If no event arrived (timeout, crash) it lists sessions (both `session` commands run with `--pure`) and deletes those titled exactly `supervisor audit`, created after this audit started, in this audit's temp directory. Other sessions are never touched |
| Result | A valid verdict marks the message audited. PASS deletes `~/.cache/supervisor/pending/<session>.txt`; FAIL writes it. A failed or unparseable call is logged and retried on the next Stop |
| `UserPromptSubmit` hook (`claude/prompt.py`) | If a pending file exists, prints `systemMessage` plus `additionalContext` (the feedback in a `<system-reminder>`) and deletes the file, so it is delivered once |
| `SessionEnd` hook (`claude/session_end.py`) | Deletes the session's lock, rerun and state files, but keeps them while a live audit owns the lock (owner pid alive and mtime under 10 minutes); prunes pending and state files older than 7 days and audit log entries older than 30 days |

The audit costs one `opencode` start (a few seconds) per turn, off the hot path. The Stop hook never blocks or prompts the agent, so there is no fix loop.

## Auditor rules

Flag only what the transcript proves, with a quote. A violation corrected later is not one. An
explicit user request for another format overrides reply-style rules. Rules that cannot be judged
from a transcript are ignored.

## Limits

- The judge sees the transcript, not the repo. Rules about repo state (CI green, changeset present)
  are only caught when the transcript shows the contrary. A `gh pr create` body is visible only
  when the heredoc is in the transcript or the `--body-file` path still exists at audit time.
- Claude Code caps the whole prompt (auditor text, rules, transcript) at 400000 characters. Only when it is over, the oldest user messages are dropped first.
- Over `SUPERVISOR_MAX_CHARS` (default 60000) agent output is kept as one unbroken run ending at the newest message; older output is dropped. Every user message is always kept (each capped at 2000 characters), so the judge still sees every instruction.
- The transcript is untrusted text. A message in it can try to instruct the judge; with all tools denied the worst case is a wrong verdict, not an action.
- About 8k tokens of rules plus the transcript are sent per audit. A flash model keeps that cheap.
- A flash model can miss subtle violations or flag a wrong one. The log exists to tune the prompt.

## Not in scope

Auto-prompting the agent to fix itself (loop risk), blocking actions. Skipping audits in headless `claude -p`: the hooks docs list no field or variable that identifies those runs (`CLAUDE_CODE_REMOTE` only marks remote web sessions), so they still audit and the feedback goes unread.

## Files

`opencode/plugin.ts` wiring and hooks. `opencode/core.ts` pure functions (transcript, parsing,
feedback). `test/core.test.ts` run with `bun test`.

Claude Code: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `claude/{stop,audit,prompt,session_end}.py`,
`claude/core.py` pure functions, `claude/state.py` files and lock, `claude/tests/` run with
`python3 -m unittest discover -s claude/tests`.
