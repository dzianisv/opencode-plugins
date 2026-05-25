# reflection-cc

Re-prompts Claude Code when it stops prematurely due to failure modes like summary-drift-stop or tool-available-punt. This plugin intercepts the Stop hook, analyzes the session transcript using Claude Haiku, classifies the failure reason, and decides whether to re-prompt with recovery instructions or accept the stop.

## Install

**Development**: `claude-code --plugin-dir /path/to/opencode-plugins/claude`

**Global**: Add to `~/.claude/settings.json`:
```json
{
  "plugins": [
    "~/.claude/plugins/reflection-cc"
  ]
}
```

## How it works

1. **Stop Hook**: Claude Code invokes the Stop hook when the agent terminates
2. **Transcript Analysis**: Haiku classifies the session transcript into failure categories
3. **Verdict**: Judge decides to re-prompt with recovery instructions or accept the stop
4. **Session Guards**: Loop prevention via attempt counter (max 3 cycles per session)

## Failure Categories

| Category | Description |
|----------|-------------|
| `tool_available_punt` | Agent stops despite available tools that could solve the task |
| `summary_drift_stop` | Agent creates summary before completion, loses task context |
| `genuinely_stuck` | Agent cannot progress; re-prompting won't help |
| `context_exhaustion` | Token limit reached; recovery unlikely |
| `decision_paralysis` | Agent unable to choose between valid options |
| `false_completion` | Agent claims task done when it isn't |

## Configuration

Environment variables:
- `REFLECTION_CC_DEBUG=1` — Enable debug output
- `REFLECTION_CC_MODEL` — Model for classification (default: `haiku-4-5`)
- `REFLECTION_CC_MAX_ATTEMPTS=3` — Max re-prompt cycles per session

## Disk Artifacts

Plugin stores local transcripts and verdicts:
- `.reflection/verdict_<sid>.json` — Haiku verdict + recovery instructions
- `.reflection/<sid>_<ts>.json` — Full transcript snapshot
- `.reflection/<sid>_attempts.json` — Attempt counter for session

**Privacy**: Transcripts stored locally only; never sent externally except to Haiku during classification.

## Status

Experimental. Baseline accuracy numbers pending PR evaluation.
