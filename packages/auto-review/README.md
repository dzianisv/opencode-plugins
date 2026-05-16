# opencode-auto-review

An [OpenCode](https://github.com/opencode-ai/opencode) plugin that automatically reviews AI-completed work using a different model for cross-validation.

After each non-trivial task turn, it spawns a child session with a different model to validate completion quality, test evidence, and catch missed edge cases.

## Install

### Option A: Single-file copy (recommended)

```bash
# Create the plugin directory if it doesn't exist
mkdir -p ~/.config/opencode/plugin

# Copy the plugin
cp auto-review.ts ~/.config/opencode/plugin/
```

Restart `opencode` or `opencode-serve` — the plugin is auto-discovered.

### Option B: Clone the repo

```bash
git clone https://github.com/dzianisv/opencode-plugins.git ~/workspace/opencode-plugins

# Symlink the plugin into opencode's plugin dir
mkdir -p ~/.config/opencode/plugin
ln -sf ~/workspace/opencode-plugins/packages/auto-review/auto-review.ts ~/.config/opencode/plugin/auto-review.ts
```

## Configuration

Create a config file at `~/.config/opencode/plugin/auto-review.json`:

```json
{
  "model": "github-copilot/gpt-5.5",
  "reasoning": "xhigh",
  "minToolCalls": 3,
  "debug": true
}
```

An example file is included: [`auto-review.example.json`](./auto-review.example.json)

```bash
cp auto-review.example.json ~/.config/opencode/plugin/auto-review.json
# Edit to your preference
```

### Config Options

| Field | Default | Description |
|-------|---------|-------------|
| `model` | *(auto-select)* | Force a specific review model, e.g. `github-copilot/gpt-5.5`, `anthropic/claude-opus-4.6`, `openai/gpt-5.5` |
| `reasoning` | *(none)* | Reasoning effort variant: `low`, `medium`, `high`, `xhigh` |
| `minToolCalls` | `3` | Minimum tool calls in a turn to trigger review (skip trivial interactions) |
| `debug` | `false` | Enable debug logging to `.reflection/debug.log` in the project directory |

Environment variables (`AUTO_REVIEW_MODEL`, `AUTO_REVIEW_REASONING`, `AUTO_REVIEW_DEBUG`) are also supported as fallbacks if the config file is absent.

### Model Selection

When `model` is not set, the plugin automatically:
1. Queries available models from your OpenCode config
2. Picks a model from a **different family** than the one that did the work (e.g., if Claude did the work, it picks GPT or Gemini for review)
3. Prefers stronger models (opus > codex > sonnet > pro)
4. Falls back through candidates until one succeeds

## How It Works

1. Listens for `session.idle` events (fired when the AI finishes a turn)
2. Waits 1.5s to ensure the session wasn't aborted
3. Validates the turn had meaningful work (≥3 tool calls)
4. Creates a child review session
5. Sends a structured review prompt to the review model
6. The review checks: task completion, tests, PR existence, CI, edge cases
7. Reports: PASS/FAIL checklist with evidence

## What Gets Skipped

- Aborted/cancelled sessions (recent ESC/abort within 10s)
- Child sessions (avoids reviewing reviews)
- Trivial interactions (fewer than 3 tool calls)
- Already-reviewed messages (deduplication by message signature)
- Messages containing review markers (loop prevention)

## Example Output

The review child session produces a structured report like:

```
1) Checklist:
   - Task completion: PASS — all requested changes implemented
   - Tests run/pass: FAIL — no test execution observed
   - PR exists: PASS — PR #42 created
   - CI passed: UNKNOWN — no CI evidence in conversation

2) Issues:
   - Tests were not run after code changes

3) Review failed — tests not verified.
```

## Compatibility

- OpenCode v0.1+ with plugin support
- Requires `@opencode-ai/plugin` and `@opencode-ai/sdk` (bundled with opencode)
- Works with any model provider configured in opencode (GitHub Copilot, Anthropic, OpenAI, Google, etc.)

## License

MIT
