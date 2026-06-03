import assert from "node:assert"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_RUBRIC, parseRubric, loadRubric, buildSelfAssessmentPrompt } from "../reflection-3.ts"

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
})
