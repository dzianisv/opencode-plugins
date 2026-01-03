/**
 * TTS (Text-to-Speech) Plugin for OpenCode
 *
 * Reads the final answer aloud when the agent finishes using the OS TTS.
 * Currently supports macOS using the built-in `say` command.
 * 
 * Toggle TTS on/off:
 *   /tts       - toggle
 *   /tts on    - enable
 *   /tts off   - disable
 * 
 * Or set TTS_DISABLED=1 environment variable to disable.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { exec } from "child_process"
import { promisify } from "util"
import { readFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

const execAsync = promisify(exec)

// Maximum characters to read (to avoid very long speeches)
const MAX_SPEECH_LENGTH = 1000

// Track sessions we've already spoken for
const spokenSessions = new Set<string>()

// Config file path for persistent TTS settings
const TTS_CONFIG_PATH = join(homedir(), ".config", "opencode", "tts.json")

/**
 * Check if TTS is enabled (re-reads config each time to pick up changes from /tts command)
 */
async function isEnabled(): Promise<boolean> {
  // Env var takes precedence
  if (process.env.TTS_DISABLED === "1") return false
  
  try {
    const content = await readFile(TTS_CONFIG_PATH, "utf-8")
    const config = JSON.parse(content)
    return config.enabled !== false
  } catch {
    // Default to enabled if file doesn't exist
    return true
  }
}

export const TTSPlugin: Plugin = async ({ client, directory }) => {
  /**
   * Extract the final assistant response from session messages
   */
  function extractFinalResponse(messages: any[]): string | null {
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            return part.text
          }
        }
      }
    }
    return null
  }

  /**
   * Clean text for TTS - remove markdown, code blocks, etc.
   */
  function cleanTextForSpeech(text: string): string {
    return text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "code block omitted")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove markdown formatting
      .replace(/[*_~#]+/g, "")
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, "")
      // Remove file paths
      .replace(/\/[\w./-]+/g, "")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  }

  /**
   * Speak text using macOS `say` command
   */
  async function speak(text: string): Promise<void> {
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) return

    // Truncate if too long
    const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
      ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
      : cleaned

    // Escape single quotes for shell
    const escaped = toSpeak.replace(/'/g, "'\\''")

    try {
      // Use macOS say command with default voice
      // -r 200 sets a reasonable speaking rate (words per minute)
      await execAsync(`say -r 200 '${escaped}'`)
    } catch (error) {
      // Silently fail - TTS is non-critical
      console.error("[TTS] Failed to speak:", error)
    }
  }

  /**
   * Check if the session has completed (last assistant message is done)
   */
  function isSessionComplete(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        return !!(msg.info?.time as any)?.completed
      }
    }
    return false
  }

  /**
   * Skip judge/reflection sessions
   */
  function isJudgeSession(messages: any[]): boolean {
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  return {
    event: async ({ event }) => {
      // Check if TTS is enabled (re-reads config file each time)
      if (!(await isEnabled())) return

      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        // Don't speak for same session twice
        if (spokenSessions.has(sessionId)) return

        try {
          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          if (!messages || messages.length < 2) return

          // Skip judge sessions
          if (isJudgeSession(messages)) return

          // Check if session is actually complete
          if (!isSessionComplete(messages)) return

          // Extract and speak the final response
          const finalResponse = extractFinalResponse(messages)
          if (finalResponse) {
            spokenSessions.add(sessionId)
            await speak(finalResponse)
          }
        } catch (error) {
          // Silently fail
        }
      }
    }
  }
}

export default TTSPlugin
