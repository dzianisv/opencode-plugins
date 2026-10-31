# overhelm

Adds a short-reply, plain-English instruction to every prompt so replies do not overwhelm.
Works in Claude Code and opencode. Both read the same file, `~/.agents/overhelm.md`; edit it to
change the instruction in both. If it is missing it is created with the default text.

| Path | Purpose |
|------|---------|
| `hooks/hooks.json`, `hooks/inject-overhelm.sh` | Claude Code: injects the file on `SessionStart` and `UserPromptSubmit` |
| `server.ts` | opencode v2: appends the file to the system instructions of each request; skips child sessions |
| `opencode/plugin.ts`, `opencode/core.ts` | opencode v1: adds the file as a synthetic reminder on the last user message of each turn |

## Install

Claude Code:

```bash
claude plugin marketplace add dzianisv/opencode-plugins
claude plugin install overhelm@opencode-plugins
```

opencode: add the plugin directory to `plugins` in `~/.config/opencode/opencode.json`, using a
directory and not a file, then restart opencode. The same entry serves v1 (through package.json
`main`) and v2 (through `server.ts`).

```
"/absolute/path/to/opencode-plugins/packages/overhelm"
```

Bump `version` in `.claude-plugin/plugin.json` after changes, or `claude plugin update` does nothing.

## Settings

`OVERHELM_FILE` (opencode, instruction path), `OVERHELM_ENABLED=0` (opencode, turn off).

## Test

```bash
cd opencode && bun test
```

`opencode/test/live-e2e.ts` starts a real opencode server with the plugin and a marker instruction
and checks that the model repeats the marker (needs `@opencode-ai/sdk` on the module path).
