---
name: opencode-session-db
description: Read OpenCode sessions, messages, and tool outputs directly from the SQLite database at ~/.local/share/opencode/. Use when asked to "read opencode sessions", "query opencode db", "find old sessions", "search session history", "read message history", "export session", "inspect opencode data", "look up past conversations", or any task requiring direct access to OpenCode's local storage. Does NOT require a running OpenCode server.
compatibility: Requires sqlite3 CLI and an existing OpenCode installation with data at ~/.local/share/opencode/
metadata:
  author: dzianisv
  version: "1.0"
---

# OpenCode Session DB

Read OpenCode sessions and messages directly from SQLite — no running server needed.

## Database Location

```
~/.local/share/opencode/opencode.db        # latest/beta channel
~/.local/share/opencode/opencode-{channel}.db  # dev, local, etc.
```

Override: `OPENCODE_DB` env var. WAL mode is enabled; always open read-only.

## Schema Overview

11 tables. The key ones for session reading:

| Table | PK | Key columns |
|---|---|---|
| `project` | `id` | `worktree`, `name` |
| `session` | `id` | `project_id`, `title`, `slug`, `directory`, `time_created`, `time_updated`, `time_archived` |
| `message` | `id` | `session_id`, `time_created`, `data` (JSON: role, tokens, cost, model, error) |
| `part` | `id` | `message_id`, `session_id`, `time_created`, `data` (JSON: type, text, tool info) |
| `todo` | `(session_id, position)` | `content`, `status`, `priority` |

### Message `data` JSON structure
```json
{"role": "user"|"assistant", "tokens": {...}, "cost": N, "model": {...}, "error": {...}}
```

### Part `data` JSON structure — discriminated by `type`
- `text` — `{type:"text", text:"..."}`
- `tool` — `{type:"tool", tool:"toolName", input:{...}, output:"...", state:"completed"|"error"|...}`
- `reasoning` — `{type:"reasoning", text:"..."}`
- `step-start`/`step-finish` — step boundaries
- `snapshot`/`patch`/`compaction` — context management
- `file` — file references
- `agent`/`subtask` — delegation

## Common Queries

Always open read-only: `sqlite3 -readonly "$DB"`

```bash
# Set DB path
DB=~/.local/share/opencode/opencode.db
```

### List recent sessions
```sql
SELECT s.id, s.title, datetime(s.time_created/1000, 'unixepoch') as created,
       datetime(s.time_updated/1000, 'unixepoch') as updated, p.name as project
FROM session s JOIN project p ON s.project_id = p.id
WHERE s.time_archived IS NULL
ORDER BY s.time_updated DESC LIMIT 20;
```

### Search sessions by title
```sql
SELECT id, title, datetime(s.time_updated/1000, 'unixepoch') as updated
FROM session s WHERE title LIKE '%search term%'
ORDER BY time_updated DESC;
```

### Count messages per session
```sql
SELECT s.id, s.title, COUNT(m.id) as msgs
FROM session s LEFT JOIN message m ON m.session_id = s.id
GROUP BY s.id ORDER BY s.time_updated DESC LIMIT 20;
```

### Read messages from a session (chronological)
```sql
SELECT m.id, json_extract(m.data, '$.role') as role,
       datetime(m.time_created/1000, 'unixepoch') as time
FROM message m WHERE m.session_id = ?
ORDER BY m.time_created ASC, m.id ASC;
```

### Read full conversation (messages + text parts)
```sql
SELECT json_extract(m.data, '$.role') as role,
       json_extract(p.data, '$.type') as type,
       SUBSTR(json_extract(p.data, '$.text'), 1, 500) as text
FROM message m
JOIN part p ON p.message_id = m.id
WHERE m.session_id = ?
  AND json_extract(p.data, '$.type') IN ('text', 'reasoning')
ORDER BY m.time_created ASC, p.time_created ASC;
```

### List tool calls in a session
```sql
SELECT json_extract(p.data, '$.tool') as tool,
       json_extract(p.data, '$.state') as state,
       SUBSTR(json_extract(p.data, '$.input'), 1, 200) as input,
       datetime(p.time_created/1000, 'unixepoch') as time
FROM part p
WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'tool'
ORDER BY p.time_created ASC;
```

### Get token usage and cost for a session
```sql
SELECT SUM(json_extract(m.data, '$.cost')) as total_cost,
       SUM(json_extract(m.data, '$.tokens.input')) as input_tokens,
       SUM(json_extract(m.data, '$.tokens.output')) as output_tokens
FROM message m WHERE m.session_id = ?
  AND json_extract(m.data, '$.role') = 'assistant';
```

### Find sessions with errors
```sql
SELECT DISTINCT s.id, s.title
FROM session s
JOIN message m ON m.session_id = s.id
WHERE json_extract(m.data, '$.error') IS NOT NULL;
```

### List all projects
```sql
SELECT id, name, worktree FROM project ORDER BY time_updated DESC;
```

### Sessions per project with stats
```sql
SELECT p.name, COUNT(s.id) as sessions,
       MAX(datetime(s.time_updated/1000, 'unixepoch')) as last_active
FROM project p LEFT JOIN session s ON s.project_id = p.id
GROUP BY p.id ORDER BY last_active DESC;
```

### Export session as markdown
```bash
sqlite3 -readonly "$DB" "
SELECT CASE json_extract(m.data, '$.role')
  WHEN 'user' THEN '## User' ELSE '## Assistant' END || char(10) ||
  COALESCE(json_extract(p.data, '$.text'), '[' || json_extract(p.data, '$.type') || ']')
  || char(10)
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id = '$SESSION_ID'
  AND json_extract(p.data, '$.type') IN ('text')
ORDER BY m.time_created ASC, p.time_created ASC;
"
```

## Bundled Script

Use `scripts/query.sh` for quick lookups:

```bash
# List recent sessions
./scripts/query.sh sessions

# Search sessions
./scripts/query.sh search "fix bug"

# Read a session's conversation
./scripts/query.sh read <session-id>

# List tool calls
./scripts/query.sh tools <session-id>

# Export to markdown
./scripts/query.sh export <session-id>

# Session stats (tokens, cost)
./scripts/query.sh stats <session-id>
```

## Tips

- Timestamps are Unix milliseconds. Use `datetime(ts/1000, 'unixepoch')` for display.
- Session IDs are descending ULIDs — newer sessions sort first alphabetically.
- Message IDs are ascending — older messages sort first.
- Always use `-readonly` flag to avoid WAL conflicts with a running OpenCode instance.
- Multiple DB files may exist for different channels (dev, local, main).
