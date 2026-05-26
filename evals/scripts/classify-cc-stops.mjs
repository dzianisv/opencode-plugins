#!/usr/bin/env node
// classify-cc-stops.mjs — call Claude Haiku 4.5 via the Anthropic API to
// classify each candidate Stop into one of 6 categories.
//
// Auth: reads OAuth access token from ~/.claude/.credentials.json (the user's
// existing Claude Code Max subscription). No new API key needed.
//
// Output: one JSON object per line, original record + .classification block:
//   { ...original fields, classification: { category, reason, confidence } }
//
// Resume: if --out file already exists, skips records whose
// (session_id + stop_index) already appear classified — safe to re-run.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { argv, exit, stderr } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = parseArgs(argv.slice(2));
const IN_PATH = args.in ?? "evals/datasets/cc-stop-candidates-filtered.jsonl";
const OUT_PATH = args.out ?? "evals/datasets/cc-stop-classified.jsonl";
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const CONCURRENCY = parseInt(args.concurrency ?? "4", 10);
const MODEL = args.model ?? "claude-haiku-4-5";

const CATEGORIES = [
  "complete",
  "waiting_for_user_legitimate",
  "tool_available_punt",
  "summary_drift_stop",
  "genuinely_stuck",
  "working",
];

function loadOAuthToken() {
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = readFileSync(path, "utf8");
  const obj = JSON.parse(raw);
  return obj.claudeAiOauth?.accessToken;
}

const TOKEN = loadOAuthToken();
if (!TOKEN) {
  stderr.write("ERROR: no OAuth token in ~/.claude/.credentials.json\n");
  exit(1);
}

function buildPrompt(record) {
  const userMsgs = (record.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join("\n\n");
  const finalText = truncate(record.final_assistant_text ?? "", 2400);
  const tools = (record.tools_available_inferred ?? []).join(", ");

  return `You classify how a Claude Code assistant ended a turn. Pick ONE category.

CATEGORIES:
- complete: task is done; assistant delivered the answer or finished the requested work.
- waiting_for_user_legitimate: assistant asks a question that ONLY the user can answer (preference, missing info no tool can fetch).
- tool_available_punt: assistant punts to the user about something the available tools could resolve. The assistant has access to tools like Bash, WebFetch, browser MCP, etc., yet asks the user instead of trying.
- summary_drift_stop: assistant wrote a summary or plan with a "next step" and STOPPED before doing the next step. e.g., "I've created the file. Next step: run the tests." (without running them.)
- genuinely_stuck: assistant stopped mid-thought or without clear conclusion; no question, no summary, just halted. Often short.
- working: rarely a stop; only assign if the final turn is clearly mid-action (e.g., "Running tests now...") with no closure.

TOOLS THE ASSISTANT HAD: ${tools || "(none recorded)"}

USER MESSAGES (in order):
${userMsgs || "(none)"}

FINAL ASSISTANT TEXT:
${finalText}

Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"category": "<one of: complete | waiting_for_user_legitimate | tool_available_punt | summary_drift_stop | genuinely_stuck | working>", "reason": "<one short sentence why>", "confidence": <0.0-1.0>}`;
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

async function callApi(prompt, attempt = 1) {
  const body = {
    model: MODEL,
    max_tokens: 250,
    system: "You are a precise classifier. Output JSON only.",
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`api error ${res.status} after ${attempt} attempts`);
    const wait = Math.min(60000, 2000 * Math.pow(2, attempt));
    stderr.write(`  api ${res.status} — retry in ${wait}ms (attempt ${attempt})\n`);
    await new Promise(r => setTimeout(r, wait));
    return callApi(prompt, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json.content?.[0]?.text ?? "";
  return parseClassification(text, json.usage);
}

function parseClassification(text, usage) {
  // Strip code fences if model added them despite instructions
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // Find the JSON object
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) {
    return { category: "PARSE_ERROR", reason: `no json: ${s.slice(0, 100)}`, confidence: 0, _usage: usage };
  }
  try {
    const obj = JSON.parse(match[0]);
    if (!CATEGORIES.includes(obj.category)) {
      obj.category = "PARSE_ERROR_BAD_CAT_" + obj.category;
      obj.confidence = 0;
    }
    obj._usage = usage;
    return obj;
  } catch (e) {
    return { category: "PARSE_ERROR", reason: e.message, confidence: 0, _usage: usage };
  }
}

function loadAlreadyClassified() {
  const seen = new Set();
  if (!existsSync(OUT_PATH)) return seen;
  const raw = readFileSync(OUT_PATH, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      seen.add(`${o.session_id}::${o.stop_index}`);
    } catch {}
  }
  return seen;
}

async function main() {
  const lines = readFileSync(IN_PATH, "utf8").split("\n").filter(Boolean);
  const seen = loadAlreadyClassified();
  stderr.write(`Loaded ${lines.length} candidates, already classified: ${seen.size}\n`);

  const todo = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const key = `${rec.session_id}::${rec.stop_index}`;
    if (seen.has(key)) continue;
    todo.push(rec);
    if (todo.length >= LIMIT) break;
  }
  stderr.write(`To classify: ${todo.length} (concurrency=${CONCURRENCY}, model=${MODEL})\n\n`);

  let done = 0;
  let totalUsage = { in: 0, out: 0 };
  const startedAt = Date.now();

  async function worker(idx) {
    while (idx < todo.length) {
      const rec = todo[idx];
      idx += CONCURRENCY;
      try {
        const prompt = buildPrompt(rec);
        const cls = await callApi(prompt);
        if (cls._usage) {
          totalUsage.in += cls._usage.input_tokens ?? 0;
          totalUsage.out += cls._usage.output_tokens ?? 0;
        }
        delete cls._usage;
        const out = { ...rec, classification: cls };
        appendFileSync(OUT_PATH, JSON.stringify(out) + "\n");
        done++;
        if (done % 20 === 0 || done === todo.length) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = done / elapsed;
          stderr.write(`[${done}/${todo.length}] ${rate.toFixed(1)}/s  tokens in=${totalUsage.in} out=${totalUsage.out}\n`);
        }
      } catch (e) {
        stderr.write(`  fail ${rec.session_id}::${rec.stop_index}: ${e.message}\n`);
        const out = { ...rec, classification: { category: "API_ERROR", reason: e.message, confidence: 0 } };
        appendFileSync(OUT_PATH, JSON.stringify(out) + "\n");
        done++;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, todo.length); i++) {
    workers.push(worker(i));
  }
  await Promise.all(workers);

  stderr.write(`\n=== CLASSIFY DONE ===\n`);
  stderr.write(`Classified : ${done}\n`);
  stderr.write(`Tokens     : in=${totalUsage.in} out=${totalUsage.out}\n`);
  stderr.write(`Output     : ${OUT_PATH}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

main().catch(e => {
  stderr.write(`FATAL: ${e.stack}\n`);
  exit(1);
});
