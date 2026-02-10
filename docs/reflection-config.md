# Reflection Config (reflection-static)

The static reflection plugin can try multiple judge models in order. Configure the
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
