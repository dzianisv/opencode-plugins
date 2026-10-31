#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/.agents/overhelm.md"

if [ ! -f "$FILE" ]; then
  mkdir -p "$HOME/.agents"
  cat > "$FILE" <<'EOF'
DO NOT OVERFLOW MY MIND
REPLY SHORT
SIMPLE ENGLISH
DO NOT OVERCOMPLICATE
EOF
fi

EVENT_NAME="${1:-UserPromptSubmit}"

CONTENT_FILE="$FILE" EVENT_NAME="$EVENT_NAME" node -e '
const fs = require("fs");
const content = fs.readFileSync(process.env.CONTENT_FILE, "utf8");
process.stdout.write(JSON.stringify({
  continue: true,
  hookSpecificOutput: {
    hookEventName: process.env.EVENT_NAME,
    additionalContext: content
  }
}));
'
