#!/bin/bash

# Automate starting OpenCode in a unique Git worktree

# Define repository and base worktree directory
REPO_DIR="/Users/engineer/workspace/opencode-reflection-plugin"
WORKTREE_BASE="/tmp/opencode-worktrees"

# Ensure the base worktree directory exists
mkdir -p "$WORKTREE_BASE"

# Generate a unique identifier for this worktree
WORKTREE_NAME="worktree-$(date +%s%N)"
WORKTREE_PATH="$WORKTREE_BASE/$WORKTREE_NAME"

# Create a new worktree
cd "$REPO_DIR"
git worktree add "$WORKTREE_PATH"

# Print the path of the new worktree
echo "New worktree created at: $WORKTREE_PATH"

# Start OpenCode in the new worktree
cd "$WORKTREE_PATH"
opencode serve