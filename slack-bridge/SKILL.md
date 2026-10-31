---
name: opencode-slack-integration
description: Connect a local opencode server to Slack over Socket Mode so channel threads and DMs continue opencode sessions, including permission approvals. Use when asked to connect opencode to Slack, run an opencode Slack bot, or debug Slack bridge sessions and permissions.
---

# opencode Slack integration

Run this bridge beside `opencode serve`. Each channel thread gets one opencode session; each DM channel gets one persistent session. Permission approval is limited to explicitly allowlisted Slack users.

## Requirements

- Node 22 (`>=22 <23`). Node 26 breaks Bolt Socket Mode.
- `opencode serve --port 4096 --hostname 127.0.0.1` with a usable model.
- A Slack app created from `manifest.json`, installed in the target workspace, with Socket Mode enabled.
- Both DMs and “Allow users to send messages from the Messages tab” enabled under App Home.
- `SLACK_ALLOWED_USERS` set to one or more trusted Slack user IDs. Empty means no users are allowed.

## Configure and run

Create a mode-600 env file at `~/.env.d/opencode-slack.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_ALLOWED_USERS=U123,U456
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_DIRECTORY=/absolute/path/to/project
OPENCODE_MODEL=provider/model
SLACK_AUTO_APPROVE=0
```

Store Slack credentials in Bitwarden. Never commit or print tokens. Set `OPENCODE_MODEL` to an existing `provider/model`; a free model can reject prompts after its quota is exhausted.

```bash
cd slack-bridge
npm install
npm test
npm start
```

Use tmux or a process manager for a persistent bridge. Invite the bot into each channel with `/invite @opencode`.

## Verify

1. In a channel, send `@opencode reply with exactly: PONG`; expect `PONG` in a new thread.
2. Reply in that thread without mentioning the bot; expect the same session to continue.
3. DM the bot `Reply with exactly: DMOK`; expect `DMOK`.
4. Request access to an external file. Expect Allow once / Always / Reject buttons. Click Allow once and confirm the pending permission clears and the answer appears.

## Behavior and safeguards

- Streaming placeholders update from opencode events; final text is fetched at `session.idle`.
- `finish: "tool-calls"` keeps the session active until idle.
- Permission events handle `permission.asked` and `permission.updated`.
- Permission buttons require an allowlisted actor and the exact active Slack message/session mapping. API errors preserve the buttons and return an ephemeral retry notice.
- A message received while its session is busy is not queued; Slack receives a notice to resend it after the current reply.
- Session IDs persist in `~/.local/state/opencode-slack/sessions.json`.

## Checks

```bash
node --check bridge.mjs
npm test
```
