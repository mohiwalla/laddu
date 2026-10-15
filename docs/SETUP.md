# Setup (apps/api)

Needs Bun ≥ 1.4, Docker (your user in the `docker` group) and a ChatGPT Plus or Pro account. All
commands run from `apps/api` unless noted. The first start builds the `dot-runtime` image (a minute or two).

## 1. Install

```sh
bun install          # from the repo root
cp apps/api/.env.example apps/api/.env
```

## 2. Create the Slack app

### With the Slack CLI (recommended)

The CLI is installed as `slack-cli` (`curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash -s slack-cli`)
so it doesn't clash with the Slack desktop app's `slack`. `apps/api/.slack/` and
`apps/api/scripts/slack-hooks.ts` connect it to this Bun app.

```sh
slack-cli login        # paste the /slackauthticket command it prints into Slack
cd apps/api
slack-cli run          # creates + installs a "(local)" dev app from slack-manifest.yaml, then starts the bot
```

`slack-cli run` passes `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` to the bot itself, so leave them out
of `.env`. It restarts the bot when `src/` changes and reinstalls the app when the manifest
changes. You still need `OWNER_SLACK_USER_ID` (step 4 below) and the ChatGPT sign-in (section 3).

### By hand

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pick your workspace →
   paste `apps/api/slack-manifest.yaml`.
2. **Basic Information → App-Level Tokens** → generate one with `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → install to the workspace (pick any channel when it asks; that's for the
   incoming-webhook scope) → copy the Bot User OAuth Token → `SLACK_BOT_TOKEN` (`xoxb-…`). Also
   save the User OAuth Token (`xoxp-…`) as `SLACK_USER_TOKEN`; V0 doesn't use it yet.

   The manifest requests every scope a non-Enterprise workspace can grant (its header lists the
   few left out and why), so new features shouldn't need a reinstall. If Slack rejects one of the
   newer scopes (`code_channels:manage`, `mcp:connect`, `assistant:write`), delete that line and retry.

4. Your Slack profile → ⋮ → **Copy member ID** → `OWNER_SLACK_USER_ID`.
5. Invite the bot to the channels where you'll tag it (`/invite @codex`).

## 3. Sign in with ChatGPT

```sh
bun run login
```

This opens a browser. Sign in, then **allow ChatGPT plan usage**. When it's done, the terminal lists
the models your plan can use. Put one in `.env` as `CODEX_MODEL`.

Credentials are saved to `.data/chatgpt-auth.json` (mode 600, git-ignored). The bot refreshes them
on its own. Run `bun run login` again only if the bot tells you the session ended.

Spending caps for this app: <https://chatgpt.com/settings/usage>.

### Running on a server without a browser

The OAuth callback goes to `127.0.0.1` on the machine with the browser, so:

1. On the server, run `bun run login` once and stop it with Ctrl-C. This creates
   `.data/chatgpt-host.json` (the server's own host ID).
2. On your laptop, run `bun run login` with the same ChatGPT account.
3. Copy only `.data/chatgpt-auth.json` to the server over SSH. Keep the server's `chatgpt-host.json`.

From then on the server handles refreshes. Read the eligibility note in
[ARCHITECTURE.md](ARCHITECTURE.md#constraints-we-designed-around) before hosting it remotely.

## 4. Run

```sh
bun run dev      # from apps/api, with reload; or `bun run dev` at the root via turbo
bun run start
```

Then tag the bot in a channel or DM it. You'll see 👀, a "Working on it…" reply that updates as
Codex works, then the answer, and ✅ on your message.

## Configuration

| Var                      | Default           | Notes                                                                            |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| `CODEX_MODEL`            | required          | Model slug from `bun run login`                                                  |
| `ALLOWED_SLACK_USERS`    | owner only        | `"*"` for everyone, or comma-separated member IDs                                |
| `CODEX_RUNTIME`          | `docker`          | `docker`: one container per Slack user; `host`: on this machine (owner-only use) |
| `CODEX_REASONING_EFFORT` | `medium`          | `minimal` … `xhigh`                                                              |
| `CODEX_SANDBOX`          | `workspace-write` | Host runtime only: `read-only`, `workspace-write`, `danger-full-access`          |
| `CODEX_NETWORK`          | `true`            | Host runtime only: internet for Codex's shell; containers are always networked   |
| `CODEX_WORKDIR`          | `agent-home`      | Codex's working directory; its `AGENTS.md` is the persona                        |
| `CONTEXT_MESSAGES`       | `20`              | Channel messages read before a top-level tag                                     |
| `DATA_DIR`               | `.data`           | Credentials, sessions, the bot's `CODEX_HOME`                                    |
| `APP_NAME`               | `slack-codex-bot` | Name shown on the ChatGPT consent screen at first registration                   |

Relative paths resolve against `apps/api`.
