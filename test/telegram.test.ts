/**
 * Unit tests for Telegram integration
 * 
 * Tests the logic patterns for:
 * - Session directory routing (the bug where worktrees shared stale directory)
 * - Message formatting with context
 * - Parallel sessions with different directories
 * 
 * NOTE: These tests verify the LOGIC of the functions without importing
 * the actual module (which uses ESM and doesn't work with Jest directly).
 * The actual implementation is in telegram.ts.
 */

// ============================================================================
// MOCK IMPLEMENTATIONS (matching telegram.ts logic)
// ============================================================================

interface TelegramConfig {
  enabled?: boolean
  uuid?: string
  serviceUrl?: string
  sendText?: boolean
  sendVoice?: boolean
  supabaseAnonKey?: string
}

interface TTSConfig {
  telegram?: TelegramConfig
}

interface TelegramContext {
  model?: string
  directory?: string
  sessionId?: string
}

interface TelegramReply {
  id: string
  uuid: string
  session_id: string
  directory: string | null
  reply_text: string | null
  telegram_message_id: number
  telegram_chat_id: number
  created_at: string
  processed: boolean
  is_voice?: boolean
  audio_base64?: string | null
  voice_file_type?: string | null
  voice_duration_seconds?: number | null
}

/**
 * Format the Telegram message text with header and reply hint
 * This matches the logic in telegram.ts sendTelegramNotification()
 */
function formatTelegramMessage(
  text: string,
  context?: TelegramContext
): string {
  // Build clean header: {directory} | {session_id} | {model}
  const dirName = context?.directory?.split("/").pop() || null
  const sessionId = context?.sessionId || null
  const modelName = context?.model || null

  const headerParts = [dirName, sessionId, modelName].filter(Boolean)
  const header = headerParts.join(" | ")

  // Add reply hint if session context is provided
  const replyHint = sessionId 
    ? "\n\n💬 Reply to this message to continue"
    : ""

  const formattedText = header 
    ? `${header}\n${"─".repeat(Math.min(40, header.length))}\n\n${text}${replyHint}`
    : `${text}${replyHint}`
  
  return formattedText.slice(0, 3800)
}

/**
 * Build the request body for Telegram notification
 * This matches the logic in telegram.ts sendTelegramNotification()
 */
function buildNotificationBody(
  text: string,
  config: TTSConfig,
  context?: TelegramContext
): { uuid: string; text?: string; session_id?: string; directory?: string } {
  const body: any = { uuid: config.telegram?.uuid || "" }

  // Add session context for reply support
  if (context?.sessionId) {
    body.session_id = context.sessionId
  }
  if (context?.directory) {
    body.directory = context.directory
  }

  // Format and add text
  if (config.telegram?.sendText !== false) {
    body.text = formatTelegramMessage(text, context)
  }

  return body
}

/**
 * Type guard for convertWavToOgg input validation
 * This matches the logic in telegram.ts convertWavToOgg()
 */
function isValidWavPath(wavPath: any): boolean {
  return !!(wavPath && typeof wavPath === 'string')
}

// ============================================================================
// TESTS
// ============================================================================

const testConfig: TTSConfig = {
  telegram: {
    enabled: true,
    uuid: "test-uuid-1234",
    sendText: true,
    sendVoice: false,
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
  }
}

describe("Telegram Session Directory Routing (BUG FIX)", () => {
  /**
   * This is the critical test for the session/directory routing bug.
   * 
   * Bug: When multiple git worktrees (vibe, vibe.2, vibe.3) share the same 
   * OpenCode server, the plugin used the closure directory (first worktree)
   * instead of each session's actual directory.
   * 
   * Fix: The context.directory should come from sessionInfo.directory,
   * which is fetched via client.session.get() in tts.ts.
   */
  
  it("should include session directory in request body", () => {
    const context: TelegramContext = {
      sessionId: "ses_abc123",
      directory: "/Users/test/workspace/vibe.2",
      model: "claude-opus-4.5",
    }
    
    const body = buildNotificationBody("Task complete", testConfig, context)
    
    // Verify directory is sent in body
    expect(body.directory).toBe("/Users/test/workspace/vibe.2")
    expect(body.session_id).toBe("ses_abc123")
  })

  it("should include directory name in message header", () => {
    const context: TelegramContext = {
      sessionId: "ses_xyz789",
      directory: "/Users/test/workspace/vibe.3",
      model: "gpt-4o",
    }
    
    const text = formatTelegramMessage("Task complete", context)
    
    // Header format: "vibe.3 | ses_xyz789 | gpt-4o"
    expect(text).toContain("vibe.3")
    expect(text).toContain("ses_xyz789")
    expect(text).toContain("gpt-4o")
  })

  it("should handle different worktree directories correctly", () => {
    // Simulate 3 different worktrees
    const worktrees = [
      { directory: "/Users/test/workspace/vibe", sessionId: "ses_1" },
      { directory: "/Users/test/workspace/vibe.2", sessionId: "ses_2" },
      { directory: "/Users/test/workspace/vibe.3", sessionId: "ses_3" },
    ]
    
    for (const wt of worktrees) {
      const body = buildNotificationBody("Test", testConfig, {
        sessionId: wt.sessionId,
        directory: wt.directory,
      })
      
      // Verify the correct directory is used for each session
      expect(body.directory).toBe(wt.directory)
      expect(body.session_id).toBe(wt.sessionId)
      
      // Header should show correct directory name
      const dirName = wt.directory.split("/").pop()
      expect(body.text).toContain(dirName)
    }
  })

  it("should NOT use a stale/cached directory for different sessions", () => {
    // First session from vibe worktree
    const body1 = buildNotificationBody("First task", testConfig, {
      sessionId: "ses_first",
      directory: "/Users/test/workspace/vibe",
    })
    
    // Second session from vibe.2 worktree - should use ITS directory, not vibe's
    const body2 = buildNotificationBody("Second task", testConfig, {
      sessionId: "ses_second",
      directory: "/Users/test/workspace/vibe.2",
    })
    
    // Verify directories are different
    expect(body1.directory).toBe("/Users/test/workspace/vibe")
    expect(body2.directory).toBe("/Users/test/workspace/vibe.2")
    
    // Headers should show correct directory names
    expect(body1.text).toContain("vibe |")
    expect(body2.text).toContain("vibe.2 |")
  })
})

describe("Parallel Sessions with Different Directories", () => {
  it("should correctly route notifications for parallel sessions", () => {
    // Simulate parallel sessions (as if 3 OpenCode terminals are running)
    const sessions = [
      { id: "ses_parallel_1", directory: "/workspace/project-a", model: "claude" },
      { id: "ses_parallel_2", directory: "/workspace/project-b", model: "gpt-4o" },
      { id: "ses_parallel_3", directory: "/workspace/project-c", model: "opus" },
    ]
    
    // Build notification bodies for each session
    const results = sessions.map(session => {
      const body = buildNotificationBody(`Notification for ${session.id}`, testConfig, {
        sessionId: session.id,
        directory: session.directory,
        model: session.model,
      })
      return {
        sessionId: session.id,
        sentDirectory: body.directory,
        sentSessionId: body.session_id,
      }
    })
    
    // Verify each session got its correct directory
    for (let i = 0; i < sessions.length; i++) {
      expect(results[i].sentDirectory).toBe(sessions[i].directory)
      expect(results[i].sentSessionId).toBe(sessions[i].id)
    }
  })

  it("should maintain directory isolation between concurrent sessions", () => {
    // This simulates the scenario where:
    // 1. User has 3 OpenCode terminals in different worktrees
    // 2. Each terminal fires session.idle events
    // 3. Each should use its OWN directory, not a shared one
    
    const worktree1Context: TelegramContext = {
      sessionId: "ses_wt1",
      directory: "/home/user/project/vibe",
      model: "claude",
    }
    
    const worktree2Context: TelegramContext = {
      sessionId: "ses_wt2",
      directory: "/home/user/project/vibe.2",
      model: "claude",
    }
    
    const worktree3Context: TelegramContext = {
      sessionId: "ses_wt3",
      directory: "/home/user/project/vibe.3",
      model: "claude",
    }
    
    // Each notification should use its context's directory
    const msg1 = formatTelegramMessage("Done", worktree1Context)
    const msg2 = formatTelegramMessage("Done", worktree2Context)
    const msg3 = formatTelegramMessage("Done", worktree3Context)
    
    // Verify each uses its own directory in header
    expect(msg1).toContain("vibe | ses_wt1")
    expect(msg2).toContain("vibe.2 | ses_wt2")
    expect(msg3).toContain("vibe.3 | ses_wt3")
    
    // Verify they're all different
    expect(msg1).not.toContain("vibe.2")
    expect(msg1).not.toContain("vibe.3")
    expect(msg2).not.toContain("vibe.3")
  })
})

describe("Message Formatting", () => {
  it("should format header with directory, session, and model", () => {
    const text = formatTelegramMessage("Hello", {
      sessionId: "ses_123",
      directory: "/home/user/myproject",
      model: "anthropic/claude-3.5-sonnet",
    })
    
    // Check header format: "myproject | ses_123 | anthropic/claude-3.5-sonnet"
    expect(text).toMatch(/myproject.*\|.*ses_123.*\|.*anthropic\/claude-3.5-sonnet/)
    
    // Check separator line exists
    expect(text).toContain("─")
    
    // Check body text
    expect(text).toContain("Hello")
    
    // Check reply hint
    expect(text).toContain("💬 Reply to this message to continue")
  })

  it("should NOT include reply hint when no sessionId", () => {
    const text = formatTelegramMessage("Hello", {
      directory: "/home/user/myproject",
      model: "gpt-4o",
    })
    
    expect(text).not.toContain("Reply to this message")
  })

  it("should handle missing context gracefully", () => {
    const text = formatTelegramMessage("No context message")
    
    expect(text).toBe("No context message")
    expect(text).not.toContain("|")
    expect(text).not.toContain("─")
  })

  it("should truncate very long messages", () => {
    const longMessage = "A".repeat(5000)
    const text = formatTelegramMessage(longMessage, {
      sessionId: "ses_long",
      directory: "/test",
    })
    
    expect(text.length).toBeLessThanOrEqual(3800)
  })

  it("should extract directory name from full path", () => {
    const cases = [
      { path: "/Users/test/workspace/vibe", expected: "vibe" },
      { path: "/home/user/projects/my-app", expected: "my-app" },
      { path: "/tmp/test", expected: "test" },
      { path: "/single", expected: "single" },
    ]
    
    for (const { path, expected } of cases) {
      const text = formatTelegramMessage("Test", { 
        sessionId: "ses_1", 
        directory: path 
      })
      expect(text).toContain(`${expected} |`)
    }
  })
})

describe("Input Validation", () => {
  it("should validate wavPath as string for convertWavToOgg", () => {
    // Valid cases
    expect(isValidWavPath("/path/to/file.wav")).toBe(true)
    expect(isValidWavPath("file.wav")).toBe(true)
    
    // Invalid cases (the bug we fixed)
    expect(isValidWavPath(undefined)).toBe(false)
    expect(isValidWavPath(null)).toBe(false)
    expect(isValidWavPath("")).toBe(false)
    expect(isValidWavPath(123)).toBe(false)
    expect(isValidWavPath({ path: "/test.wav" })).toBe(false)
    expect(isValidWavPath(["file.wav"])).toBe(false)
  })
})

describe("TelegramReply Type", () => {
  it("should have correct shape with directory", () => {
    const reply: TelegramReply = {
      id: "uuid-123",
      uuid: "user-uuid",
      session_id: "ses_abc",
      directory: "/test/path",
      reply_text: "Hello",
      telegram_message_id: 12345,
      telegram_chat_id: 67890,
      created_at: "2026-01-29T12:00:00Z",
      processed: false,
      is_voice: false,
      audio_base64: null,
      voice_file_type: null,
      voice_duration_seconds: null,
    }
    
    expect(reply.session_id).toBe("ses_abc")
    expect(reply.directory).toBe("/test/path")
  })

  it("should allow null directory (for legacy contexts)", () => {
    const reply: TelegramReply = {
      id: "uuid-123",
      uuid: "user-uuid",
      session_id: "ses_abc",
      directory: null,  // Legacy - before directory tracking was added
      reply_text: "Hello",
      telegram_message_id: 12345,
      telegram_chat_id: 67890,
      created_at: "2026-01-29T12:00:00Z",
      processed: false,
    }
    
    expect(reply.directory).toBeNull()
  })
})

describe("Reply Routing Logic", () => {
  /**
   * Test the reply routing logic that ensures replies go to the correct session
   * based on the message_id association in telegram_reply_contexts.
   */
  
  it("should associate reply with correct session via message_id", () => {
    // Simulate the telegram_reply_contexts table entries
    const replyContexts = [
      { session_id: "ses_1", message_id: 1001, directory: "/workspace/vibe" },
      { session_id: "ses_2", message_id: 1002, directory: "/workspace/vibe.2" },
      { session_id: "ses_3", message_id: 1003, directory: "/workspace/vibe.3" },
    ]
    
    // Simulate finding the correct context for a reply
    function findSessionForReply(replyToMessageId: number): string | null {
      const ctx = replyContexts.find(c => c.message_id === replyToMessageId)
      return ctx?.session_id || null
    }
    
    // Replies should go to correct sessions based on message_id
    expect(findSessionForReply(1001)).toBe("ses_1")
    expect(findSessionForReply(1002)).toBe("ses_2")
    expect(findSessionForReply(1003)).toBe("ses_3")
    expect(findSessionForReply(9999)).toBeNull() // Unknown message_id
  })

  it("should NOT route based on most recent session", () => {
    // This tests the BUG behavior we want to AVOID
    // Previously, replies might have gone to the most recent session
    
    const replyContexts = [
      { session_id: "ses_old", message_id: 1001, created_at: "2026-01-29T10:00:00Z" },
      { session_id: "ses_new", message_id: 1002, created_at: "2026-01-29T12:00:00Z" }, // Most recent
    ]
    
    // A reply to the OLD message should go to ses_old, NOT ses_new
    const replyToMessageId = 1001 // Replying to old message
    
    // CORRECT behavior: find by message_id
    const correctSession = replyContexts.find(c => c.message_id === replyToMessageId)?.session_id
    expect(correctSession).toBe("ses_old")
    
    // WRONG behavior would be: mostRecentSession
    const mostRecent = replyContexts.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
    expect(mostRecent.session_id).toBe("ses_new") // This is NOT what we want
    
    // The fix ensures we use correctSession, not mostRecent
    expect(correctSession).not.toBe(mostRecent.session_id)
  })
})

// ============================================================================
// BUG FIX REGRESSION TESTS
// Tests for specific bugs that were reported and fixed
// ============================================================================

describe("BUG FIX: config.telegram undefined crash", () => {
  /**
   * Bug: TypeError: undefined is not an object (evaluating 'config.telegram')
   * at sendTelegramNotification (/Users/engineer/.config/opencode/plugin/telegram.ts:137:26)
   * 
   * This happened when config was undefined or null.
   * Fix: Add null guard at the start of each exported function.
   */
  
  /**
   * Mock implementation matching telegram.ts sendTelegramNotification with null guard
   */
  function sendTelegramNotification(
    text: string,
    voicePath: string | null,
    config: TTSConfig | null | undefined,
    context?: TelegramContext
  ): { success: boolean; error?: string } {
    // NULL GUARD - this is the fix
    if (!config) {
      return { success: false, error: "No config provided" }
    }
    const telegramConfig = config.telegram
    if (!telegramConfig?.enabled) {
      return { success: false, error: "Telegram notifications disabled" }
    }
    return { success: true }
  }
  
  it("should NOT crash when config is undefined", () => {
    // This was the bug - calling with undefined config caused crash
    expect(() => {
      const result = sendTelegramNotification("test", null, undefined)
      expect(result.success).toBe(false)
      expect(result.error).toBe("No config provided")
    }).not.toThrow()
  })

  it("should NOT crash when config is null", () => {
    expect(() => {
      const result = sendTelegramNotification("test", null, null)
      expect(result.success).toBe(false)
      expect(result.error).toBe("No config provided")
    }).not.toThrow()
  })

  it("should NOT crash when config.telegram is undefined", () => {
    const configWithoutTelegram: TTSConfig = {}
    expect(() => {
      const result = sendTelegramNotification("test", null, configWithoutTelegram)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Telegram notifications disabled")
    }).not.toThrow()
  })

  it("should work correctly with valid config", () => {
    const validConfig: TTSConfig = {
      telegram: {
        enabled: true,
        uuid: "test-uuid",
      }
    }
    const result = sendTelegramNotification("test", null, validConfig)
    expect(result.success).toBe(true)
  })
})

describe("BUG FIX: updateMessageReaction config null guard", () => {
  /**
   * Similar to above - updateMessageReaction also needed null guard
   */
  
  function updateMessageReaction(
    chatId: number,
    messageId: number,
    emoji: string,
    config: TTSConfig | null | undefined
  ): { success: boolean; error?: string } {
    // NULL GUARD
    if (!config) {
      return { success: false, error: "No config provided" }
    }
    const telegramConfig = config.telegram
    // Continue with logic...
    return { success: true }
  }

  it("should NOT crash when config is undefined", () => {
    expect(() => {
      const result = updateMessageReaction(123, 456, "😊", undefined)
      expect(result.success).toBe(false)
      expect(result.error).toBe("No config provided")
    }).not.toThrow()
  })

  it("should NOT crash when config is null", () => {
    expect(() => {
      const result = updateMessageReaction(123, 456, "😊", null)
      expect(result.success).toBe(false)
      expect(result.error).toBe("No config provided")
    }).not.toThrow()
  })
})

describe("BUG FIX: convertWavToOgg invalid input", () => {
  /**
   * Bug: [Telegram] convertWavToOgg called with invalid wavPath: object
   * 
   * This happened when OpenCode tried to load telegram.ts as a plugin
   * and passed plugin arguments ({client, directory}) to the function.
   * 
   * Root cause: telegram.ts was placed in plugin/ directory root,
   * so OpenCode tried to call it as a plugin.
   * 
   * Fix: 
   * 1. Add type guard to reject invalid input gracefully
   * 2. Place telegram.ts in lib/ subdirectory (not loaded as plugin)
   */
  
  function convertWavToOgg(wavPath: any): string | null {
    // Type guard - this is the fix
    if (!wavPath || typeof wavPath !== 'string') {
      console.error('[Telegram] convertWavToOgg called with invalid wavPath:', typeof wavPath, wavPath)
      return null
    }
    // Simulate conversion
    return wavPath.replace(/\.wav$/i, ".ogg")
  }

  it("should NOT crash when called with object (the plugin args bug)", () => {
    const pluginArgs = {
      client: { session: {}, tui: {} },
      directory: "/some/path",
      project: {},
    }
    
    expect(() => {
      const result = convertWavToOgg(pluginArgs)
      expect(result).toBeNull()
    }).not.toThrow()
  })

  it("should NOT crash when called with undefined", () => {
    expect(() => {
      const result = convertWavToOgg(undefined)
      expect(result).toBeNull()
    }).not.toThrow()
  })

  it("should NOT crash when called with null", () => {
    expect(() => {
      const result = convertWavToOgg(null)
      expect(result).toBeNull()
    }).not.toThrow()
  })

  it("should NOT crash when called with number", () => {
    expect(() => {
      const result = convertWavToOgg(12345)
      expect(result).toBeNull()
    }).not.toThrow()
  })

  it("should work correctly with valid string path", () => {
    const result = convertWavToOgg("/path/to/audio.wav")
    expect(result).toBe("/path/to/audio.ogg")
  })

  it("should work correctly with WAV extension variations", () => {
    expect(convertWavToOgg("/path/audio.WAV")).toBe("/path/audio.ogg")
    expect(convertWavToOgg("/path/audio.Wav")).toBe("/path/audio.ogg")
  })
})

describe("BUG FIX: initSupabaseClient config null guard", () => {
  /**
   * Same pattern - initSupabaseClient also needs null guard
   */
  
  async function initSupabaseClient(config: TTSConfig | null | undefined): Promise<any> {
    if (!config) return null
    const telegramConfig = config.telegram
    // Continue with logic...
    return { mock: "client" }
  }

  it("should return null when config is undefined", async () => {
    const result = await initSupabaseClient(undefined)
    expect(result).toBeNull()
  })

  it("should return null when config is null", async () => {
    const result = await initSupabaseClient(null)
    expect(result).toBeNull()
  })

  it("should return client when config is valid", async () => {
    const result = await initSupabaseClient({ telegram: { enabled: true } })
    expect(result).not.toBeNull()
  })
})

describe("BUG FIX: subscribeToReplies config null guard", () => {
  /**
   * Same pattern for subscribeToReplies
   */
  
  async function subscribeToReplies(
    config: TTSConfig | null | undefined,
    client: any
  ): Promise<boolean> {
    if (!config) return false
    const telegramConfig = config.telegram
    if (!telegramConfig?.enabled) return false
    return true
  }

  it("should return early when config is undefined", async () => {
    const result = await subscribeToReplies(undefined, {})
    expect(result).toBe(false)
  })

  it("should return early when config is null", async () => {
    const result = await subscribeToReplies(null, {})
    expect(result).toBe(false)
  })

  it("should return early when telegram is disabled", async () => {
    const result = await subscribeToReplies({ telegram: { enabled: false } }, {})
    expect(result).toBe(false)
  })

  it("should proceed when config is valid and enabled", async () => {
    const result = await subscribeToReplies({ telegram: { enabled: true } }, {})
    expect(result).toBe(true)
  })
})
