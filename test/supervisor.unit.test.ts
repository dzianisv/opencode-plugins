import assert from "node:assert"
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_RUBRIC, parseRubric, loadRubric, buildSelfAssessmentPrompt, buildJudgePrompt, resolveMaxAttempts, buildEscalatingFeedback, supervisorStore, parseSupervisorCommand, buildGoalRequirementSection } from "../reflection-3.ts"

describe("supervisorStore", () => {
  it("saves and loads goal + retry, clears goal but keeps retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    await supervisorStore.setRetry(dir, "s1", 12)
    await supervisorStore.setGoal(dir, "s1", "tests pass", { now: 1000, maxDurationMs: 5000 })
    let st = await supervisorStore.load(dir, "s1")
    assert.strictEqual(st.maxAttempts, 12)
    assert.strictEqual(st.goal?.status, "active")
    assert.strictEqual(st.goal?.condition, "tests pass")
    assert.strictEqual(st.goal?.deadline, 6000)
    await supervisorStore.clearGoal(dir, "s1")
    st = await supervisorStore.load(dir, "s1")
    assert.strictEqual(st.goal, undefined)
    assert.strictEqual(st.maxAttempts, 12) // retry survives goal clear
  })
  it("load returns {} for missing/corrupt files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    assert.deepStrictEqual(await supervisorStore.load(dir, "nope"), {})
    mkdirSync(join(dir, ".reflection", "supervisor"), { recursive: true })
    writeFileSync(join(dir, ".reflection", "supervisor", "bad.json"), "{not json")
    assert.deepStrictEqual(await supervisorStore.load(dir, "bad"), {})
  })
  it("list returns session ids with state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    assert.deepStrictEqual(await supervisorStore.list(dir), [])
    await supervisorStore.setRetry(dir, "alpha", 4)
    await supervisorStore.setRetry(dir, "beta", 4)
    const ids = (await supervisorStore.list(dir)).sort()
    assert.deepStrictEqual(ids, ["alpha", "beta"])
  })
  it("writes files with 0600 perms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    await supervisorStore.setRetry(dir, "s1", 4)
    const { statSync } = await import("node:fs")
    const mode = statSync(join(dir, ".reflection", "supervisor", "s1.json")).mode & 0o777
    assert.strictEqual(mode, 0o600)
  })

  it("I-1: enforces 0600 on update (not just create)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    // Create the file initially
    await supervisorStore.setRetry(dir, "s1", 4)
    const filePath = join(dir, ".reflection", "supervisor", "s1.json")
    // Widen perms to 0o644 to simulate an externally widened file
    chmodSync(filePath, 0o644)
    assert.strictEqual(statSync(filePath).mode & 0o777, 0o644, "test setup: perms widened")
    // A subsequent save must restore 0600
    await supervisorStore.setRetry(dir, "s1", 7)
    const mode = statSync(filePath).mode & 0o777
    assert.strictEqual(mode, 0o600, "save must restore 0600 on existing file")
  })

  it("I-2: rejects sessionId with path-traversal characters on write paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    await assert.rejects(() => supervisorStore.save(dir, "../evil", {}), /Invalid sessionId/)
    await assert.rejects(() => supervisorStore.setRetry(dir, "a/b", 3), /Invalid sessionId/)
    await assert.rejects(() => supervisorStore.setGoal(dir, "", "cond"), /Invalid sessionId/)
    await assert.rejects(() => supervisorStore.clearGoal(dir, ".."), /Invalid sessionId/)
  })

  it("I-2: load still returns {} for a legitimate missing file (guard does not interfere)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    const result = await supervisorStore.load(dir, "missing-but-safe")
    assert.deepStrictEqual(result, {})
  })

  it("M-2: list() skips subdirectories, only counts .json files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    await supervisorStore.setRetry(dir, "alpha", 4)
    // Create a subdirectory inside the supervisor dir — list() must skip it
    const supDir = join(dir, ".reflection", "supervisor")
    mkdirSync(join(supDir, "subdir.json"), { recursive: true })
    const ids = await supervisorStore.list(dir)
    assert.deepStrictEqual(ids, ["alpha"], "subdirectory named *.json must not appear in list()")
  })

  it("M-4: setGoal over an existing goal replaces condition, preserves retry, resets attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"))
    await supervisorStore.setRetry(dir, "s", 7)
    await supervisorStore.setGoal(dir, "s", "first", { now: 1000 })
    await supervisorStore.setGoal(dir, "s", "second", { now: 2000 })
    const st = await supervisorStore.load(dir, "s")
    assert.strictEqual(st.goal?.condition, "second", "goal should be replaced with second")
    assert.strictEqual(st.maxAttempts, 7, "retry must survive goal replacement")
    assert.strictEqual(st.goal?.attempts, 0, "attempts must reset on new goal")
  })
})

describe("supervisor: resolveMaxAttempts", () => {
  it("session override > config > default 16", () => {
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: 5, config: 30 }), 5)
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: undefined, config: 30 }), 30)
    assert.strictEqual(resolveMaxAttempts({}), 16)
  })
  it("clamps to 1..100", () => {
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: 0 }), 1)
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: 999 }), 100)
    assert.strictEqual(resolveMaxAttempts({ config: -4 }), 1)
  })
  it("ignores NaN/non-finite and falls through", () => {
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: NaN, config: 20 }), 20)
  })
  it("Infinity sessionOverride is non-finite so falls through to config", () => {
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: Infinity, config: 20 }), 20)
  })
  it("float sessionOverride is floored and clamped", () => {
    assert.strictEqual(resolveMaxAttempts({ sessionOverride: 1.9 }), 1)
  })
})

describe("supervisor: rubric", () => {
  it("DEFAULT_RUBRIC has both sections and the mined antipatterns", () => {
    const r = parseRubric(DEFAULT_RUBRIC)
    assert.ok(r.patterns.length > 0, "patterns section present")
    assert.match(r.antipatterns, /PERMISSION-SEEKING/)
    assert.match(r.antipatterns, /STOPPED-WITH-TODOS/)
    assert.match(r.antipatterns, /FALSE-COMPLETE/)
  })

  it("parseRubric splits on the two headings", () => {
    const r = parseRubric("## Patterns\nP-BODY\n## Antipatterns\nA-BODY")
    assert.strictEqual(r.patterns, "P-BODY")
    assert.strictEqual(r.antipatterns, "A-BODY")
  })

  it("project .reflection/rubric.md overrides default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rub-"))
    mkdirSync(join(dir, ".reflection"), { recursive: true })
    writeFileSync(join(dir, ".reflection/rubric.md"), "## Patterns\nP\n## Antipatterns\nMY-RULE")
    const r = await loadRubric(dir)
    assert.strictEqual(r.source, "project")
    assert.match(r.antipatterns, /MY-RULE/)
  })

  it("falls back to default when no override exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rub-"))
    const r = await loadRubric(dir)
    assert.strictEqual(r.source, "default")
    assert.match(r.antipatterns, /PERMISSION-SEEKING/)
  })

  it("falls back to default when override is missing a section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rub-"))
    mkdirSync(join(dir, ".reflection"), { recursive: true })
    writeFileSync(join(dir, ".reflection/rubric.md"), "## Patterns\nonly patterns, no antipatterns heading")
    const r = await loadRubric(dir)
    assert.strictEqual(r.source, "default")
    assert.match(r.antipatterns, /FALSE-COMPLETE/)
  })
})

describe("supervisor: buildSelfAssessmentPrompt rubric interpolation", () => {
  it("buildSelfAssessmentPrompt interpolates the provided rubric antipatterns", () => {
    const ctx = {
      taskSummary: "x", taskType: "coding", agentMode: "build",
      requiresTests: false, requiresBuild: false, requiresPR: false, requiresCI: false,
      requiresLocalTests: false, requiresLocalTestsEvidence: false,
      humanMessages: [], toolsSummary: "none", detectedSignals: [], recentCommands: [],
      pushedToDefaultBranch: false,
    } as any
    const prompt = buildSelfAssessmentPrompt(ctx, "AGENTS", "last response", 0, { patterns: "PP-RULE", antipatterns: "ZZ-RULE" })
    assert.match(prompt, /ZZ-RULE/)
    assert.match(prompt, /PP-RULE/)
  })

  it("buildSelfAssessmentPrompt uses maxAttempts as the denominator in attempt history", () => {
    const ctx = {
      taskSummary: "x", taskType: "coding", agentMode: "build",
      requiresTests: false, requiresBuild: false, requiresPR: false, requiresCI: false,
      requiresLocalTests: false, requiresLocalTestsEvidence: false,
      humanMessages: [], toolsSummary: "none", detectedSignals: [], recentCommands: [],
      pushedToDefaultBranch: false,
    } as any
    const prompt = buildSelfAssessmentPrompt(ctx, "", undefined, 1, undefined, 50)
    assert.ok(prompt.includes("/50"), "should show /50 not /16")
    assert.ok(!prompt.includes("/16"), "should NOT show the old default /16")
  })
})

describe("supervisor: buildEscalatingFeedback maxAttempts denominator", () => {
  it("renders the passed maxAttempts as denominator in action loop message", () => {
    const result = buildEscalatingFeedback(5, "high", null, false, true, 50)
    assert.ok(result.includes("/50"), "should show /50")
    assert.ok(!result.includes("/16"), "should NOT show old default /16")
  })

  it("renders the passed maxAttempts as denominator in final attempt message", () => {
    // With maxAttempts=50, attempt 49 is final (49 >= 50-1)
    const result = buildEscalatingFeedback(49, "high", { missing: ["Do X"] }, false, false, 50)
    assert.ok(result.includes("/50"), "should show /50")
    assert.ok(!result.includes("/16"), "should NOT show old default /16")
    assert.ok(result.includes("Final Attempt"))
  })
})

describe("supervisor: buildJudgePrompt rubric interpolation", () => {
  it("buildJudgePrompt interpolates a custom rubric's patterns and antipatterns", () => {
    const ctx = {
      taskSummary: "Fix the login bug", taskType: "coding",
      requiresTests: true, requiresBuild: false, requiresPR: false, requiresCI: false,
      requiresLocalTests: false,
      toolsSummary: "npm test → pass",
    } as any
    const prompt = buildJudgePrompt(ctx, "assessment text", null, { patterns: "PP-RULE", antipatterns: "ZZ-RULE" })
    assert.match(prompt, /PP-RULE/, "custom patterns must appear in judge prompt")
    assert.match(prompt, /ZZ-RULE/, "custom antipatterns must appear in judge prompt")
  })

  it("buildJudgePrompt uses DEFAULT_RUBRIC when no rubric is provided", () => {
    const ctx = {
      taskSummary: "Fix the login bug", taskType: "coding",
      requiresTests: false, requiresBuild: false, requiresPR: false, requiresCI: false,
      requiresLocalTests: false,
      toolsSummary: "(none)",
    } as any
    const prompt = buildJudgePrompt(ctx, "assessment text")
    assert.match(prompt, /PERMISSION-SEEKING/, "default rubric antipatterns must be present")
    assert.match(prompt, /STOPPED-WITH-TODOS/, "default rubric antipatterns must be present")
  })
})

describe("supervisor: parseSupervisorCommand", () => {
  it("goal set/status/clear + aliases", () => {
    assert.deepStrictEqual(parseSupervisorCommand("goal", "tests pass"), { kind: "goal-set", condition: "tests pass" })
    assert.deepStrictEqual(parseSupervisorCommand("goal", "   "), { kind: "goal-status" })
    assert.deepStrictEqual(parseSupervisorCommand("goal", ""), { kind: "goal-status" })
    for (const a of ["clear","stop","off","reset","none","cancel","CLEAR"," Stop "]) {
      assert.deepStrictEqual(parseSupervisorCommand("goal", a), { kind: "goal-clear" })
    }
    assert.deepStrictEqual(parseSupervisorCommand("goal", "  do the thing  "), { kind: "goal-set", condition: "do the thing" })
  })
  it("caps condition at 4000 chars", () => {
    const long = "x".repeat(5000)
    const r = parseSupervisorCommand("goal", long)
    assert.strictEqual(r.kind, "goal-set")
    assert.strictEqual((r as any).condition.length, 4000)
  })
  it("retry set/status + junk", () => {
    assert.deepStrictEqual(parseSupervisorCommand("retry", "12"), { kind: "retry-set", n: 12 })
    assert.deepStrictEqual(parseSupervisorCommand("retry", "  7 "), { kind: "retry-set", n: 7 })
    assert.deepStrictEqual(parseSupervisorCommand("retry", ""), { kind: "retry-status" })
    assert.deepStrictEqual(parseSupervisorCommand("retry", "abc"), { kind: "retry-status" })
    assert.deepStrictEqual(parseSupervisorCommand("retry", "1.5"), { kind: "retry-status" })
  })
  it("unknown command name", () => {
    assert.deepStrictEqual(parseSupervisorCommand("frobnicate", "x"), { kind: "unknown", name: "frobnicate" })
  })
})

describe("supervisor: buildGoalRequirementSection", () => {
  it("embeds the condition and a mandatory marker + evidence rule", () => {
    const s = buildGoalRequirementSection("all tests in test/auth pass")
    assert.match(s, /MANDATORY/)
    assert.match(s, /all tests in test\/auth pass/)
    assert.match(s, /evidence/i)
  })
  it("trims the condition", () => {
    const s = buildGoalRequirementSection("   do X   ")
    assert.match(s, /do X/)
    assert.ok(!s.includes("   do X   "))
  })
  it("returns empty string for blank condition", () => {
    assert.strictEqual(buildGoalRequirementSection("   "), "")
    assert.strictEqual(buildGoalRequirementSection(""), "")
  })
})
