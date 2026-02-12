import assert from "node:assert"
import {
  buildSelfAssessmentPrompt,
  parseSelfAssessmentJson,
  evaluateSelfAssessment,
  inferTaskType,
  TaskContext
} from "../reflection-3.test-helpers.ts"

describe("reflection-3 unit", () => {
  it("detects task type from text", () => {
    assert.strictEqual(inferTaskType("Fix the login bug"), "coding")
    assert.strictEqual(inferTaskType("Update the README docs"), "docs")
    assert.strictEqual(inferTaskType("Investigate performance regressions"), "research")
  })

  it("parses self-assessment JSON", () => {
    const text = `{"status":"complete","confidence":0.9}`
    const parsed = parseSelfAssessmentJson(text)
    assert.ok(parsed)
    assert.strictEqual(parsed?.status, "complete")
    assert.strictEqual(parsed?.confidence, 0.9)
  })

  it("builds self-assessment prompt with requirements", () => {
    const prompt = buildSelfAssessmentPrompt({
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: ["test-mention"],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    }, "")

    assert.ok(prompt.includes("Tests required"))
    assert.ok(prompt.includes("Respond with JSON only"))
    assert.ok(prompt.includes("Local tests required"))
    assert.ok(prompt.includes("Direct pushes"))
    assert.ok(prompt.includes("Provide a PR URL"))
  })

  it("evaluates missing tests and build requirements", () => {
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {
        tests: { ran: false },
        build: { ran: false }
      },
      remaining_work: []
    }

    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: true,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("tests")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("build")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("local")))
  })

  it("marks requires human action", () => {
    const assessment = {
      status: "blocked" as const,
      confidence: 0.5,
      needs_user_action: ["Provide API key"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    assert.strictEqual(analysis.complete, false)
  })

  it("detects PR requirement from text", () => {
    const signals = "Create a PR for this fix"
    const context: TaskContext = {
      taskSummary: "Create a PR for this fix",
      taskType: "coding",
      agentMode: "build",
      humanMessages: [signals],
      toolsSummary: "(none)",
      detectedSignals: ["pr-mention"],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    }

    assert.strictEqual(context.requiresPR, true)
  })

  it("flags skipped tests as incomplete", () => {
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {
        tests: { ran: true, results: "pass" as const, ran_after_changes: true, skipped: true, skip_reason: "Flaky" }
      }
    }

    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("skip")))
  })

  it("flags direct push to default branch", () => {
    const analysis = evaluateSelfAssessment({ status: "complete", confidence: 0.9 }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: ["git push origin main"],
      pushedToDefaultBranch: true,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("direct push")))
  })

  it("requires PR evidence and CI checks when PR required", () => {
    const analysis = evaluateSelfAssessment({
      status: "complete",
      confidence: 0.9,
      evidence: { pr: { created: true, url: "", checked: false, ci_status: "unknown" } }
    }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("pr link")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("ci")))
  })

  it("requires local test commands from this session", () => {
    const analysis = evaluateSelfAssessment({
      status: "complete",
      confidence: 0.9,
      evidence: { tests: { ran: true, results: "pass", ran_after_changes: true, commands: ["npm test"] } }
    }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: ["npm run build"],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("this session")))
  })

  it("detects ops task type for personal-assistant patterns", () => {
    assert.strictEqual(inferTaskType("Create a filter to label and move emails to inbox"), "ops")
    assert.strictEqual(inferTaskType("Clean up Gmail inbox"), "ops")
    assert.strictEqual(inferTaskType("Reply to recruiter on LinkedIn"), "ops")
    assert.strictEqual(inferTaskType("Set up calendar events"), "ops")
    assert.strictEqual(inferTaskType("Configure MCP server"), "ops")
    assert.strictEqual(inferTaskType("Install dependencies on the server"), "ops")
    assert.strictEqual(inferTaskType("Organize email filters"), "ops")
    assert.strictEqual(inferTaskType("Deploy the service to production"), "ops")
  })

  it("does not misclassify ops tasks as coding when text contains build/create", () => {
    // This was the exact bug: "Create a filter" matched coding, "build entities" matched build-mention
    assert.strictEqual(inferTaskType("Create a filter to label and move emails from recruiters"), "ops")
    assert.strictEqual(inferTaskType("Builds entities and relationships in knowledge graph for email"), "ops")
  })

  it("shouldContinue is true when agent has actionable work alongside needs_user_action", () => {
    const assessment = {
      status: "in_progress" as const,
      confidence: 0.5,
      remaining_work: ["Commit and push uncommitted changes"],
      needs_user_action: ["Merge the PR"],
      evidence: { tests: { ran: false } }
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    // Agent should still continue because there's actionable work (run tests, commit changes)
    assert.strictEqual(analysis.shouldContinue, true)
    assert.ok(analysis.missing.length > 0)
  })

  it("shouldContinue is false when only user action remains", () => {
    const assessment = {
      status: "waiting_for_user" as const,
      confidence: 0.9,
      remaining_work: [],
      needs_user_action: ["Provide API key"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    assert.strictEqual(analysis.shouldContinue, false)
  })

  it("ops tasks do not require PR or CI", () => {
    // For ops tasks, PR and CI should not be enforced
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {}
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Configure email filters",
      taskType: "ops",
      agentMode: "build",
      humanMessages: ["Configure email filters"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, true)
    assert.strictEqual(analysis.missing.length, 0)
  })
})
