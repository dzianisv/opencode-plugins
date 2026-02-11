# Reflection Config (reflection-3)

The reflection-3 plugin can try multiple judge models in order. Configure the
model list in `~/.config/opencode/reflection.yaml`.

## Example

```yaml
models:
  - github-copilot/claude-opus-4.6
  - github-copilot/gpt-5.2-codex
```

## Notes

- Each entry must be `providerID/modelID`.
- The plugin will try each model in order until one returns a valid verdict.
- If all models fail or time out, reflection returns a failure verdict.

## Workflow Gates (reflection-3)

reflection-3 enforces workflow gates using the self-assessment plus GenAI verification:

- Task must be complete and explicitly confirmed by the agent.
- Required local tests must run and pass, and the exact commands must be listed.
- Tests cannot be skipped for reasons like flakiness or “not important”.
- PR creation is required; direct pushes to `main`/`master` are rejected.
- CI checks must be verified as passing (recommend `gh pr checks` or `gh pr view`).

If any of these gates are missing, reflection will mark the task incomplete and push the agent to continue.
