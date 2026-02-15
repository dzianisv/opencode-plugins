#!/usr/bin/env bash
# install.sh — 1-line installer for OpenCode plugins
# Usage: curl -fsSL https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/install.sh | bash
#
# Installs: reflection-3.ts, tts.ts, telegram.ts, worktree.ts
# Targets: macOS and Linux
set -euo pipefail

REPO="dzianisv/opencode-plugins"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

PLUGIN_DIR="${HOME}/.config/opencode/plugin"
CONFIG_DIR="${HOME}/.config/opencode"
PACKAGE_JSON="${CONFIG_DIR}/package.json"
BIN_DIR="${HOME}/.local/bin"
WORKTREE_BIN="${BIN_DIR}/opencode-worktree"
WORKTREE_SCRIPT_URL="${BASE_URL}/scripts/opencode-worktree.ts"

# Plugins to install
PLUGINS=(
  "reflection-3.ts"
  "tts.ts"
  "telegram.ts"
  "worktree.ts"
)

# Runtime dependencies required by the plugins
REQUIRED_DEPS='{"@supabase/supabase-js":"^2.49.0"}'

# --- helpers ---

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- pre-flight checks ---

preflight() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin|Linux) ;;
    *) fail "Unsupported OS: $os (only macOS and Linux are supported)" ;;
  esac

  if ! command_exists curl; then
    fail "curl is required but not found. Please install curl first."
  fi

  # Check for bun (used by OpenCode for plugin dependency management)
  if ! command_exists bun; then
    warn "bun is not installed. It is required by OpenCode to manage plugin dependencies."
    warn "Install bun: curl -fsSL https://bun.sh/install | bash"
    fail "Please install bun and re-run this script."
  fi
}

# --- package.json management ---

# Merge required dependencies into existing package.json without overwriting.
# Uses only POSIX tools (no jq required).
ensure_package_json() {
  mkdir -p "$CONFIG_DIR"

  if [ ! -f "$PACKAGE_JSON" ]; then
    # Create fresh package.json
    cat > "$PACKAGE_JSON" <<'EOF'
{
  "dependencies": {
    "@supabase/supabase-js": "^2.49.0"
  }
}
EOF
    ok "Created $PACKAGE_JSON"
    return
  fi

  # File exists — merge deps using a small inline node/bun script.
  # We know bun exists (checked in preflight).
  bun -e "
    const fs = require('fs');
    const path = '${PACKAGE_JSON}';
    const required = ${REQUIRED_DEPS};
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch { pkg = {}; }
    if (!pkg.dependencies) pkg.dependencies = {};
    let changed = false;
    for (const [k, v] of Object.entries(required)) {
      if (!pkg.dependencies[k]) { pkg.dependencies[k] = v; changed = true; }
    }
    if (changed) {
      fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
      console.log('Updated dependencies in package.json');
    } else {
      console.log('Dependencies already present');
    }
  "
}

# --- main ---

main() {
  info "Installing OpenCode plugins..."
  echo

  preflight

  # Create plugin directory
  mkdir -p "$PLUGIN_DIR"
  ok "Plugin directory ready: $PLUGIN_DIR"

  # Download each plugin
  info "Downloading plugins from github.com/${REPO}..."
  local failed=0
  for plugin in "${PLUGINS[@]}"; do
    if curl -fsSL -o "${PLUGIN_DIR}/${plugin}" "${BASE_URL}/${plugin}"; then
      ok "$plugin"
    else
      warn "Failed to download $plugin"
      failed=$((failed + 1))
    fi
  done

  if [ "$failed" -gt 0 ]; then
    fail "$failed plugin(s) failed to download. Check your network connection."
  fi

  # Install opencode-worktree helper
  echo
  info "Installing opencode-worktree to ${WORKTREE_BIN}..."
  mkdir -p "$BIN_DIR"
  if curl -fsSL -o "$WORKTREE_BIN" "$WORKTREE_SCRIPT_URL"; then
    chmod +x "$WORKTREE_BIN"
    ok "opencode-worktree"
  else
    warn "Failed to download opencode-worktree"
  fi

  # Set up dependencies
  echo
  info "Setting up dependencies..."
  ensure_package_json

  # Install with bun
  (cd "$CONFIG_DIR" && bun install --silent)
  ok "Dependencies installed"

  # Done
  echo
  info "Installation complete!"
  echo
  echo "  Installed plugins:"
  for plugin in "${PLUGINS[@]}"; do
    echo "    • $plugin"
  done
  echo "    • opencode-worktree"
  echo
  echo "  Restart OpenCode to activate the plugins."
  echo "  Ensure ${BIN_DIR} is on your PATH to run opencode-worktree."
  echo
}

main "$@"
