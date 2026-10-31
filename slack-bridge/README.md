# opencode-slack-bridge

Slack Socket Mode bridge for a local `opencode serve`. Each Slack thread maps to one opencode session; each DM channel uses one persistent session.

## Setup

1. Create a Slack app from [`manifest.json`](./manifest.json) and install it in your workspace.
2. Enable Socket Mode and App Home Messages. Allow messages in the Messages tab.
3. Create `~/.env.d/opencode-slack.env` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS`, `OPENCODE_URL`, `OPENCODE_DIRECTORY`, and `OPENCODE_MODEL`. Keep the file mode `600`; store tokens in Bitwarden.
4. Start `opencode serve` with an available model and run the bridge under Node 22:

```bash
nvm use 22
npm install
npm test
npm start
```

Invite the bot to each channel with `/invite @opencode`. `SLACK_ALLOWED_USERS` is required and denies all users when empty.

See [`SKILL.md`](./SKILL.md) for full setup, permission behavior, verification, and troubleshooting.
