import assert from "node:assert"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_RUBRIC, parseRubric, loadRubric, buildSelfAssessmentPrompt, buildJudgePrompt, resolveMaxAttempts, buildEscalatingFeedback } from "../reflection-3.ts"

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
