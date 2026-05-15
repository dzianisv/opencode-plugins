# opencode-auto-review

`opencode-auto-review` spawns a review child session after task completion using a different model.

## Install

### A) Single-file copy (drop-in)

```bash
cp auto-review.ts ~/.config/opencode/plugins/
```

### B) npm package

Add `"opencode-auto-review"` to the `plugin` array in `opencode.json`.

## Configuration

- `AUTO_REVIEW_DEBUG=1` enables debug logging.

## How it works

- Listens for `session.idle`
- Creates a child review session
- Uses a different model to assess completion quality

## Skips

- Aborted sessions
- Child sessions
- Trivial interactions with fewer than 3 tool calls
