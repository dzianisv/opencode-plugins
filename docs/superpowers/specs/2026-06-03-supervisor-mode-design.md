# Supervisor controls for `reflection-3` (OpenCode)

**Date:** 2026-06-03
**Status:** Design — awaiting review
**Target:** `dzianisv/opencode-plugins` → `reflection-3.ts` (published as `opencode-reflection`)

## Context

Claude Code's [`/goal`](https://code.claude.com/docs/en/goal) sets a session-scoped completion
condition. After every turn a small fast model judges the transcript ("is the condition met?"). If
not, it injects another turn with the reason as guidance; when met, the goal clears. Under the hood
it is a **session-scoped, prompt-based Stop hook** whose evaluator is a *fresh, independent model*
that judges only what the worker surfaced in the transcript.

This repo's `reflection-3.ts` already implements that independent-evaluator loop (idle → judge →
re-prompt). The community OpenCode goal plugins (`willytop8/OpenCode-goal-plugin`,
`DraconDev/opencode-auto-continue`) do **not** — the former is sentinel-based and its README admits
"there is no independent evaluator," the latter is todo-driven. So we build on `reflection-3`.

This spec adds a **supervisor control surface** over the always-on reflection engine, in three parts:

1. **Configurable rubric** — move the judge's hardcoded patterns/antipatterns into user-editable files.
2. **`/supervisor:retry <n>`** — make the retry budget configurable; raise the default from 3 to **16**.
3. **`/supervisor:goal …`** — a faithful, session-scoped `/goal`.

"Reflection" = the always-on judge. "Supervisor" = the interactive control surface (rubric files +
commands) layered on it.

### What already exists in `reflection-3.ts` (reused, not rebuilt)

| Capability | Location |
| --- | --- |
| `session.idle` → `runReflection(sessionId)` loop | `reflection-3.ts:2002`, `:1667` |
| Independent judge on a throwaway session (`create`→`promptAsync`→`waitForResponse`→`delete`) | `:1747`–`:1783`, `analyzeSelfAssessmentWithLLM` `:1350` |
| Continuation injection into the main session via `client.session.promptAsync` | `:1957` |
| 3-source prompt precedence: `.reflection.md` file > `toolReflectionPrompt` > default rubric | `resolveReflectionPromptPrecedence` `:213` |
| Runtime guidance setter tool (`set-reflection`), incl. clear/read + 4000-char note | `executeSetReflection` `:1595` |
| Workflow gate inference (`requiresTests/Build/PR/CI`) by task type & repo signals | `WorkflowRequirements` `:46`, `buildTaskContext` `:972` |
| Structured judge verdict `{complete, shouldContinue, reason, severity, …}` | `ReflectionAnalysis` `:98` |
| **Hardcoded** antipatterns, duplicated in two prompt builders | `buildSelfAssessmentPrompt:1140`, `analyzeSelfAssessmentWithLLM:1400` |
| `MAX_ATTEMPTS = 3` retry cap, referenced throughout | `:25` |
| Toasts, per-session disable, attempt tracking, debug log | `showToast:541`, `.reflection/disabled:1570` |

## Goal / Non-goals

**Goal:** A configurable supervisor over `reflection-3` — user-editable rubric, a configurable retry
budget (default 16), and a session-scoped `/supervisor:goal` whose completion requires the condition
**and** all applicable workflow gates.

**Non-goals (YAGNI):** sentinels; a separate notification channel (Telegram/TTS already fire);
multiple simultaneous goals per session; a bespoke evaluator model stack (reuse the existing judge);
the Claude Code side (`claude/`).

---

## Feature 1 — Configurable rubric files

### Problem
The premature-stop antipatterns (PERMISSION-SEEKING, STOPPED-WITH-TODOS, FALSE-COMPLETE) are
hardcoded as inline template strings in **two** builders (`:1140`, `:1400`) with slightly divergent
wording. Users cannot tune them, and the duplication risks drift.

### Design
Extract the rubric into editable Markdown files with a single load path used by both builders.

- **Single file, two sections.** One `rubric.md` with `## Patterns` (positive "what 'done' looks
  like" criteria) and `## Antipatterns` (the mined premature-stop rules: PERMISSION-SEEKING,
  STOPPED-WITH-TODOS, FALSE-COMPLETE). Managed/overridden as a unit.
- **Packaged default = embedded constant.** The default lives as a `DEFAULT_RUBRIC` string constant
  (seeded verbatim from today's inline text) so behavior is preserved out of the box **and** the
  single-file `cp reflection-3.ts` install path keeps working (no shipped rubric file to lose).
  Externalizing also consolidates the two divergent inline copies into one source of truth. The
  user-facing `rubric.md` is the *override*, not a shipped artifact.
- **Override resolution** (first found wins):
  1. project: `.reflection/rubric.md`
  2. global: `~/.config/opencode/supervisor/rubric.md`
  3. embedded `DEFAULT_RUBRIC` constant
- New loader `loadRubric(directory)` → `{ patterns: string, antipatterns: string, source }`, cached
  per `runReflection` pass. It splits the file on the two `##` headings. Both
  `buildSelfAssessmentPrompt` and `analyzeSelfAssessmentWithLLM` interpolate `rubric.patterns` /
  `rubric.antipatterns` instead of inline literals.
- Malformed/empty override, or a missing section → log + fall back to the packaged default for the
  whole file (never run with an empty rubric).

This is file-based config only; no command is added for the rubric in v1 (a `/supervisor:rubric`
print/reset helper is a possible later add, deferred under YAGNI).

---

## Feature 2 — Configurable retry budget (`/supervisor:retry`)

### Problem
`MAX_ATTEMPTS = 3` (`:25`) is too low for substantial autonomous work and is not configurable.

### Design
- Rename the constant to `DEFAULT_MAX_ATTEMPTS` and **default it to 16**.
- Resolve the effective cap per session: `supervisorState.maxAttempts ?? configMaxAttempts ?? 16`,
  where `configMaxAttempts` comes from `~/.config/opencode/reflection.yaml` (existing file, `:132`).
- **`/supervisor:retry <n>`** sets the per-session override (clamped to a sane range, e.g. 1–100);
  `/supervisor:retry` with no arg reports the current effective value via toast.
- This single cap governs **all** reflection re-prompts (with or without a goal). The goal loop uses
  the same budget — no second turn counter. `maxTokens` / `maxDurationMs` remain as optional
  secondary safety caps (config-only) so a runaway loop still terminates on spend/time.

---

## Feature 3 — `/supervisor:goal` (session-scoped goal)

### What it adds over the existing `set-reflection` tool
1. A **user-typed command** (`/supervisor:goal …`) rather than an agent-only tool.
2. **Session-scoped persistence + resume** (vs the in-memory `toolReflectionPrompt` `let`).
3. **Budget**: reuses the Feature-2 retry budget + secondary token/time caps.
4. **Auto-clear on achieve + status**, with the condition enforced as a mandatory completion
   requirement.

### Completion semantics (decision: "goal AND all applicable gates")
One judge call: when a goal is active, the condition is injected into the prompt as a top-priority
*mandatory completion requirement*, on top of the default rubric (which already encodes the
applicable gates). The resulting `ReflectionAnalysis.complete` means "applicable gates pass **and**
the condition is met." Gates are the *applicable* ones the engine already infers — a docs-only goal
won't require a PR/CI. If `complete` is false, the loop continues with the existing feedback
(`analysis.reason` + `analysis.missing`).

### Precedence (additive, not replacement)
A goal does not swap out the judge prompt (that would drop the gates). While a goal is active the
prompt is `rubric (patterns + antipatterns) + buildGoalRequirementSection(condition)`, and the
`.reflection.md` / `toolReflectionPrompt` overrides are bypassed (the goal is the strongest expressed
intent and must compose with the gates). With no goal active, existing precedence is unchanged.

### Command surface (mirrors CC)
- `/supervisor:goal <condition>` — set/replace the session goal and start working (≤ 4000 chars)
- `/supervisor:goal` — status toast: condition, status, attempts used / budget, last reason
- `/supervisor:goal clear` (aliases `stop`/`off`/`reset`/`none`/`cancel`) — clear the active goal

---

## Components

### A. `supervisorStore` (new, isolated)
Per-session state at `.reflection/supervisor/<sessionId>.json` (`0600`):

```jsonc
{
  "maxAttempts": 16,            // /supervisor:retry override (optional; else config/default)
  "goal": {
    "condition": "all tests in test/auth pass and lint is clean",
    "status": "active",        // active | paused | achieved | cleared | exhausted
    "attempts": 0,             // shared with the reflection retry counter
    "tokenBaseline": 0,
    "startedAt": 0,
    "deadline": 0,
    "lastReason": ""
  }
}
```
API: `load(sid)`, `save(sid, state)`, `setGoal/clearGoal(sid)`, `setRetry(sid, n)`, `list()`.

### B. Rubric loader (new) — Feature 1, as above.

### C. `/supervisor:*` command capture (new)
Shipped as OpenCode commands under the `supervisor` namespace (mapping `supervisor:goal` /
`supervisor:retry` to OpenCode's command-namespacing convention — **to verify**: subdirectory
`.opencode/command/supervisor/{goal,retry}.md` vs a colon-named file vs `opencode.json` `command`
entries). **Capture mechanism — spike first:** prefer the `command.executed` event if it carries the
command name + raw args (deterministic, no transcript parsing); fall back to a control-marker in the
command template that the plugin scans from the user message.

### D. `buildGoalRequirementSection(condition)` (new)
Prompt fragment appended to the loaded `rubric` (patterns + antipatterns) when a goal is active; states the
condition as mandatory and reinforces the evidence rules. Feeds the **existing** throwaway-session
judge — one call, no new model stack, no separate `goalMet` field (folded into `complete`).

### E. Loop integration in `runReflection` (modified)
1. Load `supervisorState`. Effective cap = `state.maxAttempts ?? config ?? 16`.
2. If a goal is `active`: **budget gate first** — if `attempts >= cap`, or `spend >= maxTokens`, or
   `now >= deadline` → `status = "exhausted"`, persist, toast, **return without continuing**.
3. Build prompt (with goal-requirement section if a goal is active) → run independent judge.
4. **Complete** → if a goal is active, set `status = "achieved"`, persist, `✓` toast; stop.
5. **Not complete** → increment `attempts` (shared counter), persist, inject continuation via the
   existing `client.session.promptAsync` (feedback = `reason` + `missing` + remaining budget).

With no goal, behavior is the prior reflection flow but with the cap now defaulting to 16 and
honoring `/supervisor:retry`.

### F. Resume behavior
A persisted goal restores **active** on resume (faithful to CC); `attempts`/`deadline`/`tokenBaseline`
reset (matches CC counter reset), so the loop re-enters on the next `session.idle`. A
`supervisorResumePaused` config flag (default false) can opt into restoring paused for the cautious.
`maxAttempts` overrides persist across resume. Achieved/cleared goals are not restored.

### G. Config knobs
`~/.config/opencode/reflection.yaml` (+ env): `maxAttempts` (16), `goalMaxTokens` (400000),
`goalMaxDurationMs` (1800000), `supervisorResumePaused` (false), rubric override path (implicit via
the resolution order above).

## Data flow

```
user: /supervisor:goal <cond>           user: /supervisor:retry 16
  → capture → supervisorStore.setGoal      → capture → supervisorStore.setRetry(sid,16)
  → agent works ... session.idle
  → runReflection(sid):
       cap = state.maxAttempts ?? config ?? 16
       goal active & budget exceeded? → pause + toast → STOP
       else → rubric (patterns + antipatterns) [+ goal requirement] → independent judge
              → ReflectionAnalysis.complete (gates [AND condition])
       complete? → (goal) achieved + ✓ toast → STOP
       else → attempts++, persist → promptAsync(main session, reason+missing+budget)
  → loop until complete or budget exhausted
```

## Error handling
- **Judge failure/timeout** (`JUDGE_RESPONSE_TIMEOUT`): never clear a goal and never inject on a
  failed judge — log + skip this idle (fail safe; never falsely "achieve").
- **Empty rubric / corrupt state file**: fall back to packaged default rubric / treat as no goal; log.
- **Continuation = a user turn** via `promptAsync` — provider-safe; avoids the `github-copilot`
  prefill-400 and the empty-continuation race (opencode issue #15267). README recommends the
  `anthropic` provider for long unattended runs.
- **Session deleted mid-loop** (existing guard `:1684`): clear in-memory tracking; leave files for resume.
- Concurrency: reuse the `activeReflections` guard `:1669`.

## Testing & eval
- **Unit:** `supervisorStore` round-trip (goal + retry) and clear; rubric loader precedence
  (project > global > packaged) and empty-file fallback; effective-cap resolution
  (`/supervisor:retry` > config > 16); budget gate (attempts/tokens/deadline);
  `buildGoalRequirementSection` composes onto the rubric and bypasses file/tool overrides while
  active; idempotent continuation under `activeReflections`.
- **Behavioral / eval:** reuse the repo's promptfoo harness + labeled CC-stop dataset. Key criterion
  is **C5 / verification-theater**: a bare "condition met" claim with no evidence (tests not run)
  must yield `complete=false` and the goal must **not** clear. Fixtures: (a) condition met with
  evidence → achieves; (b) bare claim → continues; (c) budget exhausted → pauses, no continuation;
  (d) editing the `## Antipatterns` section of `rubric.md` changes the judge's verdict (proves the
  rubric is live-configurable).
- **Integration:** existing `test/e2e.test.ts` style — set a goal, drive idle events, assert
  continuation until complete, then auto-clear; `/supervisor:retry 1` caps the loop at one attempt.

## Open items (resolve in implementation, not design)
1. OpenCode command namespacing for `supervisor:goal` / `supervisor:retry` (subdir vs colon vs config entry).
2. `command.executed` payload (args available?) vs control-marker fallback — spike first.
3. Whether per-goal `--max-turns`/`--max-tokens` flags are worth parsing in v1 or config-only.

## Out of scope
Sentinels; multi-goal stacking; new notification channels; a separate evaluator model; a
`/supervisor:rubric` command (v2); the Claude Code `claude/` runtime.
