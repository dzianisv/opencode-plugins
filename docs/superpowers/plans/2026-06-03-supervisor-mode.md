# Supervisor controls for `reflection-3` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable "supervisor" control surface over the always-on `reflection-3` judge: a user-editable rubric, a configurable retry budget (default 16), and a session-scoped `/supervisor:goal` whose completion requires the condition **and** all applicable workflow gates.

**Architecture:** All new logic is added as **exported functions in `reflection-3.ts`** (single source file; `packages/reflection/reflection-3.ts` is a symlink to it). New functions are imported **directly** in tests from `../reflection-3.ts` (the `detectPlanningLoop` pattern), bypassing the `reflection-3.test-helpers.ts` duplication. The default rubric is an **embedded constant** (preserves the single-file `cp` install). Continuation stays a user turn via `client.session.promptAsync` (provider-safe). Spec: `docs/superpowers/specs/2026-06-03-supervisor-mode-design.md`.

**Tech Stack:** TypeScript (ESM), `@opencode-ai/plugin`, Jest + ts-jest (ESM preset), promptfoo evals.

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `reflection-3.ts` | plugin runtime; hosts new `DEFAULT_RUBRIC`, `loadRubric`, `supervisorStore`, `buildGoalRequirementSection`, cap resolution, command capture, loop integration | Modify |
| `test/supervisor.unit.test.ts` | unit tests for rubric loader, store, cap resolution, goal requirement section | Create |
| `test/supervisor.integration.test.ts` | idle-loop integration (mocked client): goal continues → achieves → clears; retry cap | Create |
| `.opencode/command/supervisor/goal.md`, `…/retry.md` (or `opencode.json` entries) | the `/supervisor:*` command surface | Create (per Phase 0 finding) |
| `evals/prompts/task-verification.txt` + `evals/datasets/*` | add goal/verification-theater fixtures | Modify |
| `README.md` | document supervisor commands, rubric override, retry | Modify |

---

## Phase 0 — Spikes (resolve OpenCode API unknowns)

These gate the command-capture code only. Rubric/retry/store phases do **not** depend on them and can proceed in parallel.

### Task 0.1: Spike command namespacing + arg capture

- [ ] **Step 1:** Create a throwaway probe plugin `/tmp/probe/probe.ts` that logs every `event.type` and full `event.properties` to a file, and registers a `command.executed` log.
- [ ] **Step 2:** Add commands two ways and see which produces `/supervisor:goal`: (a) `.opencode/command/supervisor/goal.md`; (b) `opencode.json` `command["supervisor:goal"]`. Run `opencode` and invoke each.
- [ ] **Step 3:** Record in the issue: does `command.executed` carry `{name, arguments}` for the invoked command? Does a `supervisor`-namespaced command appear as `/supervisor:goal`?
- [ ] **Step 4:** Decide capture mechanism: **A)** `command.executed` event (preferred, deterministic) or **B)** control-marker in the command template parsed from the user message. Document the choice + payload shape in the issue before Phase 4.

**Acceptance:** issue comment states the namespacing mechanism, the `command.executed` payload (or its absence), and the chosen capture path with a concrete example.

---

## Phase 1 — Configurable rubric (no API dependency)

### Task 1.1: Extract inline antipatterns into `DEFAULT_RUBRIC`

**Files:** Modify `reflection-3.ts` (near `:25`); source text from `:1140`–`:1143` (self-assessment) and `:1400`–`:1403` (judge).

- [ ] **Step 1: Write failing test** — `test/supervisor.unit.test.ts`:
```ts
import assert from "node:assert"
import { describe, it } from "@jest/globals"
import { DEFAULT_RUBRIC, parseRubric } from "../reflection-3.ts"

describe("rubric", () => {
  it("DEFAULT_RUBRIC has both sections and the mined antipatterns", () => {
    const r = parseRubric(DEFAULT_RUBRIC)
    assert.ok(r.patterns.length > 0, "patterns section present")
    assert.match(r.antipatterns, /PERMISSION-SEEKING/)
    assert.match(r.antipatterns, /STOPPED-WITH-TODOS/)
    assert.match(r.antipatterns, /FALSE-COMPLETE/)
  })
})
```
- [ ] **Step 2: Run, verify fail** — `npx jest test/supervisor.unit.test.ts -t rubric` → FAIL (`DEFAULT_RUBRIC`/`parseRubric` not exported).
- [ ] **Step 3: Implement** — add to `reflection-3.ts`:
```ts
export const DEFAULT_RUBRIC = `## Patterns
<verbatim positive-completion framing extracted from the requirement text in buildSelfAssessmentPrompt :1082-1092>

## Antipatterns
<verbatim PREMATURE-STOP ANTIPATTERNS block extracted from :1140-1143>`

export function parseRubric(md: string): { patterns: string; antipatterns: string } {
  const section = (name: string) => {
    const re = new RegExp(`##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
    return (md.match(re)?.[1] ?? "").trim()
  }
  return { patterns: section("Patterns"), antipatterns: section("Antipatterns") }
}
```
Copy the antipattern text **verbatim** from the two existing inline blocks (use the more complete `:1140` wording).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(supervisor): extract default rubric into embedded constant"`

### Task 1.2: `loadRubric(directory)` with override precedence

- [ ] **Step 1: Failing test:**
```ts
import { loadRubric } from "../reflection-3.ts"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"; import { join } from "node:path"

it("project .reflection/rubric.md overrides default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rub-"))
  mkdirSync(join(dir, ".reflection"), { recursive: true })
  writeFileSync(join(dir, ".reflection/rubric.md"), "## Patterns\nP\n## Antipatterns\nMY-RULE")
  const r = await loadRubric(dir)
  assert.strictEqual(r.source, "project")
  assert.match(r.antipatterns, /MY-RULE/)
})
it("falls back to default when no override / empty file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rub-"))
  const r = await loadRubric(dir)
  assert.strictEqual(r.source, "default")
  assert.match(r.antipatterns, /PERMISSION-SEEKING/)
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `loadRubric(directory)`: try `${directory}/.reflection/rubric.md` (source `project`) → `~/.config/opencode/supervisor/rubric.md` (source `global`) → `DEFAULT_RUBRIC` (source `default`). `parseRubric` each; if either section empty, fall through to default. Return `{ patterns, antipatterns, source }`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.**

### Task 1.3: Wire `loadRubric` into both prompt builders

**Files:** `reflection-3.ts` `buildSelfAssessmentPrompt:1053`, `analyzeSelfAssessmentWithLLM:1350`, call site `runReflection:1717`.

- [ ] **Step 1: Failing test** — `buildSelfAssessmentPrompt` accepts a `rubric` arg and interpolates `rubric.antipatterns`:
```ts
const prompt = buildSelfAssessmentPrompt(ctx, "AGENTS", "last", 0, { patterns: "PP", antipatterns: "ZZ-RULE" })
assert.match(prompt, /ZZ-RULE/)
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add optional `rubric` param to both builders, replace the inline antipattern literals with `${rubric.antipatterns}` / `${rubric.patterns}`; default the param to `parseRubric(DEFAULT_RUBRIC)` for back-compat. In `runReflection`, call `const rubric = await loadRubric(directory)` once and thread it into both builders (and the judge path `:1717`).
- [ ] **Step 4: Run** full unit suite + `npm run typecheck`; verify pass.
- [ ] **Step 5: Commit** — `feat(supervisor): load rubric from file with default fallback`

---

## Phase 2 — Configurable retry budget

### Task 2.1: `DEFAULT_MAX_ATTEMPTS = 16` + cap resolver

**Files:** `reflection-3.ts:25` (`MAX_ATTEMPTS`), `reflection.yaml` loader (`loadRoutingConfig:765` area).

- [ ] **Step 1: Failing test:**
```ts
import { resolveMaxAttempts } from "../reflection-3.ts"
it("session override > config > default 16", () => {
  assert.strictEqual(resolveMaxAttempts({ sessionOverride: 5, config: 30 }), 5)
  assert.strictEqual(resolveMaxAttempts({ sessionOverride: undefined, config: 30 }), 30)
  assert.strictEqual(resolveMaxAttempts({}), 16)
})
it("clamps to 1..100", () => {
  assert.strictEqual(resolveMaxAttempts({ sessionOverride: 0 }), 1)
  assert.strictEqual(resolveMaxAttempts({ sessionOverride: 999 }), 100)
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — rename const to `DEFAULT_MAX_ATTEMPTS = 16`; add `resolveMaxAttempts({sessionOverride?, config?})` clamped to `[1,100]`. Read `maxAttempts` from `reflection.yaml` in the config loader.
- [ ] **Step 4:** Replace the hardcoded `MAX_ATTEMPTS` use at `:1927`/`:1929`/`:1080` with an `effectiveMaxAttempts` resolved per session (computed in `runReflection`, passed where needed).
- [ ] **Step 5: Run, verify pass + typecheck. Commit** — `feat(supervisor): make retry budget configurable, default 16`

---

## Phase 3 — `supervisorStore` (per-session state)

### Task 3.1: Store round-trip

**Files:** `reflection-3.ts`; state at `${directory}/.reflection/supervisor/<sid>.json`.

- [ ] **Step 1: Failing test:**
```ts
import { supervisorStore } from "../reflection-3.ts"
it("saves and loads goal + retry, clears goal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sup-"))
  await supervisorStore.setRetry(dir, "s1", 12)
  await supervisorStore.setGoal(dir, "s1", "tests pass")
  let st = await supervisorStore.load(dir, "s1")
  assert.strictEqual(st.maxAttempts, 12)
  assert.strictEqual(st.goal?.status, "active")
  await supervisorStore.clearGoal(dir, "s1")
  st = await supervisorStore.load(dir, "s1")
  assert.strictEqual(st.goal, undefined)
  assert.strictEqual(st.maxAttempts, 12) // retry survives goal clear
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `supervisorStore` object: `load`, `save`, `setGoal` (init `{condition,status:"active",attempts:0,tokenBaseline:0,startedAt:Date.now(),deadline:Date.now()+maxDurationMs,lastReason:""}`), `clearGoal`, `setRetry`, `list`. Files `0600`; corrupt JSON → `{}`. Mkdir `.reflection/supervisor` on save.
- [ ] **Step 4: Run, verify pass. Commit** — `feat(supervisor): per-session goal+retry store`

---

## Phase 4 — `/supervisor:*` command capture (after Phase 0)

### Task 4.1: Ship the commands

- [ ] **Step 1:** Per Phase-0 finding, create `.opencode/command/supervisor/goal.md` and `retry.md` (or `opencode.json` entries). Template carries `$ARGUMENTS`; if capture path B, prefix a control marker (e.g. `<!--supervisor:goal-->`).
- [ ] **Step 2:** Document install in README.
- [ ] **Step 3: Commit** — `feat(supervisor): add /supervisor:goal and /supervisor:retry commands`

### Task 4.2: Capture handler

**Files:** `reflection-3.ts` `event` handler (`:1990`), parser `parseSupervisorCommand`.

- [ ] **Step 1: Failing test** for the pure parser:
```ts
import { parseSupervisorCommand } from "../reflection-3.ts"
assert.deepStrictEqual(parseSupervisorCommand("goal", "tests pass"), { kind: "goal-set", condition: "tests pass" })
assert.deepStrictEqual(parseSupervisorCommand("goal", ""), { kind: "goal-status" })
assert.deepStrictEqual(parseSupervisorCommand("goal", "clear"), { kind: "goal-clear" })
assert.deepStrictEqual(parseSupervisorCommand("retry", "12"), { kind: "retry-set", n: 12 })
assert.deepStrictEqual(parseSupervisorCommand("retry", ""), { kind: "retry-status" })
```
Aliases for clear: `stop|off|reset|none|cancel`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `parseSupervisorCommand(name, args)`; then in the `event` handler, on the captured command (path A: `command.executed`; path B: scan latest user message for the marker), call `supervisorStore.setGoal/clearGoal/setRetry` and `showToast` the status. Condition clamped to 4000 chars.
- [ ] **Step 4: Run, verify pass. Commit** — `feat(supervisor): capture /supervisor commands into store`

---

## Phase 5 — Goal loop integration

### Task 5.1: `buildGoalRequirementSection`

- [ ] **Step 1: Failing test:**
```ts
import { buildGoalRequirementSection } from "../reflection-3.ts"
const s = buildGoalRequirementSection("all tests in test/auth pass")
assert.match(s, /MANDATORY/i)
assert.match(s, /all tests in test\/auth pass/)
assert.match(s, /evidence/i)  // reinforces no-false-complete
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — returns a prompt fragment marking the condition as a mandatory completion requirement, restating that claims need transcript evidence. Appended after `rubric.antipatterns` in both builders when a goal is active.
- [ ] **Step 4: Run, verify pass. Commit.**

### Task 5.2: Integrate into `runReflection`

**Files:** `reflection-3.ts` `runReflection:1667`, budget gate before judge, completion + continuation at `:1925`–`:1976`.

- [ ] **Step 1: Failing integration test** — `test/supervisor.integration.test.ts` with a mocked `client` (mirror `test/reflection.test.ts` mock): a session with an active goal whose judge verdict is `complete:false` triggers `client.session.promptAsync`; verdict `complete:true` sets goal `status:"achieved"` (assert via `supervisorStore.load`) and injects **no** continuation; `attempts >= effectiveMaxAttempts` sets `status:"exhausted"` and injects nothing.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** in `runReflection`:
  - load `supervisorState`; `effectiveMaxAttempts = resolveMaxAttempts({sessionOverride: state.maxAttempts, config})`.
  - if `state.goal?.status === "active"`: **budget gate first** — if `goal.attempts >= effectiveMaxAttempts` || tokens/deadline exceeded → set `status:"exhausted"`, save, toast, `return`.
  - thread `buildGoalRequirementSection(goal.condition)` into the prompt builders (Task 5.1).
  - on `analysis.complete` with active goal → set `status:"achieved"`, save, `✓` toast, `return` (no continuation).
  - on continuation, increment `goal.attempts` alongside the existing `attempts` map and persist; reuse existing `promptAsync` block.
- [ ] **Step 4: Run** integration + unit + `npm test` + typecheck; verify pass.
- [ ] **Step 5: Commit** — `feat(supervisor): goal loop — gates AND condition, auto-clear on achieve`

### Task 5.3: Resume active

- [ ] **Step 1: Failing test** — a persisted `active` goal loaded fresh stays `active` with `attempts` reset to 0 (unless `supervisorResumePaused`).
- [ ] **Step 2–4:** Implement reset-on-load (attempts/deadline/tokenBaseline) honoring `supervisorResumePaused` (default false). Run, verify, commit.

---

## Phase 6 — Evals & docs

### Task 6.1: Verification-theater fixtures
- [ ] Add promptfoo cases to `evals/` (or a new `evals/supervisor-goal.yaml`): (a) condition met **with** test evidence → judge `complete:true`; (b) bare "done" claim, no evidence → `complete:false`; (c) editing the `## Antipatterns` section of a fixture `rubric.md` flips the verdict.
- [ ] Run `npm run eval:judge` (or the new config); record pass rate in the issue. Commit.

### Task 6.2: README
- [ ] Document `/supervisor:goal`, `/supervisor:retry`, rubric override (`rubric.md` resolution order), resume behavior, and the `anthropic`-provider recommendation for long unattended runs. Commit.

---

## Self-review (spec coverage)

- Feature 1 (configurable rubric) → Phase 1 ✓ (embedded default, file override, both builders).
- Feature 2 (retry 16 + `/supervisor:retry`) → Phase 2 + 4 ✓.
- Feature 3 (`/supervisor:goal`, gates AND condition, auto-clear, resume active) → Phases 3–5 ✓.
- Independent-evaluator reuse → Phase 5 uses the existing throwaway-session judge (no new model stack) ✓.
- C5 / verification-theater eval → Phase 6 ✓.
- Provider-safe continuation (user turn) → reuses existing `promptAsync` at `:1957` ✓.

**Open items intentionally deferred to Phase 0 spike (not placeholders):** exact command namespacing + `command.executed` payload. All other steps are concrete and code-complete.
