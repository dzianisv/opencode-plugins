# CC Stop Classification Datasets

This directory holds datasets used by the Claude Code reflection plugin (`claude/`) and the eval suite (`evals/stuck-detection.yaml`).

## Files

| File | Source | Tracked? | Description |
|------|--------|----------|-------------|
| `cc-stop-candidates-raw.jsonl` | `evals/scripts/mine-cc-stops.mjs` | **gitignored** | Every Stop boundary mined from `~/.claude/projects/**/*.jsonl`. Contains real user session content. |
| `cc-stop-candidates-filtered.jsonl` | `evals/scripts/filter-cc-stops.mjs` | **gitignored** | Heuristic-filtered subset of the raw set. Tagged with `hint:summary_drift / hint:punt / hint:stuck / hint:question`. |
| `cc-stop-classified.jsonl` | `evals/scripts/classify-cc-stops.mjs` | **gitignored** | LLM-classified (Claude Haiku 4.5 via Anthropic OAuth) into 6 categories. |
| `cc-stop-labeled-gold-redacted.jsonl` | `evals/scripts/audit-cc-classifications.mjs` + supervisor audit | **tracked** | Stratified sample (~30 records), PII/secrets redacted, supervisor-audited `gold_label` per record. Used as few-shot source for the eval prompt and as the gold set for `evals/stuck-detection.yaml`. |

## Categories (v1)

| Category | Inject? | Description |
|----------|---------|-------------|
| `complete` | no | Task done. |
| `working` | no | (rare at Stop) agent narrated mid-action. |
| `waiting_for_user_legitimate` | no | Agent legitimately needs user input. |
| `tool_available_punt` | **yes** | Agent asked user when tools could resolve. |
| `summary_drift_stop` | **yes** | Agent wrote a plan with a "next step", stopped before doing it. |
| `genuinely_stuck` | **yes** | Agent halted mid-thought, no question, no plan. |

## Baseline distribution (n=907)

From the 2026-05-25 classification run over the user's 14 active CC project transcripts:

```
working                       374   (40%)
complete                      261   (29%)
waiting_for_user_legitimate   210   (23%)
summary_drift_stop             35   (4%)
genuinely_stuck                27   (3%)
tool_available_punt             0   (0%)
```

## Known issues

1. **`working` over-assignment (374 = 40%)** — at Stop time the agent is by definition not working; the classifier likely confuses just-finished-action summaries with "working". Tracked: follow-up issue.
2. **`tool_available_punt` under-assignment (0)** — the heuristic filter found 26 candidates, but the classifier reassigned all of them. Either (a) the pattern is genuinely rare in this user's sessions, or (b) the prompt doesn't surface it. Tracked: follow-up issue.

## Redaction rules applied to the committed gold file

- emails → `<REDACTED:email>`
- bearer tokens, `sk-ant-*`, `ghp_*`, `gho_*`, long secret-shaped strings → `<REDACTED:token>` / `<REDACTED:secret>`
- absolute `/home/<user>/...` paths → `<REDACTED:home>/...`
- `github.com/<owner>/<repo>` refs → `github.com/<REDACTED>/<REDACTED>`
- `project_slug`, `session_id` → `<REDACTED:project>` / `<REDACTED:sid>`

UUIDs and short hex strings (≤ 60 chars matching `^[0-9a-f]{32,64}$`) are preserved as they don't leak useful info.

## Reproducing

```bash
# 1. Mine
node evals/scripts/mine-cc-stops.mjs

# 2. Filter
node evals/scripts/filter-cc-stops.mjs

# 3. Classify (requires ~/.claude/.credentials.json with OAuth token)
node evals/scripts/classify-cc-stops.mjs

# 4. Build redacted audit sample
node evals/scripts/audit-cc-classifications.mjs --per-cat 8
```
