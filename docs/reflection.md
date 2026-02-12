# Reflection Plugin (reflection-3)

Evaluates agent task completion and enforces workflow requirements using a self-assessment prompt plus optional GenAI verification.

## Scope
- Trigger on `session.idle`.
- Skip judge sessions, plan mode sessions, and recently aborted sessions.
- Avoid repeated reflections for the same user message.
- Build a task context from recent messages, tool usage, and repo signals.
- Request a structured self-assessment from the agent.
- Parse JSON self-assessment and evaluate workflow gates.
- If self-assessment parsing fails, fall back to a judge session and parse a JSON verdict.
- Write verdict signals to `.reflection/verdict_<session>.json` for TTS/Telegram gating.
- Persist reflection analysis data to `.reflection/<session>_<timestamp>.json`.
- Provide feedback only when incomplete; show a toast when complete or when user action is required.

## Configuration
Reflection models are configured in `~/.config/opencode/reflection.yaml`.

Example:
```yaml
models:
  - github-copilot/claude-opus-4.6
  - github-copilot/gpt-5.2-codex
```

Notes:
- Each entry must be `providerID/modelID`.
- The plugin will try each model in order until one returns a valid verdict.
- If all models fail or time out, reflection returns a failure verdict.

Custom prompt override:
- Place `reflection.md` in the workspace root.

Debug logging:
- `REFLECTION_DEBUG=1`

## Workflow Gates (reflection-3)
reflection-3 enforces workflow gates using the self-assessment plus GenAI verification:

- Task must be complete and explicitly confirmed by the agent.
- Required local tests must run and pass, and the exact commands must be listed.
- Tests cannot be skipped for reasons like flakiness or “not important”.
- PR creation is required; direct pushes to `main`/`master` are rejected.
- PR link, PR creation evidence, and CI checks must be verified as passing (recommend `gh pr checks` or `gh pr view`).

If any of these gates are missing, reflection will mark the task incomplete and push the agent to continue.

## Self-Assessment Contract
The agent must return JSON with evidence and status, including:
- `tests.ran`, `tests.results`, `tests.ran_after_changes`, `tests.commands`
- `build.ran`, `build.results`
- `pr.created`, `pr.url`, `pr.ci_status`, `pr.checked`
- `remaining_work`, `next_steps`, `needs_user_action`
- `stuck`, `alternate_approach`

## Decision Outcomes
- Complete -> toast success, write verdict signal.
- Requires human action -> toast warning, no follow-up prompt.
- Incomplete -> push feedback into the session with next steps.

## System Design Diagram
```mermaid
flowchart TD
  Idle[session.idle] --> Guard{Skip?}
  Guard -->|judge or plan| Stop1[Skip]
  Guard -->|aborted| Stop2[Skip]
  Guard -->|new task| Context[Build task context]
  Context --> Prompt[Prompt self-assessment]
  Prompt --> Parse{Parse JSON?}
  Parse -->|yes| Eval[Evaluate workflow gates]
  Parse -->|no| Judge[Judge session + JSON verdict]
  Eval --> Verdict[Write verdict signal]
  Judge --> Verdict
  Verdict --> Done{complete?}
  Done -->|yes| ToastOk[Toast: complete]
  Done -->|human action| ToastAction[Toast: action needed]
  Done -->|no| Feedback[Prompt feedback to continue]
```

## Files and Artifacts
- `<workspace>/.reflection/verdict_<session>.json` (signal for TTS/Telegram)
- `<workspace>/.reflection/<session>_<timestamp>.json` (full analysis record)
- `~/.config/opencode/reflection.yaml` (judge model list)
- `reflection.md` in workspace (optional custom prompt)

## Operational Notes
- Judge sessions are created via `promptAsync` and polled until completion.
- The plugin avoids infinite loops by tracking last reflected user message id and active reflections.
- Abort handling uses `session.error` with a cooldown to skip reflection on canceled tasks.
