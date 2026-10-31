# session-distill

End-of-session retrospective for Claude Code. It finds the scripts, CLI tools, fixes and
corrections from a session and proposes where each belongs: an edit to an existing skill, a new
skill, `AGENTS.md`/`CLAUDE.md`, memory, a hook, a command or a subagent. Nothing is written
without approval.

Standard library only, no network calls.

**Provenance.** This is not a clean-room implementation. It was written by an AI assistant after
reading the source of an existing third-party plugin (`reflect-extensions` in
`akaihola/skills-akaihola`, licence "For personal use") and then reworked: different detection,
state layout, file names and prompts, and no prompt text is stored. A line comparison finds no
identical lines over 40 characters, but that does not prove independence. Check your policy on
third-party code before relying on it.

| Path | Purpose |
|------|---------|
| `commands/session-distill.md` | `/session-distill:session-distill [--dry-run] [--session id] [--days N] [--min-confidence F]` |
| `hooks/hooks.json` | UserPromptSubmit capture, Stop reminder, SessionEnd cleanup |
| `scripts/capture.py` | Notes prompts that read like corrections or standing rules. Stores no prompt text, only a pointer into the transcript |
| `scripts/reminder.py` | Once-per-session reminder after real work, newly created script files or queued cues |
| `scripts/reflect_state.py` | Shared state helpers (`~/.claude/session-distill/`) |

## Install

```bash
claude plugin marketplace add dzianisv/opencode-plugins
claude plugin install session-distill@agents-plugins
```

Restart Claude Code so the hooks load. After changing the plugin, bump `version` in
`.claude-plugin/plugin.json`; `claude plugin update` ignores changes with the same version.

## Notes

- The reminder uses `Stop` only. Claude Code discards `systemMessage` from `PreCompact`, and plain stdout from a `Stop` hook is not shown, so the reminder is always a `systemMessage`.
- A "new script" counts only when a `Write` to a script-like path returns "created successfully"; overwrites and failed writes are ignored.
- Because capture keeps no prompt text, a leaked secret cannot reach the queue. `/session-distill:session-distill` reads the wording from the transcript.

## Settings (env vars)

`SESSION_DISTILL_CAPTURE` (1), `SESSION_DISTILL_QUEUE_MAX` (200), `SESSION_DISTILL_MIN_ACTIONS` (3),
`SESSION_DISTILL_REMIND_ONCE` (1), `SESSION_DISTILL_TTL_DAYS` (7), `SESSION_DISTILL_HOME` (state dir).

## Test

```bash
python3 -m unittest discover -s tests
```

## opencode

`opencode/` is a port of the same idea for opencode (needs bun and the opencode plugin runtime, no other dependencies).

| Path | Purpose |
|------|---------|
| `opencode/plugin.ts` | v1 plugin entry. `chat.message` queues cue pointers, `session.idle` shows the reminder toast, `config` registers `/session-distill` |
| `server.ts` | v2 plugin entry. Queues cues from the context hook and injects the reminder into the next user message; `/session-distill` is not registered on v2 |
| `opencode/core.ts` | Pure helpers: cue tables, queue, tally, command template |
| `opencode/test/` | `bun test` with a fake client; `live-e2e.ts` runs a real opencode server |

Install: clone `dzianisv/opencode-plugins` and add `/absolute/path/to/opencode-plugins/packages/session-distill`
to `plugin` in `~/.config/opencode/opencode.json`. v2 loads `server.ts`; v1 loads `opencode/plugin.ts`.

- Command: `/session-distill [--dry-run] [--session <id>] [--min-confidence F]`. It reads the transcript with `opencode export <session id>`; the plugin fills in the current session id.
- State: `~/.cache/session-distill/` (`queue/<session id>.jsonl`, `markers/`). Records hold `ts`, `sessionID`, `messageID`, `kinds`, `confidence` and no prompt text.
- The reminder counts tool calls from the session messages at idle time, so it survives a restart. A new script counts only when the `write` result has `metadata.exists === false`.
- Env: `SESSION_DISTILL_CAPTURE` (1), `SESSION_DISTILL_QUEUE_MAX` (200), `SESSION_DISTILL_MIN_ACTIONS` (3), `SESSION_DISTILL_REMIND_ONCE` (1), `SESSION_DISTILL_TTL_DAYS` (7), `SESSION_DISTILL_HOME` (state dir).

```bash
cd opencode && bun test
bun run test/live-e2e.ts   # starts a real server and calls a model
```
