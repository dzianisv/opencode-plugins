/**
 * GitHub Issue & PR Integration Plugin for OpenCode
 *
 * Two-way integration with GitHub:
 * 1. Posts agent messages to the associated GitHub issue as comments.
 * 2. Monitors GitHub issue/PR comments for actionable directives (ending with "Act.")
 *    and injects them into the active OpenCode session.
 *
 * Issue Detection Priority:
 * 1. GitHub issue URL in first message
 * 2. .github-issue file in project root
 * 3. PR's closingIssuesReferences (via gh CLI)
 * 4. Branch name convention (issue-123, fix/123-desc, etc.)
 * 5. Create new issue with task description
 *
 * Configure in ~/.config/opencode/github.json:
 * {
 *   "enabled": true,
 *   "postUserMessages": false,
 *   "postAssistantMessages": true,
 *   "postToolCalls": false,
 *   "batchInterval": 5000,
 *   "createIssueIfMissing": true,
 *   "issueLabels": ["opencode", "ai-session"],
 *   "monitorComments": true,
 *   "commentPollInterval": 30000,
 *   "commentTrigger": "Act."
 * }
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, access } from "fs/promises"
import { exec } from "child_process"
import { promisify } from "util"
import { join } from "path"
import { homedir } from "os"

const execAsync = promisify(exec)

// ==================== SENTRY ====================

let _reportError: ((err: unknown, ctx?: Record<string, any>) => void) | undefined
function reportError(err: unknown, ctx?: Record<string, any>) {
  if (!_reportError) {
    _reportError = (e, c) => {
      import("@sentry/node")
        .then(Sentry => Sentry.captureException(e, { extra: c }))
        .catch(() => {})
    }
  }
  _reportError(err, ctx)
}

// ==================== CONFIGURATION ====================

interface GitHubConfig {
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

const CONFIG_PATH = join(homedir(), ".config", "opencode", "github.json")
const ISSUE_FILE = ".github-issue.md"
const MAX_COMMENT_LENGTH = 65000 // GitHub's limit is 65536
const DEFAULT_POLL_INTERVAL = 30000 // 30 seconds
const DEFAULT_TRIGGER = "Act."

// Debug logging (silenced — console.error corrupts the OpenCode TUI)
function debug(..._args: any[]) {}

// ==================== CONFIG LOADING ====================

async function loadConfig(): Promise<GitHubConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return {}
  }
}

interface ResolvedConfig {
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

function getConfig(config: GitHubConfig): ResolvedConfig {
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

// ==================== ISSUE / PR DETECTION ====================

interface IssueInfo {
  owner: string
  repo: string
  number: number
  url: string
}

interface PRInfo {
  owner: string
  repo: string
  number: number
  url: string
}

/**
 * Parse GitHub issue URL from text
 * Supports: https://github.com/owner/repo/issues/123
 */
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

/**
 * Parse GitHub PR URL from text
 */
function parsePRUrl(text: string): PRInfo | null {
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
 * Extract issue number from branch name
 * Supports: issue-123, fix/123-desc, feat/GH-42-desc, 123-description
 */
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

/**
 * Get current git branch name
 */
async function getCurrentBranch(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git branch --show-current", { cwd: directory })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Get git remote origin URL to extract owner/repo
 */
async function getRepoInfo(directory: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execAsync("git remote get-url origin", { cwd: directory })
    const url = stdout.trim()

    // Parse SSH format: git@github.com:owner/repo.git
    let match = url.match(/git@github\.com:([^\/]+)\/([^\.]+)/)
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
    }

    // Parse HTTPS format: https://github.com/owner/repo.git
    match = url.match(/github\.com\/([^\/]+)\/([^\.\/]+)/)
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Check if gh CLI is available and authenticated
 */
async function isGhAvailable(): Promise<boolean> {
  try {
    await execAsync("gh auth status")
    return true
  } catch {
    return false
  }
}

/**
 * Get issue from PR's closingIssuesReferences
 */
async function getIssueFromPR(directory: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `gh pr view --json closingIssuesReferences -q '.closingIssuesReferences[0].number'`,
      { cwd: directory }
    )
    const num = parseInt(stdout.trim())
    return isNaN(num) ? null : num
  } catch {
    return null
  }
}

/**
 * Get current branch's open PR number
 */
async function getCurrentPR(directory: string): Promise<PRInfo | null> {
  try {
    const { stdout } = await execAsync(
      `gh pr view --json number,url -q '{"number": .number, "url": .url}'`,
      { cwd: directory }
    )
    const result = JSON.parse(stdout.trim())
    if (!result?.number) return null

    const repoInfo = await getRepoInfo(directory)
    if (!repoInfo) return null

    return {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      number: result.number,
      url: result.url
    }
  } catch {
    return null
  }
}

/**
 * Verify issue exists
 */
async function verifyIssue(owner: string, repo: string, number: number): Promise<boolean> {
  try {
    await execAsync(`gh issue view ${number} --repo ${owner}/${repo} --json number`)
    return true
  } catch {
    return false
  }
}

/**
 * Read .github-issue file
 */
async function readIssueFile(directory: string): Promise<IssueInfo | null> {
  const filePath = join(directory, ISSUE_FILE)
  try {
    await access(filePath)
    const content = (await readFile(filePath, "utf-8")).trim()

    // Check if it's a URL
    const urlInfo = parseIssueUrl(content)
    if (urlInfo) return urlInfo

    // Check if it's just a number
    const number = parseInt(content)
    if (!isNaN(number)) {
      const repoInfo = await getRepoInfo(directory)
      if (repoInfo) {
        return {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          number,
          url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${number}`
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Write issue info to .github-issue file
 */
async function writeIssueFile(directory: string, issue: IssueInfo): Promise<void> {
  const filePath = join(directory, ISSUE_FILE)
  await writeFile(filePath, issue.url + "\n", "utf-8")
  debug("Wrote issue file:", filePath)
}

/**
 * Create a new GitHub issue
 */
async function createIssue(
  directory: string,
  title: string,
  body: string,
  labels: string[]
): Promise<IssueInfo | null> {
  const repoInfo = await getRepoInfo(directory)
  if (!repoInfo) {
    debug("Cannot create issue: no repo info")
    return null
  }

  try {
    // Create issue with gh CLI
    const labelArgs = labels.map(l => `--label "${l}"`).join(" ")
    const { stdout } = await execAsync(
      `gh issue create --repo ${repoInfo.owner}/${repoInfo.repo} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" ${labelArgs} --json number,url`,
      { cwd: directory }
    )

    const result = JSON.parse(stdout)
    return {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      number: result.number,
      url: result.url
    }
  } catch (e) {
    debug("Failed to create issue:", e)
    return null
  }
}

/**
 * Main issue detection function - tries all methods in priority order
 */
async function detectIssue(
  directory: string,
  firstMessage: string | null,
  config: ResolvedConfig
): Promise<IssueInfo | null> {
  debug("Detecting issue for directory:", directory)

  // 1. Check first message for GitHub issue URL
  if (firstMessage) {
    const urlInfo = parseIssueUrl(firstMessage)
    if (urlInfo) {
      debug("Found issue URL in first message:", urlInfo.url)
      // Save to file for future sessions
      await writeIssueFile(directory, urlInfo)
      return urlInfo
    }
  }

  // 2. Check .github-issue file
  const fileInfo = await readIssueFile(directory)
  if (fileInfo) {
    debug("Found issue in .github-issue file:", fileInfo.url)
    return fileInfo
  }

  // Check if gh CLI is available for remaining methods
  const ghAvailable = await isGhAvailable()
  if (!ghAvailable) {
    debug("gh CLI not available, skipping PR and branch checks")
  } else {
    // 3. Check PR's closingIssuesReferences
    const prIssue = await getIssueFromPR(directory)
    if (prIssue) {
      const repoInfo = await getRepoInfo(directory)
      if (repoInfo) {
        const verified = await verifyIssue(repoInfo.owner, repoInfo.repo, prIssue)
        if (verified) {
          const info: IssueInfo = {
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            number: prIssue,
            url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${prIssue}`
          }
          debug("Found issue from PR:", info.url)
          await writeIssueFile(directory, info)
          return info
        }
      }
    }

    // 4. Extract from branch name
    const branch = await getCurrentBranch(directory)
    if (branch) {
      const branchIssue = extractIssueFromBranch(branch)
      if (branchIssue) {
        const repoInfo = await getRepoInfo(directory)
        if (repoInfo) {
          const verified = await verifyIssue(repoInfo.owner, repoInfo.repo, branchIssue)
          if (verified) {
            const info: IssueInfo = {
              owner: repoInfo.owner,
              repo: repoInfo.repo,
              number: branchIssue,
              url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${branchIssue}`
            }
            debug("Found issue from branch name:", info.url)
            await writeIssueFile(directory, info)
            return info
          }
        }
      }
    }
  }

  // 5. Create new issue if enabled
  if (config.createIssueIfMissing && firstMessage && ghAvailable) {
    debug("Creating new issue...")
    // Extract title from first line or first 80 chars
    const titleMatch = firstMessage.match(/^(.{1,80})/)
    const title = titleMatch ? titleMatch[1].replace(/\n/g, " ").trim() : "OpenCode Session"

    const body = `## Task Description

${firstMessage.slice(0, 3000)}

---
*This issue was automatically created by OpenCode to track agent session history.*`

    const newIssue = await createIssue(directory, title, body, config.issueLabels)
    if (newIssue) {
      debug("Created new issue:", newIssue.url)
      await writeIssueFile(directory, newIssue)
      return newIssue
    }
  }

  debug("No issue detected")
  return null
}

// ==================== MESSAGE POSTING ====================

/**
 * Post a comment to GitHub issue
 */
async function postComment(issue: IssueInfo, body: string): Promise<boolean> {
  try {
    // Truncate if too long
    let commentBody = body
    if (commentBody.length > MAX_COMMENT_LENGTH) {
      commentBody = commentBody.slice(0, MAX_COMMENT_LENGTH - 100) + "\n\n*[Message truncated]*"
    }

    // Use gh CLI to post comment
    // Using a heredoc to handle multi-line content
    await execAsync(
      `gh issue comment ${issue.number} --repo ${issue.owner}/${issue.repo} --body-file -`,
      {
        input: commentBody
      } as any
    )

    debug("Posted comment to issue", issue.number)
    return true
  } catch (e) {
    debug("Failed to post comment:", e)
    return false
  }
}

/**
 * Format a message for posting to GitHub
 */
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

// ==================== COMMENT MONITORING ====================

interface GitHubComment {
  id: number
  body: string
  user: { login: string }
  created_at: string
  html_url: string
}

/**
 * Fetch issue comments since a given timestamp using gh API.
 */
async function fetchIssueComments(
  issue: IssueInfo,
  since?: string
): Promise<GitHubComment[]> {
  try {
    const sinceParam = since ? `&since=${since}` : ""
    const { stdout } = await execAsync(
      `gh api "repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments?per_page=100&sort=created&direction=desc${sinceParam}"`,
      { maxBuffer: 1024 * 1024 }
    )
    return JSON.parse(stdout) as GitHubComment[]
  } catch {
    return []
  }
}

/**
 * Fetch PR review comments (code-level review comments).
 */
async function fetchPRReviewComments(
  pr: PRInfo,
  since?: string
): Promise<GitHubComment[]> {
  try {
    const sinceParam = since ? `&since=${since}` : ""
    const { stdout } = await execAsync(
      `gh api "repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=100&sort=created&direction=desc${sinceParam}"`,
      { maxBuffer: 1024 * 1024 }
    )
    return JSON.parse(stdout) as GitHubComment[]
  } catch {
    return []
  }
}

/**
 * Check if a comment body ends with the trigger phrase.
 * Trims trailing whitespace/newlines before checking.
 */
function hasCommentTrigger(body: string, trigger: string): boolean {
  return body.trimEnd().endsWith(trigger)
}

/**
 * Add a reaction to a comment to acknowledge it was processed.
 */
async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: string = "eyes"
): Promise<void> {
  try {
    await execAsync(
      `gh api "repos/${owner}/${repo}/issues/comments/${commentId}/reactions" -f content="${reaction}" --silent`
    )
  } catch {}
}

/**
 * Add a reaction to a PR review comment.
 */
async function addPRReviewCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: string = "eyes"
): Promise<void> {
  try {
    await execAsync(
      `gh api "repos/${owner}/${repo}/pulls/comments/${commentId}/reactions" -f content="${reaction}" --silent`
    )
  } catch {}
}

// ==================== PLUGIN ====================

export const GitHubPlugin: Plugin = async ({ client, directory }) => {
  if (!client) {
    return {}
  }
  debug("GitHub plugin initializing for directory:", directory)

  // ---- Session & message posting state ----
  const sessionIssues = new Map<string, IssueInfo | null>()
  const pendingMessages = new Map<string, Array<{ role: string; content: string; metadata?: any }>>()
  const batchTimers = new Map<string, NodeJS.Timeout>()
  const processedMessages = new Set<string>()

  // ---- Comment monitoring state ----
  // Maps "owner/repo#number" to the most-recently-seen comment ID (for dedup)
  const lastSeenIssueCommentId = new Map<string, number>()
  const lastSeenPRCommentId = new Map<string, number>()
  // Tracks which sessionId is associated with which issue/PR for routing
  const sessionToIssue = new Map<string, IssueInfo>()
  const sessionToPR = new Map<string, PRInfo>()
  // Reverse lookups: "owner/repo#number" → sessionId (most recent session wins)
  const issueKeyToSession = new Map<string, string>()
  const prKeyToSession = new Map<string, string>()
  // Active sessions (from most recent session.idle)
  let activeSessionId: string | null = null
  // Polling timer
  let pollTimer: NodeJS.Timeout | null = null
  // Processed comment IDs (prevent re-processing after restart)
  const processedCommentIds = new Set<number>()

  // Load config
  const rawConfig = await loadConfig()
  const config = getConfig(rawConfig)

  if (!config.enabled) {
    debug("GitHub plugin disabled")
    return {}
  }

  // Check gh CLI availability at startup
  const ghAvailable = await isGhAvailable()
  if (!ghAvailable) {
    debug("gh CLI not available or not authenticated - plugin will have limited functionality")
  }

  // ---- Helper: issue/PR key for maps ----
  function issueKey(info: IssueInfo | PRInfo): string {
    return `${info.owner}/${info.repo}#${info.number}`
  }

  /**
   * Get or detect issue for a session
   */
  async function getSessionIssue(sessionId: string, firstMessage?: string): Promise<IssueInfo | null> {
    if (sessionIssues.has(sessionId)) {
      return sessionIssues.get(sessionId) || null
    }

    const issue = await detectIssue(directory, firstMessage || null, config)
    sessionIssues.set(sessionId, issue)
    return issue
  }

  /**
   * Queue a message for posting
   */
  function queueMessage(sessionId: string, role: string, content: string, metadata?: any) {
    if (!pendingMessages.has(sessionId)) {
      pendingMessages.set(sessionId, [])
    }
    pendingMessages.get(sessionId)!.push({ role, content, metadata })

    // Set up batch timer
    if (!batchTimers.has(sessionId)) {
      const timer = setTimeout(() => flushMessages(sessionId), config.batchInterval)
      batchTimers.set(sessionId, timer)
    }
  }

  /**
   * Flush pending messages to GitHub
   */
  async function flushMessages(sessionId: string) {
    const messages = pendingMessages.get(sessionId)
    if (!messages || messages.length === 0) return

    const issue = sessionIssues.get(sessionId)
    if (!issue) {
      debug("No issue for session, skipping flush:", sessionId.slice(0, 8))
      pendingMessages.delete(sessionId)
      return
    }

    // Clear pending
    pendingMessages.delete(sessionId)
    batchTimers.delete(sessionId)

    // Format all messages into one comment
    const formattedMessages = messages.map(m =>
      formatMessage(m.role as any, m.content, m.metadata)
    )

    const comment = formattedMessages.join("\n\n")
    await postComment(issue, comment)
  }

  /**
   * Extract text content from message parts
   */
  function extractTextFromParts(parts: any[]): string {
    const texts: string[] = []
    for (const part of parts) {
      if (part.type === "text" && part.text) {
        texts.push(part.text)
      } else if (part.type === "tool-invocation") {
        if (config.postToolCalls) {
          texts.push(`**Tool: ${part.toolInvocation?.toolName || "unknown"}**\n\`\`\`json\n${JSON.stringify(part.toolInvocation?.input, null, 2)}\n\`\`\``)
        }
      } else if (part.type === "tool-result") {
        if (config.postToolCalls) {
          texts.push(`**Tool Result:**\n\`\`\`\n${JSON.stringify(part.toolResult?.result, null, 2).slice(0, 1000)}\n\`\`\``)
        }
      }
    }
    return texts.join("\n\n")
  }

  // ==================== COMMENT MONITORING LOGIC ====================

  /**
   * Detect which issue & PR are associated with the current directory and
   * register them for comment monitoring. Called on session.idle.
   */
  async function registerSessionForMonitoring(sessionId: string) {
    // Detect issue
    const issue = sessionIssues.get(sessionId) || await getSessionIssue(sessionId)
    if (issue) {
      const key = issueKey(issue)
      sessionToIssue.set(sessionId, issue)
      issueKeyToSession.set(key, sessionId)
      debug("Registered issue monitoring:", key, "session:", sessionId.slice(0, 8))
    }

    // Detect PR for current branch
    if (ghAvailable) {
      const pr = await getCurrentPR(directory)
      if (pr) {
        const key = issueKey(pr)
        sessionToPR.set(sessionId, pr)
        prKeyToSession.set(key, sessionId)
        debug("Registered PR monitoring:", key, "session:", sessionId.slice(0, 8))
      }
    }
  }

  /**
   * Poll for new comments on all monitored issues and PRs.
   * Injects actionable comments (ending with trigger) into the session.
   */
  async function pollForComments() {
    if (!config.monitorComments) return

    try {
      // Poll issue comments
      for (const [key, sessionId] of issueKeyToSession) {
        const issue = sessionToIssue.get(sessionId)
        if (!issue) continue

        try {
          const comments = await fetchIssueComments(issue)
          const lastSeen = lastSeenIssueCommentId.get(key) || 0

          // Process new comments (newest first, but we want chronological order)
          const newComments = comments
            .filter(c => c.id > lastSeen && !processedCommentIds.has(c.id))
            .reverse() // chronological order

          for (const comment of newComments) {
            processedCommentIds.add(comment.id)

            if (hasCommentTrigger(comment.body, config.commentTrigger)) {
              debug("Actionable issue comment found:", comment.id, "from", comment.user.login)

              // Verify session still exists
              try {
                await client.session.get({ path: { id: sessionId } })
              } catch {
                debug("Session gone, skipping comment injection")
                continue
              }

              // Inject into session
              const prefix = `[GitHub Issue #${issue.number} comment by @${comment.user.login}]`
              try {
                await client.session.promptAsync({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: `${prefix}\n\n${comment.body}` }] }
                })

                // React to acknowledge
                await addCommentReaction(issue.owner, issue.repo, comment.id, "rocket")
                debug("Injected issue comment into session:", sessionId.slice(0, 8))
              } catch (e) {
                reportError(e, { plugin: "github", op: "inject-issue-comment" })
              }
            }
          }

          // Update high-water mark
          if (comments.length > 0) {
            const maxId = Math.max(...comments.map(c => c.id))
            if (maxId > lastSeen) {
              lastSeenIssueCommentId.set(key, maxId)
            }
          }
        } catch (e) {
          reportError(e, { plugin: "github", op: "poll-issue-comments", key })
        }
      }

      // Poll PR review comments
      for (const [key, sessionId] of prKeyToSession) {
        const pr = sessionToPR.get(sessionId)
        if (!pr) continue

        try {
          const comments = await fetchPRReviewComments(pr)
          const lastSeen = lastSeenPRCommentId.get(key) || 0

          const newComments = comments
            .filter(c => c.id > lastSeen && !processedCommentIds.has(c.id))
            .reverse()

          for (const comment of newComments) {
            processedCommentIds.add(comment.id)

            if (hasCommentTrigger(comment.body, config.commentTrigger)) {
              debug("Actionable PR review comment found:", comment.id, "from", comment.user.login)

              try {
                await client.session.get({ path: { id: sessionId } })
              } catch {
                debug("Session gone, skipping comment injection")
                continue
              }

              const prefix = `[GitHub PR #${pr.number} review comment by @${comment.user.login}]`
              try {
                await client.session.promptAsync({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: `${prefix}\n\n${comment.body}` }] }
                })

                await addPRReviewCommentReaction(pr.owner, pr.repo, comment.id, "rocket")
                debug("Injected PR review comment into session:", sessionId.slice(0, 8))
              } catch (e) {
                reportError(e, { plugin: "github", op: "inject-pr-comment" })
              }
            }
          }

          if (comments.length > 0) {
            const maxId = Math.max(...comments.map(c => c.id))
            if (maxId > lastSeen) {
              lastSeenPRCommentId.set(key, maxId)
            }
          }
        } catch (e) {
          reportError(e, { plugin: "github", op: "poll-pr-comments", key })
        }
      }

      // Also poll PR issue-level comments (not review comments —
      // these are top-level PR conversation comments)
      for (const [key, sessionId] of prKeyToSession) {
        const pr = sessionToPR.get(sessionId)
        if (!pr) continue

        // PR issue-level comments use the same API as issue comments
        const prAsIssue: IssueInfo = {
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          url: pr.url
        }
        const prIssueKey = `pr-issue:${key}`

        try {
          const comments = await fetchIssueComments(prAsIssue)
          const lastSeen = lastSeenIssueCommentId.get(prIssueKey) || 0

          const newComments = comments
            .filter(c => c.id > lastSeen && !processedCommentIds.has(c.id))
            .reverse()

          for (const comment of newComments) {
            processedCommentIds.add(comment.id)

            if (hasCommentTrigger(comment.body, config.commentTrigger)) {
              debug("Actionable PR conversation comment found:", comment.id)

              try {
                await client.session.get({ path: { id: sessionId } })
              } catch {
                continue
              }

              const prefix = `[GitHub PR #${pr.number} comment by @${comment.user.login}]`
              try {
                await client.session.promptAsync({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: `${prefix}\n\n${comment.body}` }] }
                })

                await addCommentReaction(pr.owner, pr.repo, comment.id, "rocket")
              } catch (e) {
                reportError(e, { plugin: "github", op: "inject-pr-conversation-comment" })
              }
            }
          }

          if (comments.length > 0) {
            const maxId = Math.max(...comments.map(c => c.id))
            if (maxId > lastSeen) {
              lastSeenIssueCommentId.set(prIssueKey, maxId)
            }
          }
        } catch (e) {
          reportError(e, { plugin: "github", op: "poll-pr-conversation-comments", key })
        }
      }
    } catch (e) {
      reportError(e, { plugin: "github", op: "poll-comments" })
    }
  }

  /**
   * Start the polling loop for comment monitoring.
   */
  function startPolling() {
    if (pollTimer) return
    if (!config.monitorComments) return

    debug("Starting comment polling every", config.commentPollInterval, "ms")
    pollTimer = setInterval(async () => {
      try {
        await pollForComments()
      } catch (e) {
        reportError(e, { plugin: "github", op: "poll-interval" })
      }
    }, config.commentPollInterval)
  }

  /**
   * Seed the high-water marks with existing comments so we don't
   * re-process old comments on first run.
   */
  async function seedHighWaterMarks() {
    for (const [key, sessionId] of issueKeyToSession) {
      const issue = sessionToIssue.get(sessionId)
      if (!issue) continue
      if (lastSeenIssueCommentId.has(key)) continue

      try {
        const comments = await fetchIssueComments(issue)
        if (comments.length > 0) {
          const maxId = Math.max(...comments.map(c => c.id))
          lastSeenIssueCommentId.set(key, maxId)
          // Also mark all existing comment IDs as processed
          for (const c of comments) processedCommentIds.add(c.id)
          debug("Seeded issue comment HWM:", key, "=", maxId)
        }
      } catch {}
    }

    for (const [key, sessionId] of prKeyToSession) {
      const pr = sessionToPR.get(sessionId)
      if (!pr) continue

      // Seed PR review comments
      if (!lastSeenPRCommentId.has(key)) {
        try {
          const comments = await fetchPRReviewComments(pr)
          if (comments.length > 0) {
            const maxId = Math.max(...comments.map(c => c.id))
            lastSeenPRCommentId.set(key, maxId)
            for (const c of comments) processedCommentIds.add(c.id)
            debug("Seeded PR review comment HWM:", key, "=", maxId)
          }
        } catch {}
      }

      // Seed PR issue-level comments
      const prIssueKey = `pr-issue:${key}`
      if (!lastSeenIssueCommentId.has(prIssueKey)) {
        const prAsIssue: IssueInfo = { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url }
        try {
          const comments = await fetchIssueComments(prAsIssue)
          if (comments.length > 0) {
            const maxId = Math.max(...comments.map(c => c.id))
            lastSeenIssueCommentId.set(prIssueKey, maxId)
            for (const c of comments) processedCommentIds.add(c.id)
          }
        } catch {}
      }
    }
  }

  // ==================== EVENT HANDLER ====================

  return {
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (!config.enabled) return

      try {
        // Handle new messages — post to GitHub issue
        if (event.type === "message.updated" || event.type === "message.created") {
          const props = (event as any).properties
          const sessionId = props?.sessionID
          const messageId = props?.message?.id
          const role = props?.message?.info?.role
          const parts = props?.message?.parts
          const completed = (props?.message?.info?.time as any)?.completed

          if (!sessionId || !messageId || !parts) return

          // Only process completed messages
          if (!completed) return

          // Skip if already processed
          const msgKey = `${sessionId}:${messageId}`
          if (processedMessages.has(msgKey)) return
          processedMessages.add(msgKey)

          // Check role filtering
          if (role === "user" && !config.postUserMessages) return
          if (role === "assistant" && !config.postAssistantMessages) return

          // Extract text content
          const content = extractTextFromParts(parts)
          if (!content.trim()) return

          debug("Processing message:", role, "session:", sessionId.slice(0, 8), "length:", content.length)

          // Get or detect issue (use first user message for detection)
          let firstMessage: string | undefined
          if (role === "user" && !sessionIssues.has(sessionId)) {
            firstMessage = content
          }
          const issue = await getSessionIssue(sessionId, firstMessage)

          if (!issue) {
            debug("No issue associated with session, skipping")
            return
          }

          // Queue message for batched posting
          queueMessage(sessionId, role, content, {
            model: props?.message?.info?.model,
            timestamp: new Date()
          })
        }

        // Flush messages and register for monitoring on session idle
        if (event.type === "session.idle") {
          const sessionId = (event as any).properties?.sessionID
          if (!sessionId) return

          // Flush pending outbound messages
          if (pendingMessages.has(sessionId)) {
            const timer = batchTimers.get(sessionId)
            if (timer) clearTimeout(timer)
            batchTimers.delete(sessionId)
            await flushMessages(sessionId)
          }

          // Register this session for comment monitoring
          activeSessionId = sessionId
          await registerSessionForMonitoring(sessionId)

          // Seed high-water marks on first registration, then start polling
          if (!pollTimer && config.monitorComments && ghAvailable) {
            await seedHighWaterMarks()
            startPolling()
          }
        }
      } catch (e) {
        reportError(e, { plugin: "github", op: "event-handler" })
      }
    }
  }
}

export default GitHubPlugin
