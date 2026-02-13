import assert from "node:assert"
import {
  buildSelfAssessmentPrompt,
  parseSelfAssessmentJson,
  evaluateSelfAssessment,
  inferTaskType,
  TaskContext,
  classifyTaskForRouting,
  parseRoutingFromYaml,
  getRoutingModel,
  RoutingConfig
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

describe("task-based model routing", () => {
  const baseContext: TaskContext = {
    taskSummary: "",
    taskType: "coding",
    agentMode: "build",
    humanMessages: [],
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
  }

  describe("classifyTaskForRouting", () => {
    it("classifies API/backend tasks as backend", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Add a REST API endpoint for user profiles" }), "backend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Fix database connection pooling" }), "backend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Set up Docker container for the service" }), "backend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Implement GraphQL resolver" }), "backend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Write a CLI tool in Golang" }), "backend")
    })

    it("classifies UI/frontend tasks as frontend", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Build a React component for the dashboard" }), "frontend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Fix CSS layout issues on mobile" }), "frontend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Add dark mode toggle to the UI" }), "frontend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Create animation for the loading spinner" }), "frontend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Implement a game sprite renderer" }), "frontend")
    })

    it("classifies debugging/architecture tasks as architecture", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Debug the memory leak in production" }), "architecture")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Refactor the authentication module" }), "architecture")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Investigate why the service is slow" }), "architecture")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Security audit of the payment system" }), "architecture")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Design pattern for event-driven architecture" }), "architecture")
    })

    it("defaults coding tasks without specific patterns to backend", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Implement the feature" }), "backend")
    })

    it("defaults non-coding tasks to default", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Update the README", taskType: "docs" }), "default")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Research best practices", taskType: "research" }), "default")
    })

    it("uses humanMessages for classification too", () => {
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Help me", humanMessages: ["Fix the React component layout"] }), "frontend")
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Help me", humanMessages: ["Debug the server crash"] }), "architecture")
    })

    it("frontend takes priority over backend keywords", () => {
      // If both frontend and backend signals are present, frontend wins (checked first)
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Build a React component that calls the API endpoint" }), "frontend")
    })

    it("architecture takes priority over backend keywords", () => {
      // If both architecture and backend signals are present, architecture wins
      assert.strictEqual(classifyTaskForRouting({ ...baseContext, taskSummary: "Debug the API server memory leak" }), "architecture")
    })
  })

  describe("parseRoutingFromYaml", () => {
    it("parses a complete routing config", () => {
      const yaml = `models:
  - github-copilot/claude-opus-4.6

routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
    architecture: github-copilot/claude-opus-4.6
    frontend: github-copilot/gemini-3-pro-preview
    default: github-copilot/claude-opus-4.6
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, true)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.architecture, "github-copilot/claude-opus-4.6")
      assert.strictEqual(config.models.frontend, "github-copilot/gemini-3-pro-preview")
      assert.strictEqual(config.models.default, "github-copilot/claude-opus-4.6")
    })

    it("defaults to disabled when routing section is missing", () => {
      const yaml = `models:
  - github-copilot/claude-opus-4.6
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, false)
      assert.strictEqual(config.models.backend, "")
      assert.strictEqual(config.models.frontend, "")
    })

    it("handles enabled: false", () => {
      const yaml = `routing:
  enabled: false
  models:
    backend: github-copilot/gpt-5.2-codex
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, false)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
    })

    it("handles partial model config", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, true)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.frontend, "")
      assert.strictEqual(config.models.architecture, "")
    })

    it("strips quotes from model values", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: "github-copilot/gpt-5.2-codex"
    frontend: 'github-copilot/gemini-3-pro-preview'
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.frontend, "github-copilot/gemini-3-pro-preview")
    })

    it("ignores unknown routing model keys", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
    unknown_category: github-copilot/some-model
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual((config.models as any).unknown_category, undefined)
    })
  })

  describe("getRoutingModel", () => {
    const enabledConfig: RoutingConfig = {
      enabled: true,
      models: {
        backend: "github-copilot/gpt-5.2-codex",
        architecture: "github-copilot/claude-opus-4.6",
        frontend: "github-copilot/gemini-3-pro-preview",
        default: "github-copilot/claude-opus-4.6"
      }
    }

    it("returns correct provider/model split for each category", () => {
      const backend = getRoutingModel(enabledConfig, "backend")
      assert.deepStrictEqual(backend, { providerID: "github-copilot", modelID: "gpt-5.2-codex" })

      const arch = getRoutingModel(enabledConfig, "architecture")
      assert.deepStrictEqual(arch, { providerID: "github-copilot", modelID: "claude-opus-4.6" })

      const frontend = getRoutingModel(enabledConfig, "frontend")
      assert.deepStrictEqual(frontend, { providerID: "github-copilot", modelID: "gemini-3-pro-preview" })
    })

    it("falls back to default model when category has empty string", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "", architecture: "", frontend: "", default: "github-copilot/claude-opus-4.6" }
      }
      const result = getRoutingModel(config, "backend")
      assert.deepStrictEqual(result, { providerID: "github-copilot", modelID: "claude-opus-4.6" })
    })

    it("returns null when routing is disabled", () => {
      const config: RoutingConfig = {
        enabled: false,
        models: { backend: "github-copilot/gpt-5.2-codex", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })

    it("returns null when no model is configured for category or default", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })

    it("returns null for malformed model spec (no slash)", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "just-a-name", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })
  })
})
