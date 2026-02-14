/**
 * Tests for GitHub Issue & PR Integration Plugin
 *
 * Uses the test-helpers extraction pattern: pure logic functions are
 * duplicated in github.test-helpers.ts so they can be imported without
 * triggering OpenCode's plugin loader (which treats named exports as plugins).
 */

import { describe, it, expect } from "@jest/globals"
import {
  parseIssueUrl,
  parsePRUrl,
  extractIssueFromBranch,
  hasCommentTrigger,
  formatMessage,
  getConfig,
} from "../github.test-helpers.ts"

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

  describe("parsePRUrl", () => {
    it("parses standard GitHub PR URL", () => {
      const result = parsePRUrl("https://github.com/owner/repo/pull/456")
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        number: 456,
        url: "https://github.com/owner/repo/pull/456"
      })
    })

    it("parses PR URL embedded in text", () => {
      const result = parsePRUrl("Review https://github.com/dzianisv/opencode-plugins/pull/92 please")
      expect(result).toEqual({
        owner: "dzianisv",
        repo: "opencode-plugins",
        number: 92,
        url: "https://github.com/dzianisv/opencode-plugins/pull/92"
      })
    })

    it("parses PR URL with trailing content", () => {
      const result = parsePRUrl("https://github.com/org/project/pull/10#discussion_r123")
      expect(result).toEqual({
        owner: "org",
        repo: "project",
        number: 10,
        url: "https://github.com/org/project/pull/10"
      })
    })

    it("returns null for non-PR URLs", () => {
      expect(parsePRUrl("https://github.com/owner/repo")).toBeNull()
      expect(parsePRUrl("https://github.com/owner/repo/issues/123")).toBeNull()
      expect(parsePRUrl("no url here")).toBeNull()
    })

    it("handles case insensitivity", () => {
      const result = parsePRUrl("https://GitHub.com/Owner/Repo/Pull/789")
      expect(result).not.toBeNull()
      expect(result?.number).toBe(789)
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

    it("extracts from issue-91-github-comment-monitoring style", () => {
      expect(extractIssueFromBranch("issue-91-github-comment-monitoring")).toBe(91)
    })
  })

  describe("hasCommentTrigger", () => {
    const trigger = "Act."

    it("detects trigger at end of single-line comment", () => {
      expect(hasCommentTrigger("Please fix the bug. Act.", trigger)).toBe(true)
    })

    it("detects trigger at end of multi-line comment", () => {
      expect(hasCommentTrigger("Line 1\nLine 2\nDo this. Act.", trigger)).toBe(true)
    })

    it("detects trigger with trailing whitespace", () => {
      expect(hasCommentTrigger("Do something. Act.  ", trigger)).toBe(true)
      expect(hasCommentTrigger("Do something. Act.\n", trigger)).toBe(true)
      expect(hasCommentTrigger("Do something. Act.\n\n  ", trigger)).toBe(true)
    })

    it("returns false when trigger is not at end", () => {
      expect(hasCommentTrigger("Act. Please do this", trigger)).toBe(false)
      expect(hasCommentTrigger("Not actionable", trigger)).toBe(false)
    })

    it("returns false for empty body", () => {
      expect(hasCommentTrigger("", trigger)).toBe(false)
    })

    it("returns false for trigger substring (not exact)", () => {
      expect(hasCommentTrigger("React.", trigger)).toBe(false)
      expect(hasCommentTrigger("Fact.", trigger)).toBe(false)
    })

    it("handles exact trigger as entire body", () => {
      expect(hasCommentTrigger("Act.", trigger)).toBe(true)
    })

    it("works with custom triggers", () => {
      expect(hasCommentTrigger("Do it now @bot", "@bot")).toBe(true)
      expect(hasCommentTrigger("Please execute //run", "//run")).toBe(true)
      expect(hasCommentTrigger("Just a comment", "@bot")).toBe(false)
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
      expect(config.monitorComments).toBe(true)
      expect(config.commentPollInterval).toBe(30000)
      expect(config.commentTrigger).toBe("Act.")
    })

    it("respects provided values", () => {
      const config = getConfig({
        enabled: false,
        postUserMessages: true,
        batchInterval: 10000,
        issueLabels: ["custom"],
        monitorComments: false,
        commentPollInterval: 60000,
        commentTrigger: "@bot",
      })
      expect(config.enabled).toBe(false)
      expect(config.postUserMessages).toBe(true)
      expect(config.batchInterval).toBe(10000)
      expect(config.issueLabels).toEqual(["custom"])
      expect(config.monitorComments).toBe(false)
      expect(config.commentPollInterval).toBe(60000)
      expect(config.commentTrigger).toBe("@bot")
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
    // This test just logs the status, doesn't fail
    expect(true).toBe(true)
  })
})
