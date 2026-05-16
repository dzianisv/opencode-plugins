#!/usr/bin/env bash
set -euo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
CMD="${1:-help}"
ARG="${2:-}"

if [ ! -f "$DB" ]; then
  echo "Database not found: $DB"
  echo "Set OPENCODE_DB or check ~/.local/share/opencode/"
  exit 1
fi

q() { sqlite3 -readonly -header -column "$DB" "$1"; }

case "$CMD" in
  sessions)
    q "SELECT s.id, s.title, datetime(s.time_updated/1000,'unixepoch') as updated, p.name as project
       FROM session s JOIN project p ON s.project_id = p.id
       WHERE s.time_archived IS NULL
       ORDER BY s.time_updated DESC LIMIT ${ARG:-20};"
    ;;
  search)
    [ -z "$ARG" ] && echo "Usage: query.sh search <term>" && exit 1
    q "SELECT id, title, datetime(time_updated/1000,'unixepoch') as updated
       FROM session WHERE title LIKE '%${ARG}%'
       ORDER BY time_updated DESC LIMIT 20;"
    ;;
  read)
    [ -z "$ARG" ] && echo "Usage: query.sh read <session-id>" && exit 1
    q "SELECT json_extract(m.data,'$.role') as role,
              json_extract(p.data,'$.type') as type,
              SUBSTR(json_extract(p.data,'$.text'),1,500) as text
       FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = '${ARG}'
         AND json_extract(p.data,'$.type') IN ('text','reasoning')
       ORDER BY m.time_created ASC, p.time_created ASC;"
    ;;
  tools)
    [ -z "$ARG" ] && echo "Usage: query.sh tools <session-id>" && exit 1
    q "SELECT json_extract(p.data,'$.tool') as tool,
              json_extract(p.data,'$.state') as state,
              SUBSTR(json_extract(p.data,'$.input'),1,200) as input,
              datetime(p.time_created/1000,'unixepoch') as time
       FROM part p
       WHERE p.session_id = '${ARG}' AND json_extract(p.data,'$.type') = 'tool'
       ORDER BY p.time_created ASC;"
    ;;
  stats)
    [ -z "$ARG" ] && echo "Usage: query.sh stats <session-id>" && exit 1
    q "SELECT COUNT(*) as messages,
              SUM(json_extract(m.data,'$.cost')) as total_cost,
              SUM(json_extract(m.data,'$.tokens.input')) as input_tokens,
              SUM(json_extract(m.data,'$.tokens.output')) as output_tokens
       FROM message m WHERE m.session_id = '${ARG}'
         AND json_extract(m.data,'$.role') = 'assistant';"
    ;;
  export)
    [ -z "$ARG" ] && echo "Usage: query.sh export <session-id>" && exit 1
    sqlite3 -readonly "$DB" "
      SELECT CASE json_extract(m.data,'$.role')
        WHEN 'user' THEN '## User' ELSE '## Assistant' END || char(10) ||
        COALESCE(json_extract(p.data,'$.text'),'[' || json_extract(p.data,'$.type') || ']') || char(10)
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = '${ARG}' AND json_extract(p.data,'$.type') = 'text'
      ORDER BY m.time_created ASC, p.time_created ASC;"
    ;;
  projects)
    q "SELECT id, name, worktree FROM project ORDER BY time_updated DESC;"
    ;;
  *)
    echo "Usage: query.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  sessions [limit]     List recent sessions (default 20)"
    echo "  search <term>        Search sessions by title"
    echo "  read <session-id>    Read conversation text"
    echo "  tools <session-id>   List tool calls"
    echo "  stats <session-id>   Token usage and cost"
    echo "  export <session-id>  Export session as markdown"
    echo "  projects             List all projects"
    ;;
esac
