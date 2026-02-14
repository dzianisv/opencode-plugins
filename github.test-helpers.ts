/**
 * Test helpers for the GitHub plugin.
 *
 * OpenCode's plugin loader treats every named export as a plugin, so
 * github.ts can only have a default export + one named export (GitHubPlugin).
 * This file duplicates the pure-logic functions so they can be imported
 * directly by unit tests.
 *
 * Keep in sync with github.ts — any change to the originals must be
 * reflected here.
 */

// ==================== TYPES ====================

export interface IssueInfo {
  owner: string
  repo: string
  number: number
  url: string
}

export interface PRInfo {
  owner: string
  repo: string
  number: number
  url: string
}

export interface GitHubConfig {
  enabled?: boolean
  postUserMessages?: boolean
  postAssistantMessages?: boolean
  postToolCalls?: boolean
  batchInterval?: number
  maxMessageLength?: number
  createIssueIfMissing?: boolean
  issueLabels?: string[]
  monitorComments?: boolean
  commentPollInterval?: number
  commentTrigger?: string
}

export interface ResolvedConfig {
  enabled: boolean
  postUserMessages: boolean
  postAssistantMessages: boolean
  postToolCalls: boolean
  batchInterval: number
  maxMessageLength: number
  createIssueIfMissing: boolean
  issueLabels: string[]
  monitorComments: boolean
  commentPollInterval: number
  commentTrigger: string
}

// ==================== PURE LOGIC FUNCTIONS ====================

const MAX_COMMENT_LENGTH = 65000
const DEFAULT_POLL_INTERVAL = 30000
const DEFAULT_TRIGGER = "Act."

/**
 * Parse GitHub issue URL from text.
 * Supports: https://github.com/owner/repo/issues/123
 */
export function parseIssueUrl(text: string): IssueInfo | null {
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

/**
 * Parse GitHub PR URL from text.
 * Supports: https://github.com/owner/repo/pull/123
 */
export function parsePRUrl(text: string): PRInfo | null {
  const match = text.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/i)
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3]),
      url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
    }
  }
  return null
}

/**
 * Extract issue number from branch name.
 * Supports: issue-123, fix/123-desc, feat/GH-42-desc, 123-description
 */
export function extractIssueFromBranch(branchName: string): number | null {
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

/**
 * Check if a comment body ends with the trigger phrase.
 * Trims trailing whitespace/newlines before checking.
 */
export function hasCommentTrigger(body: string, trigger: string): boolean {
  return body.trimEnd().endsWith(trigger)
}

/**
 * Format a message for posting to GitHub.
 */
export function formatMessage(
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

/**
 * Resolve config with defaults.
 */
export function getConfig(config: GitHubConfig): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    postUserMessages: config.postUserMessages ?? false,
    postAssistantMessages: config.postAssistantMessages ?? true,
    postToolCalls: config.postToolCalls ?? false,
    batchInterval: config.batchInterval ?? 5000,
    maxMessageLength: config.maxMessageLength ?? MAX_COMMENT_LENGTH,
    createIssueIfMissing: config.createIssueIfMissing ?? true,
    issueLabels: config.issueLabels ?? ["opencode", "ai-session"],
    monitorComments: config.monitorComments ?? true,
    commentPollInterval: config.commentPollInterval ?? DEFAULT_POLL_INTERVAL,
    commentTrigger: config.commentTrigger ?? DEFAULT_TRIGGER,
  }
}
