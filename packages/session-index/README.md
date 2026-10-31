# session-index

Keeps one small CSV of finished opencode sessions so a fresh agent can find prior work by folder.

`~/.agents/sessions.csv`:

```csv
id,folder,date,recap
ses_abc,"/Users/me/work/api","2026-10-31T03:56:24Z","Rebased the consumer branch and resolved conflicts; commit signing is blocked on ssh-agent."
```

Caps: newest 40 rows, 180 characters of recap per row, about 10 KB total.

## How it works

Ten minutes after a session execution finishes, the plugin reads its last messages, asks
`accounts/fireworks/models/deepseek-v4p1-flash` for a 1-3 sentence recap, and upserts the row.
If messages keep arriving it waits again, up to three times. If the model call fails it falls back to
the session title only, so raw transcript text never reaches the injected CSV. Child sessions are
skipped. Missing sessions from the last 14 days are backfilled on load, only while rows are free.
Failures are appended to `~/.agents/session-index.log`; the CSV is written `0600`.

Add the CSV to `instructions` in `opencode.json` so every session reads it at start.

## Install

Clone the repo, then point `plugin` at the package and `instructions` at the CSV in `opencode.json`:

```bash
git clone https://github.com/dzianisv/opencode-plugins
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-plugins/packages/session-index"],
  "instructions": ["~/.agents/sessions.csv"]
}
```

Restart opencode after editing `opencode.json`.

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `FIREWORKS_API_KEY` | read from `~/.env` | key used for recaps |
| `OPENCODE_SESSION_INDEX_MODEL` | `accounts/fireworks/models/deepseek-v4p1-flash` | recap model |
| `OPENCODE_SESSION_INDEX_IDLE_MS` | `600000` | idle wait before writing |

## Test

```bash
bun test
```
