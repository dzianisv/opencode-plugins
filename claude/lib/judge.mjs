/**
 * judge.mjs — in-hook LLM classifier for Claude Code Stop hooks.
 *
 * Exported surface:
 *   classifyStop(stopContext, opts?) → Promise<Classification>
 *
 * stopContext shape (built by buildStopContext in reflect.mjs):
 *   { session_id, attempt, user_messages, final_assistant_text,
 *     tools_available_inferred, raw_tail }
 *
 * Classification shape:
 *   { category, reason, confidence, raw_text?, usage? }
 *
 * Auth: reads OAuth token from ~/.claude/.credentials.json — no API key needed.
 * Net:  POST https://api.anthropic.com/v1/messages via global fetch (Node 18+).
 * Deps: none (stdlib only).
 */

import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const DEFAULT_MODEL = process.env.REFLECTION_CC_MODEL ?? 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 250;

const CATEGORIES = [
  'complete',
  'waiting_for_user_legitimate',
  'tool_available_punt',
  'summary_drift_stop',
  'genuinely_stuck',
  'working',
];

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

/**
 * Strips credentials from response bodies / error text before it lands in
 * Error.message or debug logs. Truncates to 200 chars.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeError(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  let s = text;
  s = s.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <REDACTED>');
  s = s.replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"<REDACTED>"');
  s = s.replace(/"x-api-key"\s*:\s*"[^"]*"/gi, '"x-api-key":"<REDACTED>"');
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Reads the Claude Code OAuth credentials JSON from its platform store.
 * On macOS, Claude Code keeps credentials in the login keychain (generic
 * password "Claude Code-credentials"), NOT in a file — so the file read on
 * darwin almost always fails and the keychain is the real source. On
 * Linux/Windows the credentials live at ~/.claude/.credentials.json.
 *
 * Returns the parsed object ({ claudeAiOauth: { accessToken, ... } }) or null
 * if no source is available / parseable.
 *
 * @returns {object | null}
 */
function readOauthCredentials() {
  // 1. File (Linux/Windows, and macOS installs that opted out of keychain).
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    return JSON.parse(readFileSync(credPath, 'utf8'));
  } catch {
    /* fall through to keychain on macOS */
  }

  // 2. macOS keychain.
  if (platform() === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return JSON.parse(out.trim());
    } catch {
      /* no keychain item, or not parseable */
    }
  }

  return null;
}

/**
 * Loads auth credentials for the Anthropic API, trying sources in order:
 *   1. ANTHROPIC_API_KEY env var (x-api-key header, no beta header needed)
 *   2. OAuth token from ~/.claude/.credentials.json (Linux/Windows) or the
 *      macOS login keychain ("Claude Code-credentials") — Bearer +
 *      oauth-2025-04-20 beta.
 *
 * Returns { type: 'apikey' | 'oauth', value: string }.
 * Throws a sentinel error (prefixed "judge:") if neither is available.
 *
 * @returns {{ type: 'apikey' | 'oauth', value: string }}
 */
function loadAuth() {
  // 1. Explicit API key env var
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim()) {
    return { type: 'apikey', value: apiKey.trim() };
  }

  // 2. OAuth token from credentials file or macOS keychain
  const obj = readOauthCredentials();
  if (!obj) {
    throw new Error(
      'judge: no ANTHROPIC_API_KEY set and no Claude Code OAuth credentials found ' +
      '(checked ~/.claude/.credentials.json and the macOS keychain)',
    );
  }

  const token = obj?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error('judge: OAuth credentials present but missing claudeAiOauth.accessToken');
  }
  return { type: 'oauth', value: token };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Truncates a string to n characters, appending a truncation note if cut.
 * Mirrors the helper in classify-cc-stops.mjs verbatim.
 *
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

/**
 * Builds the classifier prompt from a stopContext object.
 * Prompt content is identical to classify-cc-stops.mjs's buildPrompt().
 *
 * @param {object} ctx - stopContext from buildStopContext()
 * @returns {string}
 */
function buildPrompt(ctx) {
  const userMsgs = (ctx.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join('\n\n');
  const finalText = truncate(ctx.final_assistant_text ?? '', 2400);
  const tools = (ctx.tools_available_inferred ?? []).join(', ');

  return `You classify how a Claude Code assistant ended a turn. Pick ONE category.

CATEGORIES:
- complete: task is done; assistant delivered the answer or finished the requested work WITH evidence.
- waiting_for_user_legitimate: assistant asks a question that ONLY the user can answer (OAuth/2FA/captcha/credential retrieval, or a genuine preference the user must supply).
- tool_available_punt: assistant punts to the user about something the available tools could resolve. The assistant has tools like Bash, WebFetch, browser MCP, etc., yet asks the user instead of trying.
- summary_drift_stop: assistant wrote a summary/plan with a "next step" and STOPPED before doing it. e.g., "I've created the file. Next step: run the tests." (without running them.)
- genuinely_stuck: assistant stopped mid-thought or without clear conclusion; no question, no summary, just halted. Often a short response.
- working: rarely a stop; only assign if the final turn is clearly mid-action (e.g., "Running tests now...") with no closure.

TOOLS THE ASSISTANT HAD: ${tools || '(none recorded)'}

USER MESSAGES (in order):
${userMsgs || '(none)'}

FINAL ASSISTANT TEXT:
${finalText}

PREMATURE-STOP ANTIPATTERNS (mined from 227 real agent stops where the user replied; 78% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). Use these to sharpen category assignments:

- PERMISSION-SEEKING (most common, ~40%): the response ends by asking to do work it can already do — "Want me to…?", "Would you like me to…?", "Should I…?", "Shall I proceed?", or "Try running it now"/"Please run X and confirm" (deferring a check the agent could run itself). DECISIVE TEST: if the final turn is a yes/no or "want me to X?" question AND X is something the agent can do with its own tools AND X carries no irreversible risk → classify as tool_available_punt. Asking is only legitimate before a destructive/irreversible action (delete prod data, force-push, send an irreversible external message) → classify as waiting_for_user_legitimate.

- STOPPED-WITH-TODOS (~30%): the response lists "Remaining Tasks"/"Next steps"/"Still TODO"/"What I did NOT do" or names a verify/run/check/create-PR step as "next" — then stops without doing it. Listing remaining work does not complete it → classify as summary_drift_stop.

- FALSE-COMPLETE: claims "done"/"complete"/"ready"/"all tasks complete" but the CORE requested action never happened, a required check was skipped, or there is no evidence. An empty/no-text response on an action task is NEVER complete. For an "add a <feature>" task, writing files is not enough — code must be wired in AND verified (test/build/run); "ready to use" with no integration is incomplete → classify as summary_drift_stop (not complete).

- LEGITIMATE STOP (do NOT flag as premature): genuine human-only block (OAuth consent, 2FA code, credential/API-key retrieval, captcha) → waiting_for_user_legitimate. Genuine completion WITH evidence (commands+output, tests passing, PR/CI verified) → complete; do not invent missing work.

Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"category": "<one of: complete | waiting_for_user_legitimate | tool_available_punt | summary_drift_stop | genuinely_stuck | working>", "reason": "<one short sentence citing the specific antipattern or evidence>", "confidence": <0.0-1.0>}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Strips code fences, finds the first {...} block, and JSON.parses it.
 * Validates that category is one of the 6 known values.
 *
 * @param {string} text - raw text from the model
 * @param {object} [usage] - token usage from the API response
 * @returns {{ category: string, reason: string, confidence: number, raw_text: string, usage?: object }}
 */
function parseResponse(text, usage) {
  let s = text.trim();

  // Strip code fences if the model added them despite instructions
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  const match = s.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      category: 'PARSE_ERROR',
      reason: `no json found: ${s.slice(0, 100)}`,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch (err) {
    return {
      category: 'PARSE_ERROR',
      reason: err.message,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  if (!CATEGORIES.includes(obj.category)) {
    return {
      category: 'PARSE_ERROR',
      reason: `unknown category: ${obj.category}`,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  return {
    category: obj.category,
    reason: obj.reason ?? '',
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
    raw_text: text,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a Claude Code Stop event using a judge LLM call.
 *
 * @param {object} stopContext - built by buildStopContext() in reflect.mjs:
 *   { session_id, attempt, user_messages, final_assistant_text,
 *     tools_available_inferred, raw_tail }
 * @param {object} [opts]
 * @param {string}      [opts.model]     - override model (default: REFLECTION_CC_MODEL or claude-haiku-4-5)
 * @param {number}      [opts.timeoutMs] - override timeout in ms (default: 15000)
 * @param {AbortSignal} [opts.signal]    - external cancellation signal
 * @returns {Promise<{ category: string, reason: string, confidence: number, raw_text?: string, usage?: object }>}
 */
export async function classifyStop(stopContext, opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Test escape hatch: REFLECTION_CC_FAKE_JUDGE=<category>:<confidence> (e.g.
  // "summary_drift_stop:0.9") returns a hardcoded verdict without an API call.
  // Only active when the env var is set — never in production.
  const fakeJudge = process.env.REFLECTION_CC_FAKE_JUDGE;
  if (fakeJudge) {
    const [cat, conf] = fakeJudge.split(':');
    const category = CATEGORIES.includes(cat) ? cat : 'complete';
    return {
      category,
      reason: `[fake judge] ${fakeJudge}`,
      confidence: parseFloat(conf ?? '0.9') || 0.9,
    };
  }

  // Load auth — throws "judge: ..." on failure (caller treats as no-inject)
  const auth = loadAuth();

  const prompt = buildPrompt(stopContext);

  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    system: 'You are a precise classifier. Output JSON only.',
    messages: [{ role: 'user', content: prompt }],
  });

  // Build request headers depending on auth type.
  // - API key: x-api-key header, no beta header needed
  // - OAuth:   Bearer token + anthropic-beta oauth header
  const headers = {
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (auth.type === 'apikey') {
    headers['x-api-key'] = auth.value;
  } else {
    headers['authorization'] = `Bearer ${auth.value}`;
    headers['anthropic-beta'] = ANTHROPIC_BETA;
  }

  // Compose abort signal: hard timeout + optional caller signal
  const timeoutController = new AbortController();
  const timerId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Merge caller signal if provided
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body,
      signal: timeoutController.signal,
    });
  } catch (err) {
    clearTimeout(timerId);
    if (timeoutController.signal.aborted) {
      return {
        category: 'TIMEOUT',
        reason: `judge call exceeded ${timeoutMs}ms`,
        confidence: 0,
      };
    }
    throw new Error(`judge: fetch failed: ${sanitizeError(err.message)}`);
  } finally {
    clearTimeout(timerId);
  }

  if (!res.ok) {
    let body;
    try { body = await res.text(); } catch { body = ''; }
    throw new Error(`judge: api ${res.status}: ${sanitizeError(body)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`judge: failed to parse api response: ${sanitizeError(err.message)}`);
  }

  const rawText = json.content?.[0]?.text ?? '';
  const usage = json.usage
    ? { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens }
    : undefined;

  return parseResponse(rawText, usage);
}
