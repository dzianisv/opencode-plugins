/**
 * feedback.mjs — per-category feedback templates for the reflection plugin
 *
 * Exports:
 *   buildFeedback(category, ctx, attempt) → { shouldInject, reason, additionalContext }
 *   INJECT_CATEGORIES — Set<string> of categories where shouldInject may be true
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Categories that are eligible for injection (before attempt cap). */
export const INJECT_CATEGORIES = new Set([
  'summary_drift_stop',
  'tool_available_punt',
  'genuinely_stuck',
]);

const MAX_INJECT_ATTEMPT = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan `text` for a sentence that follows a "next step" signal phrase.
 * Returns the extracted sentence (trimmed, capped at 200 chars) or null.
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractNextStep(text) {
  if (!text) return null;

  // Patterns that signal "the agent named its next step"
  const patterns = [
    /next\s+step[s]?\s*[:–—]\s*([^.!?\n]+[.!?]?)/i,
    /next[,]?\s+i[''](?:ll|m going to)\s+([^.!?\n]+[.!?]?)/i,
    /now\s+i[''](?:ll|m going to)\s+([^.!?\n]+[.!?]?)/i,
    /i(?:'ll|'m going to| will| am going to)\s+now\s+([^.!?\n]+[.!?]?)/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      return m[1].trim().slice(0, 200);
    }
  }
  return null;
}

/**
 * Turn a tools array into a readable comma-separated string.
 *
 * @param {string[]} tools
 * @returns {string}
 */
function summarizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '<none recorded>';
  return tools.join(', ');
}

// ---------------------------------------------------------------------------
// Per-category template builders
// ---------------------------------------------------------------------------

/**
 * @param {string} nextStep - extracted next-step sentence or null
 * @param {number} attempt  - 1-based
 * @returns {{ reason: string, additionalContext: string }}
 */
function templateSummaryDrift(nextStep, attempt) {
  const stepClause = nextStep
    ? `The next step you named was: "${nextStep}".`
    : 'Your last message described a next step but did not execute it.';

  const base = `You wrote a plan and named a next step. Execute it now. ${stepClause} Do not write another summary or plan — make tool calls, write code, run commands.`;

  if (attempt === 1) {
    return {
      reason: 'summary_drift: plan written but not executed',
      additionalContext: base,
    };
  }
  if (attempt === 2) {
    return {
      reason: 'summary_drift: second inject — still not executing',
      additionalContext: `Second time triggering this. ${base} Stop narrating. Start doing.`,
    };
  }
  // attempt === 3
  return {
    reason: 'summary_drift: final inject before session close',
    additionalContext: `Third inject. ${base} If this approach is not working, try a different one. No more plans — next response must be a tool call or code. Session closes after this.`,
  };
}

/**
 * @param {string[]} tools  - inferred available tools
 * @param {number} attempt  - 1-based
 * @returns {{ reason: string, additionalContext: string }}
 */
function templateToolAvailablePunt(tools, attempt) {
  const toolList = summarizeTools(tools);

  const base = `You have these tools: ${toolList}. Use them yourself instead of asking the user. If you can answer with a tool, answer. Do not ask the user before trying.`;

  if (attempt === 1) {
    return {
      reason: 'tool_available_punt: agent deferred to user instead of using tools',
      additionalContext: base,
    };
  }
  if (attempt === 2) {
    return {
      reason: 'tool_available_punt: second inject — still deferring',
      additionalContext: `We did this once. You still have those tools: ${toolList}. Use them now. Do not ask — act.`,
    };
  }
  // attempt === 3
  return {
    reason: 'tool_available_punt: final inject before session close',
    additionalContext: `Third inject. Tools available: ${toolList}. If this approach keeps failing, try a different tool or strategy. Otherwise the session will close. Make a tool call in your next response.`,
  };
}

/**
 * @param {number} attempt - 1-based
 * @returns {{ reason: string, additionalContext: string }}
 */
function templateGenuinelyStuck(attempt) {
  const base =
    'You stopped mid-thought. Either: (a) state explicitly what is blocking and what you have tried, OR (b) take the next concrete action — make a tool call, write code, run a command. No more silence.';

  if (attempt === 1) {
    return {
      reason: 'genuinely_stuck: agent stopped without explicit blocker or action',
      additionalContext: base,
    };
  }
  if (attempt === 2) {
    return {
      reason: 'genuinely_stuck: second inject — still no action or stated blocker',
      additionalContext: `Second time. ${base} If you are blocked, say exactly what is blocking you and what you already tried. If you are not blocked, make a tool call.`,
    };
  }
  // attempt === 3
  return {
    reason: 'genuinely_stuck: final inject before session close',
    additionalContext: `Third inject. ${base} If this approach is not working, try a completely different strategy. Next response must be a tool call, code, or an explicit blocker statement. Session closes after this.`,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a feedback object for a classified Stop event.
 *
 * @param {string} category - one of the 9 possible classifier labels
 * @param {{ user_messages: string[], final_assistant_text: string, tools_available_inferred: string[], session_id: string }} ctx
 * @param {number} attempt - 1-based attempt counter for this session
 * @returns {{ shouldInject: boolean, reason: string, additionalContext: string | null }}
 */
export function buildFeedback(category, ctx, attempt) {
  // Defense in depth: never inject beyond MAX_INJECT_ATTEMPT even if caller forgot.
  if (attempt >= MAX_INJECT_ATTEMPT + 1) {
    return { shouldInject: false, reason: 'attempt_cap', additionalContext: null };
  }

  // Categories that never inject.
  switch (category) {
    case 'complete':
      return { shouldInject: false, reason: 'task_complete', additionalContext: null };

    case 'waiting_for_user_legitimate':
      return { shouldInject: false, reason: 'legitimate_user_wait', additionalContext: null };

    case 'working':
      return { shouldInject: false, reason: 'still_working', additionalContext: null };

    case 'TIMEOUT':
      return { shouldInject: false, reason: 'timeout_failsafe', additionalContext: null };

    case 'PARSE_ERROR':
      return { shouldInject: false, reason: 'parse_error_failsafe', additionalContext: null };

    case 'API_ERROR':
      return { shouldInject: false, reason: 'api_error_failsafe', additionalContext: null };
  }

  // Categories that inject.
  let tpl;
  switch (category) {
    case 'summary_drift_stop': {
      const nextStep = extractNextStep(ctx?.final_assistant_text ?? '');
      tpl = templateSummaryDrift(nextStep, attempt);
      break;
    }

    case 'tool_available_punt': {
      const tools = ctx?.tools_available_inferred ?? [];
      tpl = templateToolAvailablePunt(tools, attempt);
      break;
    }

    case 'genuinely_stuck': {
      tpl = templateGenuinelyStuck(attempt);
      break;
    }

    default:
      // Unknown category — fail safe.
      return { shouldInject: false, reason: `unknown_category:${category}`, additionalContext: null };
  }

  return {
    shouldInject: true,
    reason: tpl.reason,
    additionalContext: tpl.additionalContext,
  };
}
