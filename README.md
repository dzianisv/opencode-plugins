# OpenCode Reflection Plugin

A plugin for [OpenCode](https://github.com/sst/opencode) that implements a **reflection/judge layer** to verify task completion. After an agent finishes work, this plugin automatically reviews the output and provides feedback if the task wasn't completed correctly, forcing the agent to continue.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Task      │────▶│  Agent Works     │────▶│ Session Idle    │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Agent Continues │◀────│  FAIL + Feedback │◀────│  Judge Reviews  │
│ (if FAIL)       │     └──────────────────┘     │  - Initial task │
└─────────────────┘                              │  - AGENTS.md    │
        │                                        │  - Tool calls   │
        │              ┌──────────────────┐      │  - Thoughts     │
        └─────────────▶│  PASS = Done!    │◀─────│  - Final result │
                       └──────────────────┘      └─────────────────┘
```

### Detailed Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           REFLECTION PLUGIN FLOW                           │
└────────────────────────────────────────────────────────────────────────────┘

  USER                    AGENT                   REFLECTION              JUDGE
   │                        │                        │                      │
   │  "Implement feature"   │                        │                      │
   │───────────────────────▶│                        │                      │
   │                        │                        │                      │
   │                        │ ┌────────────────────┐ │                      │
   │                        │ │ Tool calls:        │ │                      │
   │                        │ │ - read files       │ │                      │
   │                        │ │ - edit code        │ │                      │
   │                        │ │ - run tests        │ │                      │
   │                        │ └────────────────────┘ │                      │
   │                        │                        │                      │
   │                        │  Session becomes idle  │                      │
   │                        │───────────────────────▶│                      │
   │                        │                        │                      │
   │                        │                        │  Collect context:    │
   │                        │                        │  - Initial task      │
   │                        │                        │  - AGENTS.md         │
   │                        │                        │  - Last 10 tools     │
   │                        │                        │  - Reasoning         │
   │                        │                        │  - Final result      │
   │                        │                        │                      │
   │                        │                        │  Send to judge       │
   │                        │                        │─────────────────────▶│
   │                        │                        │                      │
   │                        │                        │      VERDICT:        │
   │                        │                        │      PASS/FAIL       │
   │                        │                        │◀─────────────────────│
   │                        │                        │                      │
   │                        │                        │                      │
   │                        │      [If FAIL]         │                      │
   │                        │◀───────────────────────│                      │
   │                        │  Feedback + continue   │                      │
   │                        │                        │                      │
   │                        │ ┌────────────────────┐ │                      │
   │                        │ │ More tool calls... │ │                      │
   │                        │ └────────────────────┘ │                      │
   │                        │                        │                      │
   │                        │  Session idle again    │                      │
   │                        │───────────────────────▶│                      │
   │                        │                        │     (repeat...)      │
   │                        │                        │                      │
   │      [If PASS]         │                        │                      │
   │◀───────────────────────│◀───────────────────────│                      │
   │   Task complete!       │                        │                      │
   │                        │                        │                      │
```

## Features

| Feature | Description |
|---------|-------------|
| **Automatic trigger** | Fires when session becomes idle (agent finished) |
| **Context collection** | Gathers initial task, AGENTS.md, last 10 tool calls, reasoning/thoughts, and final result |
| **Separate judge session** | Creates an independent session for unbiased evaluation |
| **Structured verdict** | Returns PASS/FAIL with reasoning and actionable feedback |
| **Auto-continue** | If FAIL, injects feedback and forces agent to continue work |
| **Loop protection** | Maximum 3 reflection attempts per session to prevent infinite loops |

## Installation

### One-line install (global)

```bash
mkdir -p ~/.config/opencode/plugin && curl -fsSL -o ~/.config/opencode/plugin/reflection.ts https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

### One-line install (project-specific)

```bash
mkdir -p .opencode/plugin && curl -fsSL -o .opencode/plugin/reflection.ts https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

### Alternative: Clone and copy

```bash
git clone https://github.com/dzianisv/opencode-reflection-plugin.git && cp opencode-reflection-plugin/reflection.ts .opencode/plugin/
```

## Usage

Once installed, the plugin works automatically:

1. Start opencode as usual
2. Give the agent a task
3. When the agent finishes, the reflection plugin automatically:
   - Collects context (task, tool calls, results)
   - Creates a judge session to evaluate the work
   - If incomplete, sends feedback and forces the agent to continue
   - Repeats up to 3 times or until PASS

### Logs

The plugin logs to console with `[Reflection]` prefix:

```
[Reflection] Plugin initialized
[Reflection] Starting reflection for session sess_abc123 (attempt 1)
[Reflection] Created judge session: sess_xyz789
[Reflection] Judge response: VERDICT: FAIL...
[Reflection] Verdict: FAIL
[Reflection] Reasoning: The agent only implemented 2 of 3 features...
[Reflection] Sending feedback to session sess_abc123
```

### Feedback Example

When the judge finds incomplete work, the agent receives:

```markdown
## Reflection Feedback (Attempt 1/3)

Your work has been reviewed and found **incomplete**. Please continue.

**Issue:** The agent only implemented 2 of the 3 requested features.

**Required Action:** Implement the missing validation logic for the email field as originally requested.

Please address the feedback above and complete the original task fully.
```

## Configuration

Edit the constants at the top of `reflection.ts`:

```typescript
// Maximum number of reflection attempts before giving up
const MAX_REFLECTION_ATTEMPTS = 3
```

## How the Judge Evaluates

The judge receives:

1. **AGENTS.md** - Your project's agent instructions
2. **Original task** - The user's initial request
3. **Last 10 tool calls** - With inputs and outputs
4. **Reasoning/thoughts** - From extended thinking models
5. **Final response** - The agent's completion message

The judge then evaluates:
- Did the agent address ALL parts of the request?
- Were tool calls appropriate and successful?
- Is the final response accurate and complete?
- Are there obvious errors, omissions, or incomplete work?

## Requirements

- [OpenCode](https://github.com/sst/opencode) v1.0+
- Plugin uses the currently selected model for both agent and judge

## License

MIT

## Contributing

Issues and PRs welcome at [github.com/dzianisv/opencode-reflection-plugin](https://github.com/dzianisv/opencode-reflection-plugin)
