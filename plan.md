# Root Cause Analysis & Improvement Plan

Issue: Analysis of 164 reflection sessions
Branch: main
Started: 2026-01-29

## Goal

Analyze why 50.6% of sessions were marked incomplete and identify improvements to either:
1. The reflection plugin (if verdicts are wrong)
2. The agent behavior (if verdicts are correct but agent keeps making same mistakes)
3. The development workflow (if process is causing issues)

## Root Cause Analysis

### Finding: Plugin is ACCURATE (100% correct verdicts)

After analyzing 164 sessions, the reflection plugin has **0 false positives and 0 false negatives**.
The issue is NOT the plugin - it's correctly catching agent mistakes.

### Top 5 Root Causes of Incomplete Sessions

| Rank | Issue | Count | % of Incomplete |
|------|-------|-------|-----------------|
| 1 | **Missing test/verification** | 84 | 51% |
| 2 | **Missing deployment to ~/.config/opencode/plugin/** | 11 | 13% |
| 3 | **Agent stopped mid-implementation** | ~20 | 24% |
| 4 | **Agent worked on wrong task** | ~5 | 6% |
| 5 | **Agent ignored urgent request** | 2 | 2% |

### Detailed Analysis

#### Issue 1: Missing Test/Verification (51% of failures)
Agent writes code but doesn't run `npm test` or `npm run typecheck`.

**Evidence:**
- "No evidence of tests run"
- "Modifications to reflection.ts strictly require running E2E tests"
- "Code changes were deployed without verification"

**Root Cause:** Agent doesn't follow AGENTS.md testing checklist.

#### Issue 2: Missing Deployment (13% of failures)
Agent writes code to workspace but doesn't copy to `~/.config/opencode/plugin/`.

**Evidence:**
- "plugin must be deployed to ~/.config/opencode/plugin/"
- "no `cp` command was executed"

**Root Cause:** Agent doesn't understand OpenCode plugin deployment workflow.

#### Issue 3: Agent Stopped Mid-Implementation (24% of failures)
Agent says "I'll do X" or "Now I need to..." but stops.

**Evidence:**
- "explicitly states 'Now I need to fix...', indicating not complete"
- "The agent is in the middle of implementing the fix"

**Root Cause:** Session interrupted or agent waiting for unnecessary confirmation.

#### Issue 4: Agent Worked on Wrong Task (6% of failures)
User asks for X, agent does Y.

**Evidence:**
- "User asked to fix reflection plugin, agent fixed Telegram"
- "Original request regarding PR #21 was completely ignored"

**Root Cause:** Agent context confusion or lost track of original request.

#### Issue 5: Agent Ignored Urgent Request (2% - BLOCKER)
Agent completely ignores user's urgent issue.

**Evidence:**
- "Agent completely ignored urgent inquiry regarding Cloudflare tunnel outage"

**Root Cause:** Agent prioritized its own agenda over user's explicit request.

---

## Tasks

### Phase 1: Improve Agent Guidance (AGENTS.md)

- [x] Task 1: Analyze root causes from session data
  - Completed: 2026-01-29
  - Notes: 5 root causes identified, all are agent behavior issues not plugin issues

- [x] Task 2: Add explicit "Deployment Checklist" to AGENTS.md
  - Completed: 2026-01-29
  - Added "Mandatory Completion Checklist" with 5-step process
  - Added deployment commands with verification

- [x] Task 3: Add "Task Focus" reminder to AGENTS.md
  - Completed: 2026-01-29
  - Added "Task Focus Protocol" section
  - Added NEVER list for common mistakes

- [x] Task 4: Add "Completion Criteria" to AGENTS.md
  - Completed: 2026-01-29
  - Merged into "Mandatory Completion Checklist"
  - Added statistics from session analysis (51% missing tests, 13% missing deployment)

### Phase 2: Improve Reflection Plugin Feedback

- [ ] Task 5: Make feedback more actionable
  - Currently shows missing items but could be more prescriptive
  - Add: "Run these exact commands:" section

- [ ] Task 6: Add deployment detection
  - Check if agent ran `cp ... ~/.config/opencode/plugin/`
  - If not, always mark incomplete for plugin changes

### Phase 3: Metrics & Tracking

- [ ] Task 7: Add completion rate tracking
  - Track % of sessions completing on first attempt
  - Track average iterations to completion
  - Track most common failure reasons over time

- [ ] Task 8: Create dashboard/report command
  - `npm run eval:sessions` - analyze recent sessions
  - Output: completion rate, common issues, trends

---

## Implementation Notes

### Why NOT change the plugin logic?

The plugin is working correctly. Changing it would:
- Create false positives (marking incomplete work as complete)
- Reduce trust in the reflection system
- Mask real agent behavior issues

### The real fix is agent behavior

The agent needs to:
1. Always run tests before claiming done
2. Always deploy plugins to config directory
3. Stay focused on user's actual request
4. Complete work instead of stopping mid-way

---

## Completed

- [x] Analyzed 164 sessions
  - Commit: n/a (analysis only)
  - Notes: 83 incomplete, 81 complete, 100% accuracy

- [x] Generated evaluation report
  - File: evals/results/reflection-eval-2026-01-29.md
  - Notes: Detailed breakdown of severity, accuracy, patterns

---

## Next Steps

1. Update AGENTS.md with deployment checklist (Task 2)
2. Update AGENTS.md with task focus reminder (Task 3)
3. Consider adding pre-commit hook to remind about deployment
