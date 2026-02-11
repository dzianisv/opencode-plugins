export const reflectionDoc = `# Reflection Plugin (reflection-3.ts)

## Scope
Evaluates agent task completion and enforces workflow requirements (tests/build/PR/CI) by prompting the agent to self-assess and optionally validating with a judge session.

## Requirements
- Trigger on session.idle.
- Skip judge sessions, plan mode sessions, and recently aborted sessions.
- Avoid repeated reflections for the same user message.
- Build a task context from recent messages, tool usage, and repo signals.
- Request a structured self-assessment from the agent.
- Parse JSON self-assessment and evaluate workflow gates.
- If self-assessment parsing fails, fall back to a judge session and parse a JSON verdict.
- Write verdict signals to .reflection/verdict_<session>.json for TTS and Telegram gating.
- Persist reflection analysis data to .reflection/<session>_<timestamp>.json.
- Provide feedback only when incomplete; show a toast when complete or when user action is required.

## Configuration
- reflection.yaml at ~/.config/opencode/reflection.yaml can specify judge models in order.

Example:
```yaml
models:
  - github-copilot/claude-opus-4.6
  - github-copilot/gpt-5.2-codex
```

- Custom prompt override: place reflection.md in the workspace root.
- Debug logging: REFLECTION_DEBUG=1

## Design
### Workflow Gates
The plugin infers workflow requirements from repo signals and user intent:
- Tests required: when task type is coding and repo has test script/tests dir or user mentions tests.
- Build required: when repo has build script or user mentions build.
- PR required: always true.
- CI required: always true.
- Local test commands required: if tests are required but no local test command detected.

### Self-Assessment Contract
The agent must return JSON with evidence and status, including:
- tests.ran, tests.results, tests.ran_after_changes, tests.commands
- build.ran, build.results
- pr.created, pr.url, pr.ci_status, pr.checked
- remaining_work, next_steps, needs_user_action
- stuck, alternate_approach

### Decision Outcomes
- complete: true -> toast success, write verdict signal.
- requires human action -> toast warning, no follow-up prompt.
- incomplete -> push feedback into the session with next steps.

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
- <workspace>/.reflection/verdict_<session>.json (signal for TTS/Telegram)
- <workspace>/.reflection/<session>_<timestamp>.json (full analysis record)
- reflection.yaml in ~/.config/opencode (judge model list)
- reflection.md in workspace (optional custom prompt)

## Operational Notes
- Judge sessions are created via promptAsync and polled until completion.
- The plugin avoids infinite loops by tracking last reflected user message id and active reflections.
- Abort handling uses session.error with a cooldown to skip reflection on canceled tasks.
`;
