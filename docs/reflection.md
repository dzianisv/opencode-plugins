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
