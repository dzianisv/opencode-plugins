/**
 * Telegram Plugin — Unit Tests
 *
 * Tests the Telegram plugin's internal logic without hitting real APIs.
 * Uses the test-helpers extraction pattern (same as reflection-3.test-helpers.ts).
 *
 * These tests cover:
 *   1. Session helpers (isJudgeSession, isSessionComplete, extractFinalResponse)
 *   2. Notification formatting & config validation
 *   3. Reply routing logic (text & voice)
 *   4. Reflection verdict gating
 */

import assert from "node:assert"
import {
  isJudgeSession,
  isSessionComplete,
  findStaticReflectionPromptIndex,
  extractFinalResponse,
  formatNotificationText,
  validateNotificationConfig,
  buildReplyPrefix,
  voiceFileTypeToFormat,
  canRouteReply,
  waitForReflectionVerdict,
  shouldSendAfterVerdict,
  TelegramConfig,
  TelegramReply,
  ReflectionVerdict,
} from "../telegram.test-helpers.ts"

// ============================================================================
// Helpers to build realistic OpenCode message arrays
// ============================================================================

function userMsg(text: string) {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text }],
  }
}

function assistantMsg(text: string, opts?: { completed?: boolean; error?: any }) {
  const time: any = {}
  if (opts?.completed) time.completed = Date.now()
  return {
    info: {
      role: "assistant",
      time,
      ...(opts?.error ? { error: opts.error } : {}),
    },
    parts: [{ type: "text", text }],
  }
}

function makeReply(overrides: Partial<TelegramReply> = {}): TelegramReply {
  return {
    id: "test-id",
    uuid: "test-uuid",
    session_id: "ses_test123",
    directory: "/tmp/test",
    reply_text: "hello from telegram",
    telegram_message_id: 12345,
    telegram_chat_id: 67890,
    created_at: new Date().toISOString(),
    processed: false,
    is_voice: false,
    ...overrides,
  }
}

// ============================================================================
// 1. SESSION HELPERS
// ============================================================================

describe("telegram unit: session helpers", () => {
  // -- isJudgeSession ---------------------------------------------------------

  it("isJudgeSession: detects 'You are a judge' in first user message", () => {
    const msgs = [
      userMsg("You are a judge evaluating the assistant"),
      assistantMsg("Understood"),
    ]
    assert.strictEqual(isJudgeSession(msgs), true)
  })

  it("isJudgeSession: detects 'Task to evaluate'", () => {
    const msgs = [userMsg("Task to evaluate: implement login")]
    assert.strictEqual(isJudgeSession(msgs), true)
  })

  it("isJudgeSession: returns false for normal conversation", () => {
    const msgs = [userMsg("Fix the login bug"), assistantMsg("Done!")]
    assert.strictEqual(isJudgeSession(msgs), false)
  })

  it("isJudgeSession: returns false for empty messages", () => {
    assert.strictEqual(isJudgeSession([]), false)
  })

  it("isJudgeSession: detects judge text in later messages", () => {
    const msgs = [
      userMsg("Implement feature"),
      assistantMsg("Working on it..."),
      userMsg("You are a judge — evaluate the work"),
    ]
    // All messages are scanned for internal session markers
    assert.strictEqual(isJudgeSession(msgs), true)
  })

  it("isJudgeSession: detects ANALYZE REFLECTION-3 marker", () => {
    const msgs = [
      userMsg("ANALYZE REFLECTION-3\n\nEvaluate the agent's self-assessment..."),
      assistantMsg('{"complete": true}'),
    ]
    assert.strictEqual(isJudgeSession(msgs), true)
  })

  it("isJudgeSession: detects CLASSIFY TASK ROUTING marker", () => {
    const msgs = [
      userMsg("CLASSIFY TASK ROUTING\n\nClassify into: backend, frontend, default"),
      assistantMsg('{"category": "backend"}'),
    ]
    assert.strictEqual(isJudgeSession(msgs), true)
  })

  // -- isSessionComplete ------------------------------------------------------

  it("isSessionComplete: true when time.completed is set", () => {
    const msgs = [userMsg("Hi"), assistantMsg("Done", { completed: true })]
    assert.strictEqual(isSessionComplete(msgs), true)
  })

  it("isSessionComplete: false when no assistant message", () => {
    assert.strictEqual(isSessionComplete([userMsg("Hi")]), false)
  })

  it("isSessionComplete: false when assistant has error", () => {
    const msgs = [
      userMsg("Do it"),
      assistantMsg("Starting...", {
        error: { name: "MessageAbortedError", message: "cancelled" },
      }),
    ]
    assert.strictEqual(isSessionComplete(msgs), false)
  })

  it("isSessionComplete: false when time.completed is missing", () => {
    const msgs = [userMsg("Hi"), assistantMsg("Here's the answer")]
    assert.strictEqual(isSessionComplete(msgs), false)
  })

  it("isSessionComplete: uses last assistant message, not first", () => {
    const msgs = [
      userMsg("Step 1"),
      assistantMsg("Partial", { completed: false }),
      userMsg("Step 2"),
      assistantMsg("All done", { completed: true }),
    ]
    assert.strictEqual(isSessionComplete(msgs), true)
  })

  // -- findStaticReflectionPromptIndex ----------------------------------------

  it("findStaticReflectionPromptIndex: finds self-assessment marker", () => {
    const msgs = [
      userMsg("Implement X"),
      assistantMsg("Done"),
      userMsg("## Reflection-3 Self-Assessment\nEvaluate yourself"),
    ]
    assert.strictEqual(findStaticReflectionPromptIndex(msgs), 2)
  })

  it("findStaticReflectionPromptIndex: finds feedback marker", () => {
    const msgs = [
      userMsg("Implement X"),
      assistantMsg("Done"),
      userMsg("## Reflection-3: your tests are failing"),
    ]
    assert.strictEqual(findStaticReflectionPromptIndex(msgs), 2)
  })

  it("findStaticReflectionPromptIndex: returns -1 for normal conversation", () => {
    const msgs = [userMsg("Fix bug"), assistantMsg("Fixed")]
    assert.strictEqual(findStaticReflectionPromptIndex(msgs), -1)
  })

  it("findStaticReflectionPromptIndex: ignores markers in assistant messages", () => {
    const msgs = [
      userMsg("Help"),
      assistantMsg("## Reflection-3 Self-Assessment\n...this is fine"),
    ]
    // Only looks at user messages
    assert.strictEqual(findStaticReflectionPromptIndex(msgs), -1)
  })

  // -- extractFinalResponse ---------------------------------------------------

  it("extractFinalResponse: returns last assistant text", () => {
    const msgs = [userMsg("Hi"), assistantMsg("Hello there")]
    assert.strictEqual(extractFinalResponse(msgs), "Hello there")
  })

  it("extractFinalResponse: skips reflection artifacts", () => {
    const msgs = [
      userMsg("Implement feature"),
      assistantMsg("Feature implemented successfully"),
      userMsg("## Reflection-3 Self-Assessment\nEvaluate"),
      assistantMsg('{"status":"complete","confidence":0.9}'),
    ]
    assert.strictEqual(extractFinalResponse(msgs), "Feature implemented successfully")
  })

  it("extractFinalResponse: handles feedback + second response cycle", () => {
    const msgs = [
      userMsg("Build API"),
      assistantMsg("API built"),
      userMsg("## Reflection-3 Self-Assessment\nEvaluate"),
      assistantMsg('{"status":"incomplete"}'),
      userMsg("## Reflection-3: tests are missing"),
      assistantMsg("Added tests, all passing now"),
    ]
    // The reflection marker is at index 2, so extractFinalResponse looks
    // backwards from index 1 (cutoff - 1) and finds "API built".
    assert.strictEqual(extractFinalResponse(msgs), "API built")
  })

  it("extractFinalResponse: returns empty string for no assistant messages", () => {
    const msgs = [userMsg("Hello")]
    assert.strictEqual(extractFinalResponse(msgs), "")
  })

  it("extractFinalResponse: skips empty assistant text and finds previous", () => {
    const msgs = [
      userMsg("Do something"),
      assistantMsg("Real answer"),
      assistantMsg(""),
    ]
    // No reflection marker, so startIndex = msgs.length - 1 = 2.
    // i=2 -> "" (skipped), i=1 -> "Real answer" (returned).
    assert.strictEqual(extractFinalResponse(msgs), "Real answer")
  })

  it("extractFinalResponse: finds non-empty assistant scanning backwards", () => {
    const msgs = [
      userMsg("Do something"),
      assistantMsg("Real answer"),
      { info: { role: "assistant" }, parts: [{ type: "text", text: "  " }] },
    ]
    // "  ".trim() is "" so it skips, then finds "Real answer"
    assert.strictEqual(extractFinalResponse(msgs), "Real answer")
  })

  it("extractFinalResponse: joins multiple text parts", () => {
    const msgs = [
      userMsg("Go"),
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Part 1" },
          { type: "tool_call", text: "ignored" },
          { type: "text", text: "Part 2" },
        ],
      },
    ]
    assert.strictEqual(extractFinalResponse(msgs), "Part 1\nPart 2")
  })
})

// ============================================================================
// 2. NOTIFICATION FORMATTING & CONFIG VALIDATION
// ============================================================================

describe("telegram unit: notification formatting", () => {
  it("formatNotificationText: includes directory, session, model in header", () => {
    const result = formatNotificationText("Task done", {
      directory: "/home/user/my-project",
      sessionId: "ses_abc123",
      model: "gpt-5",
    })
    assert.ok(result.includes("my-project"), "should include directory basename")
    assert.ok(result.includes("ses_abc123"), "should include session ID")
    assert.ok(result.includes("gpt-5"), "should include model")
    assert.ok(result.includes("Task done"), "should include body text")
    assert.ok(result.includes("─"), "should include separator line")
    assert.ok(result.includes("💬 Reply"), "should include reply hint when sessionId present")
  })

  it("formatNotificationText: no header when no context", () => {
    const result = formatNotificationText("Just text")
    assert.ok(!result.includes("─"), "no separator without header")
    assert.ok(!result.includes("💬"), "no reply hint without sessionId")
    assert.strictEqual(result, "Just text")
  })

  it("formatNotificationText: no reply hint when no sessionId", () => {
    const result = formatNotificationText("Done", { directory: "/tmp/project" })
    assert.ok(result.includes("project"))
    assert.ok(!result.includes("💬"))
  })

  it("formatNotificationText: truncates at 3800 characters", () => {
    const longText = "A".repeat(5000)
    const result = formatNotificationText(longText)
    assert.ok(result.length <= 3800)
  })

  it("validateNotificationConfig: fails when disabled", () => {
    const r = validateNotificationConfig({ enabled: false }, "text", null)
    assert.strictEqual(r.canSend, false)
    assert.ok(r.error?.includes("disabled"))
  })

  it("validateNotificationConfig: fails when no UUID", () => {
    const oldEnv = process.env.TELEGRAM_NOTIFICATION_UUID
    delete process.env.TELEGRAM_NOTIFICATION_UUID
    const r = validateNotificationConfig({ enabled: true }, "text", null)
    assert.strictEqual(r.canSend, false)
    assert.ok(r.error?.includes("UUID"))
    process.env.TELEGRAM_NOTIFICATION_UUID = oldEnv
  })

  it("validateNotificationConfig: succeeds with UUID from env", () => {
    const oldEnv = process.env.TELEGRAM_NOTIFICATION_UUID
    process.env.TELEGRAM_NOTIFICATION_UUID = "test-env-uuid"
    const r = validateNotificationConfig({ enabled: true }, "text", null)
    assert.strictEqual(r.canSend, true)
    process.env.TELEGRAM_NOTIFICATION_UUID = oldEnv
  })

  it("validateNotificationConfig: succeeds with UUID from config", () => {
    const r = validateNotificationConfig(
      { enabled: true, uuid: "config-uuid" },
      "text",
      null
    )
    assert.strictEqual(r.canSend, true)
  })

  it("validateNotificationConfig: fails when no content to send", () => {
    const r = validateNotificationConfig(
      { enabled: true, uuid: "u", sendText: false, sendVoice: false },
      "text",
      "/voice.ogg"
    )
    assert.strictEqual(r.canSend, false)
    assert.ok(r.error?.includes("No content"))
  })

  it("validateNotificationConfig: voice-only succeeds", () => {
    const r = validateNotificationConfig(
      { enabled: true, uuid: "u", sendText: false },
      null,
      "/voice.ogg"
    )
    assert.strictEqual(r.canSend, true)
  })
})

// ============================================================================
// 3. REPLY ROUTING
// ============================================================================

describe("telegram unit: reply routing", () => {
  // -- prefix tagging ---------------------------------------------------------

  it("buildReplyPrefix: text reply", () => {
    assert.strictEqual(buildReplyPrefix(false), "[User via Telegram]")
  })

  it("buildReplyPrefix: voice reply", () => {
    assert.strictEqual(buildReplyPrefix(true), "[User via Telegram Voice]")
  })

  // -- voice format detection -------------------------------------------------

  it("voiceFileTypeToFormat: voice -> ogg", () => {
    assert.strictEqual(voiceFileTypeToFormat("voice"), "ogg")
  })

  it("voiceFileTypeToFormat: video_note -> mp4", () => {
    assert.strictEqual(voiceFileTypeToFormat("video_note"), "mp4")
  })

  it("voiceFileTypeToFormat: video -> mp4", () => {
    assert.strictEqual(voiceFileTypeToFormat("video"), "mp4")
  })

  it("voiceFileTypeToFormat: null defaults to ogg", () => {
    assert.strictEqual(voiceFileTypeToFormat(null), "ogg")
  })

  it("voiceFileTypeToFormat: undefined defaults to ogg", () => {
    assert.strictEqual(voiceFileTypeToFormat(undefined), "ogg")
  })

  // -- canRouteReply ----------------------------------------------------------

  it("canRouteReply: text reply with session_id is routable", () => {
    const r = canRouteReply(makeReply())
    assert.strictEqual(r.routable, true)
  })

  it("canRouteReply: voice reply with audio_base64 is routable", () => {
    const r = canRouteReply(
      makeReply({
        reply_text: null,
        is_voice: true,
        audio_base64: "base64data",
      })
    )
    assert.strictEqual(r.routable, true)
  })

  it("canRouteReply: missing session_id is not routable", () => {
    const r = canRouteReply(makeReply({ session_id: "" }))
    assert.strictEqual(r.routable, false)
    assert.ok(r.reason?.includes("session_id"))
  })

  it("canRouteReply: no text and no voice is not routable", () => {
    const r = canRouteReply(makeReply({ reply_text: null, is_voice: false }))
    assert.strictEqual(r.routable, false)
    assert.ok(r.reason?.includes("No text or voice"))
  })

  it("canRouteReply: voice without audio_base64 is not routable", () => {
    const r = canRouteReply(
      makeReply({ reply_text: null, is_voice: true, audio_base64: null })
    )
    assert.strictEqual(r.routable, false)
  })

  it("canRouteReply: text takes precedence even when voice fields are empty", () => {
    const r = canRouteReply(
      makeReply({ reply_text: "hi", is_voice: false, audio_base64: null })
    )
    assert.strictEqual(r.routable, true)
  })
})

// ============================================================================
// 4. REFLECTION VERDICT GATING
// ============================================================================

describe("telegram unit: reflection verdict gating", () => {
  // -- shouldSendAfterVerdict -------------------------------------------------

  it("shouldSendAfterVerdict: sends when gating disabled", () => {
    const verdict: ReflectionVerdict = {
      sessionId: "ses_1",
      complete: false,
      severity: "HIGH",
      timestamp: Date.now(),
    }
    const r = shouldSendAfterVerdict(verdict, false)
    assert.strictEqual(r.send, true)
    assert.ok(r.reason.includes("disabled"))
  })

  it("shouldSendAfterVerdict: sends when no verdict found", () => {
    const r = shouldSendAfterVerdict(null, true)
    assert.strictEqual(r.send, true)
    assert.ok(r.reason.includes("No reflection verdict"))
  })

  it("shouldSendAfterVerdict: sends when verdict is COMPLETE", () => {
    const verdict: ReflectionVerdict = {
      sessionId: "ses_1",
      complete: true,
      severity: "NONE",
      timestamp: Date.now(),
    }
    const r = shouldSendAfterVerdict(verdict, true)
    assert.strictEqual(r.send, true)
    assert.ok(r.reason.includes("COMPLETE"))
  })

  it("shouldSendAfterVerdict: suppresses when verdict is INCOMPLETE", () => {
    const verdict: ReflectionVerdict = {
      sessionId: "ses_1",
      complete: false,
      severity: "HIGH",
      timestamp: Date.now(),
    }
    const r = shouldSendAfterVerdict(verdict, true)
    assert.strictEqual(r.send, false)
    assert.ok(r.reason.includes("INCOMPLETE"))
    assert.ok(r.reason.includes("HIGH"))
  })

  // -- waitForReflectionVerdict (with custom readFileFn) ----------------------

  it("waitForReflectionVerdict: returns fresh verdict immediately", async () => {
    const now = Date.now()
    const mockVerdict: ReflectionVerdict = {
      sessionId: "ses_abc12345",
      complete: true,
      severity: "NONE",
      timestamp: now,
    }

    const readFn = async (_path: string) => JSON.stringify(mockVerdict)

    const result = await waitForReflectionVerdict("/tmp/project", "ses_abc12345", 500, readFn)
    assert.ok(result)
    assert.strictEqual(result!.complete, true)
    assert.strictEqual(result!.severity, "NONE")
  })

  it("waitForReflectionVerdict: ignores stale verdict (>30s old)", async () => {
    const staleVerdict: ReflectionVerdict = {
      sessionId: "ses_stale123",
      complete: true,
      severity: "NONE",
      timestamp: Date.now() - 60_000, // 60 seconds old
    }

    const readFn = async (_path: string) => JSON.stringify(staleVerdict)

    // Should timeout because the only verdict available is stale
    const result = await waitForReflectionVerdict("/tmp", "ses_stale123", 300, readFn)
    assert.strictEqual(result, null)
  }, 5_000)

  it("waitForReflectionVerdict: returns null when file not found within timeout", async () => {
    const readFn = async (_path: string): Promise<string> => {
      throw new Error("ENOENT")
    }

    const result = await waitForReflectionVerdict("/tmp", "ses_nofile00", 300, readFn)
    assert.strictEqual(result, null)
  }, 5_000)

  it("waitForReflectionVerdict: returns verdict that appears after initial miss", async () => {
    const now = Date.now()
    let callCount = 0
    const freshVerdict: ReflectionVerdict = {
      sessionId: "ses_delayed0",
      complete: false,
      severity: "BLOCKER",
      timestamp: now,
    }

    const readFn = async (_path: string): Promise<string> => {
      callCount++
      if (callCount < 3) throw new Error("ENOENT")
      return JSON.stringify(freshVerdict)
    }

    const result = await waitForReflectionVerdict("/tmp", "ses_delayed0", 5_000, readFn)
    assert.ok(result)
    assert.strictEqual(result!.complete, false)
    assert.strictEqual(result!.severity, "BLOCKER")
    assert.ok(callCount >= 3, "should have polled multiple times")
  }, 10_000)

  it("waitForReflectionVerdict: constructs correct signal path", async () => {
    let requestedPath = ""
    const readFn = async (path: string): Promise<string> => {
      requestedPath = path
      return JSON.stringify({
        sessionId: "ses_path1234",
        complete: true,
        severity: "NONE",
        timestamp: Date.now(),
      })
    }

    await waitForReflectionVerdict("/my/project", "ses_path1234", 500, readFn)
    // session ID prefix is first 8 chars: "ses_path"
    assert.ok(
      requestedPath.includes(".reflection"),
      `path should include .reflection dir: ${requestedPath}`
    )
    assert.ok(
      requestedPath.includes("verdict_ses_path"),
      `path should use first 8 chars of session ID: ${requestedPath}`
    )
  })
})

// ============================================================================
// 5. END-TO-END FLOW SIMULATION (no network)
// ============================================================================

describe("telegram unit: end-to-end flow simulation", () => {
  it("full flow: session not complete → no notification", () => {
    const msgs = [userMsg("Build feature"), assistantMsg("Working on it...")]
    assert.strictEqual(isSessionComplete(msgs), false)
    // Plugin would return early here
  })

  it("full flow: judge session → skip notification", () => {
    const msgs = [
      userMsg("You are a judge. Evaluate the task."),
      assistantMsg("The task is complete."),
    ]
    assert.strictEqual(isJudgeSession(msgs), true)
    // Plugin would return early here
  })

  it("full flow: complete session → extract text → validate config → format", () => {
    const msgs = [
      userMsg("Implement login page"),
      assistantMsg("Login page implemented with tests passing", { completed: true }),
    ]

    // Step 1: session is complete
    assert.strictEqual(isSessionComplete(msgs), true)
    assert.strictEqual(isJudgeSession(msgs), false)

    // Step 2: extract response
    const text = extractFinalResponse(msgs)
    assert.strictEqual(text, "Login page implemented with tests passing")

    // Step 3: validate config
    const config: TelegramConfig = { enabled: true, uuid: "test-uuid" }
    const validation = validateNotificationConfig(config, text, null)
    assert.strictEqual(validation.canSend, true)

    // Step 4: format notification
    const formatted = formatNotificationText(text.slice(0, 1000), {
      sessionId: "ses_login123",
      directory: "/home/user/webapp",
    })
    assert.ok(formatted.includes("webapp"))
    assert.ok(formatted.includes("ses_login123"))
    assert.ok(formatted.includes("Login page implemented"))
    assert.ok(formatted.includes("💬 Reply"))
  })

  it("full flow: reflection incomplete → suppress notification", () => {
    const msgs = [
      userMsg("Add unit tests"),
      assistantMsg("Tests added, all passing", { completed: true }),
    ]

    assert.strictEqual(isSessionComplete(msgs), true)

    const verdict: ReflectionVerdict = {
      sessionId: "ses_tests12",
      complete: false,
      severity: "HIGH",
      timestamp: Date.now(),
    }
    const decision = shouldSendAfterVerdict(verdict, true)
    assert.strictEqual(decision.send, false)
  })

  it("full flow: reply arrives → route to session", () => {
    const reply = makeReply({
      session_id: "ses_target1",
      reply_text: "Please also add validation",
    })

    // Step 1: check routability
    const routing = canRouteReply(reply)
    assert.strictEqual(routing.routable, true)

    // Step 2: build prefix
    const prefix = buildReplyPrefix(false)
    assert.strictEqual(prefix, "[User via Telegram]")

    // Step 3: the text that would be injected
    const injectedText = `${prefix} ${reply.reply_text}`
    assert.strictEqual(injectedText, "[User via Telegram] Please also add validation")
  })

  it("full flow: voice reply → determine format → build prefix", () => {
    const reply = makeReply({
      session_id: "ses_voice1",
      reply_text: null,
      is_voice: true,
      audio_base64: "base64voicedata",
      voice_file_type: "voice",
    })

    const routing = canRouteReply(reply)
    assert.strictEqual(routing.routable, true)

    const format = voiceFileTypeToFormat(reply.voice_file_type)
    assert.strictEqual(format, "ogg")

    const prefix = buildReplyPrefix(true)
    assert.strictEqual(prefix, "[User via Telegram Voice]")

    // After Whisper transcription, the text would be injected:
    const transcribedText = "please also handle edge cases"
    const injectedText = `${prefix} ${transcribedText}`
    assert.ok(injectedText.startsWith("[User via Telegram Voice]"))
  })

  it("full flow: video note reply → mp4 format", () => {
    const reply = makeReply({
      reply_text: null,
      is_voice: true,
      audio_base64: "base64data",
      voice_file_type: "video_note",
    })
    assert.strictEqual(voiceFileTypeToFormat(reply.voice_file_type), "mp4")
  })
})
