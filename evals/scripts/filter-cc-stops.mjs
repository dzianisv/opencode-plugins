#!/usr/bin/env node
// filter-cc-stops.mjs — keep only "interesting" Stop candidates likely to
// fall into one of the failure-mode categories. Reduces classification cost.
//
// Categories we want to surface:
//   - tool_available_punt: assistant asks user when tools could answer
//   - summary_drift_stop: assistant wrote "next step is X" then stopped
//   - genuinely_stuck: short final turn after long session, no question
//
// Categories we want to filter OUT (cheap rejects, no classifier call):
//   - working: not a Stop by definition; miner shouldn't emit these
//   - obvious "complete" with short answer to short prompt
//
// The classifier still gets ground-truth labeled examples from each category
// during eval, but for mining real failure patterns we focus on Stops that
// LOOK like they might be one.

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, stderr } from "node:process";

const args = parseArgs(argv.slice(2));
const IN_PATH = args.in ?? "evals/datasets/cc-stop-candidates-raw.jsonl";
const OUT_PATH = args.out ?? "evals/datasets/cc-stop-candidates-filtered.jsonl";

const NEXT_STEP_PATTERNS = [
  /\bnext step\b/i,
  /\bnext\s+i('?ll|\s+will)\b/i,
  /\bnow\s+i('?ll|\s+will)\b/i,
  /\bonce\s+(you|that's?)\b.*\bi('?ll|\s+will)\b/is,
  /\bthen\s+i('?ll|\s+will)\b/i,
  /\bafter\s+that\b.*\bi('?ll|\s+will)\b/is,
  /\bwhen\s+you('?re|\s+are)\s+ready\b/i,
  /\b(let me know|tell me|just say)\b.*\b(when|once|if)\b/is,
];

const PUNT_PATTERNS = [
  /\bwould you like (me )?to\b/i,
  /\bshould i\b.*\?/i,
  /\bdo you want (me )?to\b/i,
  /\bshall i\b.*\?/i,
  /\bcan you (tell|let|share|provide|confirm|clarify|give|show)\b.*\?/is,
  /\bplease (provide|share|let me know|tell|confirm)\b/i,
  /\bwhich\s+(one|option|approach|version)\s+do you/i,
  /\bwhat('?s| is)\s+your (preference|choice)\b/i,
];

const SUMMARY_PATTERNS = [
  /\b(i've?|i have)\s+(created|written|added|implemented|built|set up|configured|installed|finished)\b/i,
  /\bhere('?s| is)\s+(a |the |what )/i,
  /\bsummary\s*:/i,
  /\b(done|complete)\s*[.!]?\s*(now|next)\b/i,
  /\bthe (function|file|test|component|module)\s+(is|now)\b/i,
];

function looksLikeStuck(text, userMsgCount, sessionTotalTurns) {
  // short final turn after long session, no question, no summary
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 500) return false;
  if (sessionTotalTurns < 5) return false;
  if (/\?\s*$/.test(trimmed)) return false; // ends with question
  // very short response after substantive session = possibly stuck
  return trimmed.length < 300 && sessionTotalTurns >= 8;
}

function looksLikePunt(text, toolsAvailable) {
  if (!text) return false;
  const punted = PUNT_PATTERNS.some(p => p.test(text));
  if (!punted) return false;
  // tool_available_punt is more interesting when the assistant HAS tools.
  // Always-empty tool sets = could legitimately need user input.
  // Keep punts when ≥3 tools are available (likely punt despite capability).
  return toolsAvailable.length >= 3;
}

function looksLikeSummaryDrift(text) {
  if (!text) return false;
  const hasSummary = SUMMARY_PATTERNS.some(p => p.test(text));
  const hasNextStep = NEXT_STEP_PATTERNS.some(p => p.test(text));
  return hasSummary && hasNextStep;
}

function looksLikeEndsWithQuestion(text) {
  if (!text) return false;
  return /\?\s*$/.test(text.trim());
}

function classifyCandidate(record) {
  const text = record.final_assistant_text ?? "";
  const tools = record.tools_available_inferred ?? [];
  const turns = record.session_total_turns ?? 0;
  const userMsgs = (record.user_messages ?? []).length;

  const tags = [];
  if (looksLikePunt(text, tools)) tags.push("hint:punt");
  if (looksLikeSummaryDrift(text)) tags.push("hint:summary_drift");
  if (looksLikeStuck(text, userMsgs, turns)) tags.push("hint:stuck");
  if (looksLikeEndsWithQuestion(text)) tags.push("hint:question");

  return tags;
}

function main() {
  const raw = readFileSync(IN_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  const stats = {
    total: lines.length,
    kept: 0,
    by_tag: {},
  };

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const tags = classifyCandidate(rec);
    if (tags.length === 0) continue;

    rec.heuristic_tags = tags;
    out.push(JSON.stringify(rec));
    stats.kept++;
    for (const t of tags) {
      stats.by_tag[t] = (stats.by_tag[t] ?? 0) + 1;
    }
  }

  writeFileSync(OUT_PATH, out.join("\n") + "\n");

  stderr.write(`\n=== FILTER SUMMARY ===\n`);
  stderr.write(`Input candidates : ${stats.total}\n`);
  stderr.write(`Kept (any hint)  : ${stats.kept}\n`);
  stderr.write(`Output           : ${OUT_PATH}\n`);
  stderr.write(`\nBy tag:\n`);
  for (const [tag, n] of Object.entries(stats.by_tag).sort((a, b) => b[1] - a[1])) {
    stderr.write(`  ${tag.padEnd(22)} ${n}\n`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

main();
