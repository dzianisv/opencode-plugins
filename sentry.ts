/**
 * Sentry Plugin for OpenCode
 *
 * Initializes @sentry/node error tracking for all OpenCode plugins.
 * Since all plugins share the same Node.js process, calling Sentry.init()
 * once here enables captureException() in every other plugin.
 *
 * DSN is hardcoded for the distributex/opencode-plugins Sentry project.
 * Override with SENTRY_DSN environment variable if needed.
 */

import type { Plugin } from "@opencode-ai/plugin"

const SENTRY_DSN =
  "https://97c4a68cf4707f89076a11506b3b4df9@o335919.ingest.us.sentry.io/4510885656657920"

async function initSentry(): Promise<void> {
  try {
    const Sentry = await import("@sentry/node")
    if (Sentry.isInitialized()) return
    Sentry.init({
      dsn: process.env.SENTRY_DSN || SENTRY_DSN,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      environment: process.env.NODE_ENV || "production",
      integrations(defaults) {
        return defaults.map((integration) => {
          // Suppress stderr logging of unhandled rejections.
          // Default mode 'warn' calls console.warn/console.error which
          // corrupts the OpenCode TUI. Mode 'none' still captures to Sentry
          // but skips all console output.
          if (integration.name === "OnUnhandledRejection") {
            return Sentry.onUnhandledRejectionIntegration({ mode: "none" })
          }
          // Suppress stderr logging of uncaught exceptions for the same reason.
          if (integration.name === "OnUncaughtException") {
            return Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })
          }
          return integration
        })
      },
    })
  } catch {
    // @sentry/node not installed — silently skip
  }
}

export const SentryPlugin: Plugin = async () => {
  await initSentry()
  return {}
}

export default SentryPlugin
