#!/usr/bin/env node
/**
 * mine-cc-stops.mjs
 *
 * Scans Claude Code session transcripts under ~/.claude/projects/**\/*.jsonl
 * and extracts "Stop boundaries" — points where the assistant ended a turn
 * (last assistant message before a user reply or before session end).
 *
 * Usage:
 *   node evals/scripts/mine-cc-stops.mjs
 *   node evals/scripts/mine-cc-stops.mjs --limit 20
 *   node evals/scripts/mine-cc-stops.mjs --project -home-azureuser-workspace-opencode-plugins
 *   node evals/scripts/mine-cc-stops.mjs --out /tmp/candidates.jsonl
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let limitSessions = Infinity;
let filterProject = null;
let outPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    limitSessions = parseInt(args[++i], 10);
    if (isNaN(limitSessions) || limitSessions < 1) {
      console.error('--limit must be a positive integer');
      process.exit(1);
    }
  } else if (args[i] === '--project' && args[i + 1]) {
    filterProject = args[++i];
  } else if (args[i] === '--out' && args[i + 1]) {
    outPath = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: node mine-cc-stops.mjs [--limit N] [--project SLUG] [--out PATH]`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CC_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_OUT = path.join(REPO_ROOT, 'evals', 'datasets', 'cc-stop-candidates-raw.jsonl');
const outputPath = outPath || DEFAULT_OUT;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUNCATE_AT = 4000;

function truncate(text) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= TRUNCATE_AT) return text;
  return text.slice(0, TRUNCATE_AT) + '…[truncated]';
}

/**
 * Extract plain text from a message content field.
 * content can be: string | Array<{type, text?, ...}>
 * We only collect text parts; tool_use / tool_result / thinking are skipped.
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/**
 * Returns true if this user entry is a tool-result carrier (not a real human turn).
 * Tool-result user entries have content parts of type=tool_result, or top-level toolUseResult.
 */
function isToolResultEntry(entry) {
  if (entry.toolUseResult !== undefined) return true;
  const content = entry.message?.content;
  if (!content) return false;
  if (Array.isArray(content)) {
    return content.some(p => p && p.type === 'tool_result');
  }
  return false;
}

/**
 * Returns true if this user entry is a meta/injected skill entry (isMeta flag).
 * These are system-injected context payloads, not real user prompts.
 */
function isMetaEntry(entry) {
  return entry.isMeta === true;
}

/**
 * Extract tool names from an assistant message's content array (type=tool_use parts).
 */
function extractToolNames(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const part of content) {
    if (part && part.type === 'tool_use' && typeof part.name === 'string') {
      names.push(part.name);
    }
  }
  return names;
}

/**
 * Check if this assistant entry (or group of entries) is a "real stop":
 * stop_reason === 'end_turn' or stop_reason is null/missing (interrupted/session-end).
 * An assistant entry with stop_reason === 'tool_use' is NOT a stop.
 */
function isStopEntry(entry) {
  const stopReason = entry.message?.stop_reason;
  return stopReason === 'end_turn' || stopReason == null || stopReason === '';
}

/**
 * Determine if a project slug should be skipped.
 * Skip *-home-azureuser--* UNLESS the path contains 'workspace'.
 */
function shouldSkipProject(slug) {
  // Matches the pattern -home-azureuser--something (double dash = no workspace segment)
  if (slug.includes('-home-azureuser--') && !slug.includes('workspace')) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core: parse a single .jsonl file into a list of events, then extract stops
// ---------------------------------------------------------------------------

/**
 * Read all lines from a .jsonl file, parse JSON, skip malformed lines.
 * Returns array of parsed objects.
 */
async function readJsonlFile(filePath) {
  const entries = [];
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (err) {
      // Skip malformed lines silently (debug log to stderr)
      // console.error(`[debug] malformed JSON in ${filePath}: ${err.message}`);
    }
  }
  return entries;
}

/**
 * Process entries from one JSONL file (one session).
 *
 * Algorithm:
 *   Walk entries in order. Maintain:
 *   - currentAssistantGroup: all assistant entries sharing the same requestId (logical turn)
 *   - userMessages: accumulated human (non-tool-result, non-meta) user message texts
 *   - toolNamesSeenSoFar: set of tool names called so far in session
 *   - priorToolUsesCount: count of tool_use calls so far
 *   - stops: output list
 *
 *   When we encounter a user entry that is NOT a tool-result and NOT meta:
 *     If there's a pending assistant group that is a stop → emit candidate
 *     Then push this user message text into userMessages
 *
 *   At end of file:
 *     If there's a pending assistant group that is a stop → emit candidate (session-end stop)
 *
 * Note: Claude Code JSONL can have assistant entries with the same requestId emitted
 * separately (thinking part, text part, tool_use part). We group by requestId.
 * An assistant group is a "stop" if its last entry has stop_reason != 'tool_use'.
 */
function processSession(entries, sessionId, projectSlug) {
  const stops = [];
  const toolNamesSeen = new Set();
  let priorToolUsesCount = 0;

  // Flatten into logical turns:
  // We walk sequentially. Track current assistant group.
  let pendingAssistantGroup = null; // { requestId, entries: [], isStop: bool, toolNames: string[] }
  const userMessages = []; // accumulated real user message texts (non-tool-result, non-meta)
  let sessionTotalTurns = 0; // count of real user turns

  function finalizeAssistantGroupIfStop(nextEntryIsUserOrEnd) {
    if (!pendingAssistantGroup) return;
    const group = pendingAssistantGroup;

    // Determine if this group is a stop:
    // Stop = the last entry in the group has stop_reason !== 'tool_use'
    // (end_turn, or null which happens when a turn ends before more tool calls)
    const lastEntry = group.entries[group.entries.length - 1];
    const stopReason = lastEntry?.message?.stop_reason;
    const isStop = stopReason !== 'tool_use';

    if (isStop && nextEntryIsUserOrEnd) {
      // Collect text from all text-typed parts in this group
      const textParts = [];
      for (const e of group.entries) {
        const t = extractText(e.message?.content);
        if (t) textParts.push(t);
      }
      const finalAssistantText = textParts.join('\n').trim();

      // The timestamp of the last entry in the group
      const timestamp = lastEntry?.timestamp || group.entries[0]?.timestamp || null;

      stops.push({
        project_slug: projectSlug,
        session_id: sessionId,
        stop_index: stops.length,
        timestamp: timestamp,
        user_messages: [...userMessages],
        final_assistant_text: truncate(finalAssistantText),
        tools_available_inferred: [...toolNamesSeen],
        prior_tool_uses_count: priorToolUsesCount,
        session_total_turns: sessionTotalTurns, // will be updated at end
      });
    }

    pendingAssistantGroup = null;
  }

  for (const entry of entries) {
    const entryType = entry.type;

    if (entryType === 'user') {
      if (isToolResultEntry(entry)) {
        // This is a tool result — do NOT finalize pending assistant group as a stop,
        // and do NOT add to userMessages. Just skip.
        continue;
      }

      if (isMetaEntry(entry)) {
        // Skill injection / meta context — skip for user message collection
        // but DO finalize assistant group since a real user turn is happening
        // Actually: meta entries accompany a real user turn. They share a promptId.
        // We'll handle finalization when we see the real user message.
        continue;
      }

      // Real human user message
      sessionTotalTurns++;
      // Finalize any pending assistant group (this user turn follows that assistant stop)
      finalizeAssistantGroupIfStop(true);

      const text = extractText(entry.message?.content);
      if (text) {
        userMessages.push(truncate(text));
      }

    } else if (entryType === 'assistant') {
      const requestId = entry.requestId;
      const msgContent = entry.message?.content;

      // Collect tool names from this entry
      const toolNamesHere = extractToolNames(msgContent);
      for (const name of toolNamesHere) {
        if (!toolNamesSeen.has(name)) {
          toolNamesSeen.add(name);
        }
        priorToolUsesCount++;
      }

      // Group by requestId
      if (pendingAssistantGroup && pendingAssistantGroup.requestId === requestId) {
        // Same logical turn — append
        pendingAssistantGroup.entries.push(entry);
      } else {
        // New assistant turn — if there's a pending one, it was followed immediately
        // by another assistant turn (no user in between). This shouldn't be a stop
        // (the assistant is continuing). Finalize it as non-stop by setting isStop=false.
        // Actually: if a new assistant requestId starts without a user turn in between,
        // the previous group is not followed by a user entry → we'll handle at the end.
        // For now, just replace (the previous group would have been consumed already or
        // will be emitted as session-end stop).
        if (pendingAssistantGroup) {
          // Previous group was NOT followed by a user turn.
          // This means it was followed by another assistant group (shouldn't normally happen)
          // or we're in the middle of sidechain activity. Skip it.
          finalizeAssistantGroupIfStop(false);
        }
        pendingAssistantGroup = {
          requestId,
          entries: [entry],
        };
      }
    }
    // Other types (last-prompt, permission-mode, bridge-session, hook_*, etc.) — ignore
  }

  // End of session: finalize any pending assistant group as session-end stop
  finalizeAssistantGroupIfStop(true);

  // Update session_total_turns in all stops
  for (const stop of stops) {
    stop.session_total_turns = sessionTotalTurns;
  }

  return stops;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Verify CC projects dir exists
  if (!fs.existsSync(CC_PROJECTS_DIR)) {
    console.error(`[error] CC projects dir not found: ${CC_PROJECTS_DIR}`);
    process.exit(1);
  }

  // Discover project slugs
  let projectSlugs;
  try {
    projectSlugs = fs.readdirSync(CC_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (err) {
    console.error(`[error] Cannot read CC projects dir: ${err.message}`);
    process.exit(1);
  }

  // Apply --project filter
  if (filterProject) {
    projectSlugs = projectSlugs.filter(s => s === filterProject);
    if (projectSlugs.length === 0) {
      console.error(`[error] No project matching slug: ${filterProject}`);
      process.exit(1);
    }
  }

  // Apply skip rule: skip -home-azureuser--* unless it has 'workspace'
  const filteredSlugs = projectSlugs.filter(slug => {
    if (shouldSkipProject(slug)) {
      console.error(`[skip] project ${slug} (config-only, no workspace)`);
      return false;
    }
    return true;
  });

  console.error(`[info] Found ${projectSlugs.length} projects, processing ${filteredSlugs.length} after filter`);

  // Ensure output dir exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Open output stream
  const outStream = fs.createWriteStream(outputPath, { encoding: 'utf8', flags: 'w' });

  // Stats
  let totalSessionsScanned = 0;
  let totalSessionsSkipped = 0;
  let totalCandidatesEmitted = 0;
  const candidatesPerProject = {};
  let sessionCount = 0; // total across all projects for --limit

  for (const slug of filteredSlugs) {
    if (sessionCount >= limitSessions) break;

    const projectDir = path.join(CC_PROJECTS_DIR, slug);

    // Find all .jsonl files in this project dir
    let jsonlFiles;
    try {
      jsonlFiles = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
        .map(f => path.join(projectDir, f.name));
    } catch (err) {
      console.error(`[warn] Cannot read project dir ${projectDir}: ${err.message}`);
      continue;
    }

    if (jsonlFiles.length === 0) {
      console.error(`[skip] project ${slug} — no .jsonl files`);
      continue;
    }

    candidatesPerProject[slug] = 0;

    for (const filePath of jsonlFiles) {
      if (sessionCount >= limitSessions) break;

      console.error(`[scan] ${slug}/${path.basename(filePath)}`);

      let entries;
      try {
        entries = await readJsonlFile(filePath);
      } catch (err) {
        console.error(`[warn] Cannot read file ${filePath}: ${err.message}`);
        totalSessionsSkipped++;
        continue;
      }

      // Determine session ID (from filename or from first entry with sessionId)
      const fileBasename = path.basename(filePath, '.jsonl');
      let sessionId = fileBasename;
      for (const e of entries) {
        if (e.sessionId) { sessionId = e.sessionId; break; }
      }

      // Skip sessions with < 3 user messages (too short)
      const realUserMsgs = entries.filter(e =>
        e.type === 'user' && !isToolResultEntry(e) && !isMetaEntry(e)
      );
      if (realUserMsgs.length < 3) {
        console.error(`[skip] session ${sessionId} — only ${realUserMsgs.length} user messages (< 3)`);
        totalSessionsSkipped++;
        totalSessionsScanned++;
        sessionCount++;
        continue;
      }

      // Skip sessions with no assistant turns
      const hasAssistant = entries.some(e => e.type === 'assistant');
      if (!hasAssistant) {
        console.error(`[skip] session ${sessionId} — no assistant turns`);
        totalSessionsSkipped++;
        totalSessionsScanned++;
        sessionCount++;
        continue;
      }

      // Process session
      let stops;
      try {
        stops = processSession(entries, sessionId, slug);
      } catch (err) {
        console.error(`[warn] Error processing session ${sessionId}: ${err.message}`);
        totalSessionsSkipped++;
        totalSessionsScanned++;
        sessionCount++;
        continue;
      }

      totalSessionsScanned++;
      sessionCount++;

      // Emit candidates
      let emittedFromSession = 0;
      for (const stop of stops) {
        outStream.write(JSON.stringify(stop) + '\n');
        emittedFromSession++;
        totalCandidatesEmitted++;
        candidatesPerProject[slug]++;
      }

      console.error(`[done] session ${sessionId} → ${emittedFromSession} stop(s)`);
    }
  }

  await new Promise((resolve, reject) => {
    outStream.end(err => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Summary to stderr
  console.error('\n=== SUMMARY ===');
  console.error(`Sessions scanned : ${totalSessionsScanned}`);
  console.error(`Sessions skipped : ${totalSessionsSkipped}`);
  console.error(`Candidates emitted: ${totalCandidatesEmitted}`);
  console.error(`Output written to : ${outputPath}`);
  console.error('\nCandidates per project:');
  for (const [slug, count] of Object.entries(candidatesPerProject).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${slug}: ${count}`);
  }
}

main().catch(err => {
  console.error(`[fatal] ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
