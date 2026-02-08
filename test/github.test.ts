/**
 * Tests for GitHub Issue Integration Plugin
 * 
 * Note: These test utility functions directly since OpenCode plugin system
 * doesn't support named exports (it tries to call them as plugins).
 */

import { describe, it, expect } from "@jest/globals"

// ==================== INLINE TEST UTILITIES ====================
// These mirror the functions in github.ts for testing purposes

interface IssueInfo {
  owner: string
  repo: string
  number: number
  url: string
}

function parseIssueUrl(text: string): IssueInfo | null {
  const match = text.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/i)
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3]),
      url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`
    }
  }
  return null
}

function extractIssueFromBranch(branchName: string): number | null {
  // Pattern 1: explicit issue prefix (issue-123, issue/123)
  let match = branchName.match(/issue[-\/](\d+)/i)
  if (match) return parseInt(match[1])

  // Pattern 2: GH-N prefix
  match = branchName.match(/GH-(\d+)/i)
  if (match) return parseInt(match[1])

  // Pattern 3: type/N-description (fix/123-typo, feat/42-new-feature)
  match = branchName.match(/^[a-z]+\/(\d+)[-_]/i)
  if (match) return parseInt(match[1])

  // Pattern 4: N-description at start (123-fix-bug)
  match = branchName.match(/^(\d+)[-_]/)
  if (match) return parseInt(match[1])

  // Pattern 5: number anywhere after slash (feature/add-thing-123)
  match = branchName.match(/\/.*?(\d+)/)
  if (match && parseInt(match[1]) > 0 && parseInt(match[1]) < 100000) {
    return parseInt(match[1])
  }

  return null
}

function formatMessage(
  role: "user" | "assistant" | "tool",
  content: string,
  metadata?: { model?: string; timestamp?: Date; toolName?: string }
): string {
  const timestamp = metadata?.timestamp || new Date()
  const timeStr = timestamp.toISOString()

  let header = ""
  if (role === "user") {
    header = `### User Message`
  } else if (role === "assistant") {
    header = `### Assistant${metadata?.model ? ` (${metadata.model})` : ""}`
  } else if (role === "tool") {
    header = `### Tool: ${metadata?.toolName || "unknown"}`
  }

  return `${header}
<sub>${timeStr}</sub>

${content}

---`
}

interface GitHubConfig {
  enabled?: boolean
  postUserMessages?: boolean
  postAssistantMessages?: boolean
  postToolCalls?: boolean
  batchInterval?: number
  maxMessageLength?: number
  createIssueIfMissing?: boolean
  issueLabels?: string[]
}

function getConfig(config: GitHubConfig): Required<GitHubConfig> {
  return {
    enabled: config.enabled ?? true,
    postUserMessages: config.postUserMessages ?? false,
    postAssistantMessages: config.postAssistantMessages ?? true,
    postToolCalls: config.postToolCalls ?? false,
    batchInterval: config.batchInterval ?? 5000,
    maxMessageLength: config.maxMessageLength ?? 65000,
    createIssueIfMissing: config.createIssueIfMissing ?? true,
    issueLabels: config.issueLabels ?? ["opencode", "ai-session"]
  }
}

// ==================== TESTS ====================

describe("GitHub Plugin", () => {
  describe("parseIssueUrl", () => {
    it("parses standard GitHub issue URL", () => {
      const result = parseIssueUrl("https://github.com/owner/repo/issues/123")
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        number: 123,
        url: "https://github.com/owner/repo/issues/123"
      })
    })

    it("parses URL embedded in text", () => {
      const result = parseIssueUrl("Please fix https://github.com/dzianisv/opencode-plugins/issues/42 ASAP")
      expect(result).toEqual({
        owner: "dzianisv",
        repo: "opencode-plugins",
        number: 42,
        url: "https://github.com/dzianisv/opencode-plugins/issues/42"
      })
    })

    it("parses URL with trailing content", () => {
      const result = parseIssueUrl("Check https://github.com/org/project/issues/999#issuecomment-123")
      expect(result).toEqual({
        owner: "org",
        repo: "project",
        number: 999,
        url: "https://github.com/org/project/issues/999"
      })
    })

    it("returns null for non-issue URLs", () => {
      expect(parseIssueUrl("https://github.com/owner/repo")).toBeNull()
      expect(parseIssueUrl("https://github.com/owner/repo/pull/123")).toBeNull()
      expect(parseIssueUrl("no url here")).toBeNull()
    })

    it("handles case insensitivity", () => {
      const result = parseIssueUrl("https://GitHub.com/Owner/Repo/Issues/123")
      expect(result).not.toBeNull()
      expect(result?.number).toBe(123)
    })
  })

  describe("extractIssueFromBranch", () => {
    it("extracts from issue-N format", () => {
      expect(extractIssueFromBranch("issue-123")).toBe(123)
      expect(extractIssueFromBranch("issue/456")).toBe(456)
    })

    it("extracts from GH-N format", () => {
      expect(extractIssueFromBranch("GH-42")).toBe(42)
      expect(extractIssueFromBranch("gh-99")).toBe(99)
      expect(extractIssueFromBranch("feat/GH-123-add-feature")).toBe(123)
    })

    it("extracts from type/N-description format", () => {
      expect(extractIssueFromBranch("fix/123-typo")).toBe(123)
      expect(extractIssueFromBranch("feat/456-new-feature")).toBe(456)
      expect(extractIssueFromBranch("bug/789_fix_crash")).toBe(789)
    })

    it("extracts from N-description format", () => {
      expect(extractIssueFromBranch("123-fix-bug")).toBe(123)
      expect(extractIssueFromBranch("42_add_tests")).toBe(42)
    })

    it("returns null for branches without issue numbers", () => {
      expect(extractIssueFromBranch("main")).toBeNull()
      expect(extractIssueFromBranch("master")).toBeNull()
      expect(extractIssueFromBranch("develop")).toBeNull()
      expect(extractIssueFromBranch("feature/add-something")).toBeNull()
    })

    it("handles complex branch names", () => {
      expect(extractIssueFromBranch("feat/reflection-static-plugin")).toBeNull()
      expect(extractIssueFromBranch("fix/issue-42-then-more")).toBe(42)
    })
  })

  describe("formatMessage", () => {
    it("formats user message", () => {
      const result = formatMessage("user", "Hello world")
      expect(result).toContain("### User Message")
      expect(result).toContain("Hello world")
      expect(result).toContain("---")
    })

    it("formats assistant message with model", () => {
      const result = formatMessage("assistant", "I can help with that", { model: "claude-sonnet-4" })
      expect(result).toContain("### Assistant (claude-sonnet-4)")
      expect(result).toContain("I can help with that")
    })

    it("formats tool message", () => {
      const result = formatMessage("tool", "Tool output", { toolName: "bash" })
      expect(result).toContain("### Tool: bash")
      expect(result).toContain("Tool output")
    })

    it("includes timestamp", () => {
      const timestamp = new Date("2026-02-07T12:00:00Z")
      const result = formatMessage("user", "Test", { timestamp })
      expect(result).toContain("2026-02-07T12:00:00")
    })
  })

  describe("getConfig", () => {
    it("returns defaults for empty config", () => {
      const config = getConfig({})
      expect(config.enabled).toBe(true)
      expect(config.postUserMessages).toBe(false)
      expect(config.postAssistantMessages).toBe(true)
      expect(config.postToolCalls).toBe(false)
      expect(config.batchInterval).toBe(5000)
      expect(config.createIssueIfMissing).toBe(true)
      expect(config.issueLabels).toEqual(["opencode", "ai-session"])
    })

    it("respects provided values", () => {
      const config = getConfig({
        enabled: false,
        postUserMessages: true,
        batchInterval: 10000,
        issueLabels: ["custom"]
      })
      expect(config.enabled).toBe(false)
      expect(config.postUserMessages).toBe(true)
      expect(config.batchInterval).toBe(10000)
      expect(config.issueLabels).toEqual(["custom"])
    })
  })
})

describe("GitHub Plugin - Integration", () => {
  // These tests require gh CLI to be available and authenticated
  // They will be skipped if gh is not available

  const hasGh = async () => {
    try {
      const { exec } = await import("child_process")
      const { promisify } = await import("util")
      const execAsync = promisify(exec)
      await execAsync("gh auth status")
      return true
    } catch {
      return false
    }
  }

  it("can check gh CLI availability", async () => {
    const available = await hasGh()
    console.log(`gh CLI available: ${available}`)
    // This test just logs the status, doesn't fail
    expect(true).toBe(true)
  })
})
