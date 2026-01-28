# Reflection Plugin Architecture

The reflection plugin evaluates whether an AI agent has completed its assigned task and provides feedback to continue if needed.

## Decision Flow Diagram

```
                              +------------------+
                              |  session.idle    |
                              |  event received  |
                              +--------+---------+
                                       |
                                       v
                        +-----------------------------+
                        |  Was session recently       |
                        |  aborted (Esc key)?         |
                        +-------------+---------------+
                                      |
                       +--------------+--------------+
                       | YES                         | NO
                       v                             v
               +---------------+          +--------------------+
               | Skip - user   |          | Is this a judge    |
               | cancelled     |          | session?           |
               +---------------+          +---------+----------+
                                                    |
                                     +--------------+--------------+
                                     | YES                         | NO
                                     v                             v
                             +---------------+          +--------------------+
                             | Skip - avoid  |          | Count human msgs   |
                             | infinite loop |          | (exclude feedback) |
                             +---------------+          +---------+----------+
                                                                  |
                                                                  v
                                                    +-----------------------------+
                                                    |  Already reflected on this  |
                                                    |  message count?             |
                                                    +-------------+---------------+
                                                                  |
                                                   +--------------+--------------+
                                                   | YES                         | NO
                                                   v                             v
                                           +---------------+          +--------------------+
                                           | Skip - avoid  |          | Max attempts       |
                                           | duplicate     |          | reached (16)?      |
                                           +---------------+          +---------+----------+
                                                                                |
                                                                 +--------------+--------------+
                                                                 | YES                         | NO
                                                                 v                             v
                                                         +---------------+          +--------------------+
                                                         | Stop - give   |          | Extract task &     |
                                                         | up on task    |          | result from msgs   |
                                                         +---------------+          +---------+----------+
                                                                                              |
                                                                                              v
                                                                                +---------------------------+
                                                                                |   CREATE JUDGE SESSION    |
                                                                                |   Send evaluation prompt  |
                                                                                +-----------+---------------+
                                                                                            |
                                                                                            v
                                                                                +---------------------------+
                                                                                |   PARSE VERDICT JSON      |
                                                                                |   {complete, severity,    |
                                                                                |    feedback, missing,     |
                                                                                |    next_actions}          |
                                                                                +-----------+---------------+
                                                                                            |
                                                                         +------------------+------------------+
                                                                         |                                     |
                                                                         v                                     v
                                                              +--------------------+              +------------------------+
                                                              |  complete: true    |              |  complete: false       |
                                                              |  (and not BLOCKER) |              |  (or BLOCKER severity) |
                                                              +---------+----------+              +-----------+------------+
                                                                        |                                     |
                                                                        v                                     v
                                                              +--------------------+              +------------------------+
                                                              | Show toast:        |              | severity == NONE and   |
                                                              | "Task complete"    |              | no missing items?      |
                                                              | Mark as reflected  |              +-----------+------------+
                                                              +--------------------+                          |
                                                                                               +--------------+--------------+
                                                                                               | YES                         | NO
                                                                                               v                             v
                                                                                       +---------------+          +--------------------+
                                                                                       | Show toast:   |          | Send feedback msg  |
                                                                                       | "Awaiting     |          | via prompt()       |
                                                                                       | user input"   |          | Schedule nudge     |
                                                                                       +---------------+          +--------------------+
```

## GenAI Stuck Detection Flow

When the agent appears stuck (no completion after timeout), GenAI evaluates the situation:

```
                              +------------------+
                              |  Potential stuck |
                              |  detected        |
                              +--------+---------+
                                       |
                                       v
                        +-----------------------------+
                        |  Message age >= 30 seconds? |
                        +-------------+---------------+
                                      |
                       +--------------+--------------+
                       | NO                          | YES
                       v                             v
               +---------------+          +--------------------+
               | Return:       |          | Get fast model     |
               | not stuck     |          | (Haiku, GPT-4o-mini)|
               | (too recent)  |          +---------+----------+
               +---------------+                    |
                                                    v
                                      +---------------------------+
                                      |   GENAI EVALUATION        |
                                      |   Analyze:                |
                                      |   - Last user message     |
                                      |   - Agent's response      |
                                      |   - Pending tool calls    |
                                      |   - Output tokens         |
                                      |   - Message completion    |
                                      +-----------+---------------+
                                                  |
                                                  v
                               +------------------+------------------+
                               |                  |                  |
                               v                  v                  v
                    +----------------+  +----------------+  +----------------+
                    | genuinely_     |  | waiting_for_   |  | working        |
                    | stuck          |  | user           |  | (tool running) |
                    +-------+--------+  +-------+--------+  +-------+--------+
                            |                   |                   |
                            v                   v                   v
                    +----------------+  +----------------+  +----------------+
                    | shouldNudge:   |  | shouldNudge:   |  | shouldNudge:   |
                    | TRUE           |  | FALSE          |  | FALSE          |
                    | Send continue  |  | Wait for user  |  | Let it finish  |
                    | message        |  | response       |  |                |
                    +----------------+  +----------------+  +----------------+
```

## GenAI Post-Compression Evaluation Flow

After context compression, GenAI evaluates the best action:

```
                              +------------------+
                              | session.compacted|
                              | event received   |
                              +--------+---------+
                                       |
                                       v
                        +-----------------------------+
                        |  Get session messages       |
                        |  Extract context            |
                        +-------------+---------------+
                                      |
                                      v
                        +-----------------------------+
                        |   GENAI EVALUATION          |
                        |   Analyze:                  |
                        |   - Original task(s)        |
                        |   - Last agent response     |
                        |   - Tools used (gh pr, git) |
                        |   - PR/Issue references     |
                        +-----------+-----------------+
                                    |
                                    v
               +--------------------+--------------------+
               |                    |                    |
               v                    v                    v
    +-------------------+  +------------------+  +------------------+
    | needs_github_     |  | continue_task    |  | needs_           |
    | update            |  |                  |  | clarification    |
    +--------+----------+  +--------+---------+  +--------+---------+
             |                      |                     |
             v                      v                     v
    +-------------------+  +------------------+  +------------------+
    | Nudge: "Update    |  | Nudge: Context-  |  | Nudge: "Please   |
    | PR #X with gh pr  |  | aware continue   |  | summarize state  |
    | comment"          |  | message          |  | and what's next" |
    +-------------------+  +------------------+  +------------------+
    
                              +------------------+
                              | task_complete    |
                              +--------+---------+
                                       |
                                       v
                              +------------------+
                              | Skip nudge       |
                              | Show toast only  |
                              +------------------+
```

## Post-Compression Actions

| Action | When Used | Nudge Content |
|--------|-----------|---------------|
| `needs_github_update` | Agent was working on PR/issue | Prompt to update with `gh pr comment` |
| `continue_task` | Normal task in progress | Context-aware reminder of current work |
| `needs_clarification` | Significant context loss | Ask agent to summarize state |
| `task_complete` | Task was finished | No nudge, show success toast |

## GitHub Work Detection

The plugin detects active GitHub work by looking for:

1. **Tool Usage Patterns:**
   - `gh pr create`, `gh pr comment`
   - `gh issue create`, `gh issue comment`
   - `git commit`, `git push`, `git branch`

2. **Text References:**
   - `#123` (issue/PR numbers)
   - `PR #34`, `PR34`
   - `issue #42`
   - `pull request`

## Stuck Detection Scenarios

| Scenario | Static Heuristics | GenAI Evaluation |
|----------|-------------------|------------------|
| Agent running `npm install` for 90s | False positive: flagged stuck | Correct: `working` |
| Agent asked "which database?" | False positive: flagged stuck | Correct: `waiting_for_user` |
| Agent stopped mid-sentence | Missed if tokens > 0 | Correct: `genuinely_stuck` |
| Agent listed "Next Steps" but stopped | Not detected | Correct: `genuinely_stuck` |
| Long tool execution (build, test) | False positive | Correct: `working` |

## Severity Levels

| Severity | Description | Effect |
|----------|-------------|--------|
| `NONE` | No issues found | Complete if no missing items |
| `LOW` | Cosmetic/minor issues | Push feedback |
| `MEDIUM` | Partial degradation | Push feedback |
| `HIGH` | Major functionality affected | Push feedback |
| `BLOCKER` | Security/data/production risk | Forces incomplete, push feedback |

## Key Components

### Fast Model Selection

Priority order per provider for quick evaluations:

```typescript
FAST_MODELS = {
  "anthropic": ["claude-3-5-haiku-20241022", "claude-haiku-4"],
  "openai": ["gpt-4o-mini", "gpt-3.5-turbo"],
  "google": ["gemini-2.0-flash", "gemini-1.5-flash"],
  "github-copilot": ["claude-haiku-4.5", "gpt-4o-mini"],
}
```

### Caching Strategy

| Cache | TTL | Purpose |
|-------|-----|---------|
| Fast model cache | 5 min | Avoid repeated config.providers() calls |
| Stuck evaluation cache | 60s | Avoid repeated GenAI calls for same session |
| AGENTS.md cache | 60s | Avoid re-reading project instructions |

### Anti-Loop Protections

1. **`judgeSessionIds`** - Skip judge sessions (fast path)
2. **`activeReflections`** - Prevent concurrent reflection on same session
3. **`lastReflectedMsgCount`** - Skip if already evaluated this task
4. **`abortedMsgCounts`** - Skip aborted tasks only, allow new tasks
5. **`recentlyAbortedSessions`** - Prevent race condition with session.error

## Configuration

Enable debug logging:
```bash
REFLECTION_DEBUG=1 opencode
```

Reflection data saved to:
```
<workspace>/.reflection/
  ├── <session>_<timestamp>.json  # Full evaluation data
  └── verdict_<session>.json       # Signal for TTS/Telegram
```
