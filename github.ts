/**
 * GitHub Issue Integration Plugin for OpenCode
 *
 * Posts all agent messages to the associated GitHub issue as comments,
 * keeping a complete history of the agent's work and thought process.
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
 *   "issueLabels": ["opencode", "ai-session"]
 * }
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, access } from "fs/promises"
import { exec } from "child_process"
import { promisify } from "util"
import { join } from "path"
import { homedir } from "os"

const execAsync = promisify(exec)

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
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "github.json")
const ISSUE_FILE = ".github-issue.md"
const MAX_COMMENT_LENGTH = 65000 // GitHub's limit is 65536

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

function getConfig(config: GitHubConfig): Required<GitHubConfig> {
  return {
    enabled: config.enabled ?? true,
    postUserMessages: config.postUserMessages ?? false,
    postAssistantMessages: config.postAssistantMessages ?? true,
    postToolCalls: config.postToolCalls ?? false,
    batchInterval: config.batchInterval ?? 5000,
    maxMessageLength: config.maxMessageLength ?? MAX_COMMENT_LENGTH,
    createIssueIfMissing: config.createIssueIfMissing ?? true,
    issueLabels: config.issueLabels ?? ["opencode", "ai-session"]
  }
}

// ==================== ISSUE DETECTION ====================

interface IssueInfo {
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
  config: Required<GitHubConfig>
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
    const { stdout } = await execAsync(
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

// ==================== PLUGIN ====================

export const GitHubPlugin: Plugin = async ({ client, directory }) => {
  if (!client) {
    return {}
  }
  debug("GitHub plugin initializing for directory:", directory)

  // Session state
  const sessionIssues = new Map<string, IssueInfo | null>()
  const pendingMessages = new Map<string, Array<{ role: string; content: string; metadata?: any }>>()
  const batchTimers = new Map<string, NodeJS.Timeout>()
  const processedMessages = new Set<string>()

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

  return {
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (!config.enabled) return

      // Handle new messages
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

      // Flush messages on session idle
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (sessionId && pendingMessages.has(sessionId)) {
          // Clear any existing timer
          const timer = batchTimers.get(sessionId)
          if (timer) clearTimeout(timer)
          batchTimers.delete(sessionId)

          // Flush immediately
          await flushMessages(sessionId)
        }
      }
    }
  }
}

export default GitHubPlugin
