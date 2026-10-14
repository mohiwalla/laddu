# Architecture

A personal Slack assistant. You tag it in a channel (or DM it); it reads the conversation around the
tag, hands the job to Codex, and replies in the thread. Codex is the brain for every request; the
bot itself only moves messages between Slack and Codex.

Status: **V0**, which listens and responds. No integrations yet. See [Roadmap](#roadmap).

## Repository layout

Turborepo monorepo on Bun workspaces. Bun APIs only, no `node:*` imports (see `AGENTS.md`).

```text
apps/
  api/                 the bot backend (this doc)
    src/
      index.ts         boot: config, ChatGPT token check, Slack Socket Mode
      config.ts        env + paths
      files.ts         JSON / private-file helpers
      sessions.ts      Slack thread ↔ Codex thread map, per-thread queue
      auth/siwc.ts     Sign in with ChatGPT credentials + token refresh
      auth/login.ts    `bun run login`: one-time OAuth (PKCE, loopback)
      agent/codex.ts   runs Codex turns on the ChatGPT plan
      slack/context.ts Slack messages → transcript for Codex
      slack/handlers.ts mention/DM handling, progress, replies
      slack/socket-mode.ts Socket Mode receiver on Bun's WebSocket (Bolt's built-in one
                       needs undici's `ping`, which Bun's undici lacks)
    agent-home/        Codex's working directory; AGENTS.md = bot persona
    slack-manifest.yaml
packages/
  typescript-config/   shared tsconfig
```

Expected later: `packages/integrations-*` (MCP servers), a dashboard app to watch what the bot is
doing on its computer, and a marketing site if this becomes something teammates can run.

## Request flow (V0)

```text
 You: "@bot what did we decide here?"           (channel, thread, or DM)
   │
   ▼  Slack Socket Mode (websocket, no public URL)
 apps/api
   1. owner check: only OWNER_SLACK_USER_ID is answered, everyone else is ignored
   2. react 👀, post "Working on it…" in the thread
   3. build transcript:
        in a thread  → thread replies (conversations.replies)
        top-level    → last N channel messages up to the tag (conversations.history)
        follow-up    → only messages newer than the last turn
   4. Codex turn: new thread, or resume the one mapped to this Slack thread
        • spawned per turn via @openai/codex-sdk (`codex exec`)
        • billed to your ChatGPT plan through a SIWC access token
        • progress events edit the placeholder ("Running `git log`", plan checklist…)
   5. final answer replaces the placeholder (Markdown; split past 12k chars), 👀 → ✅
```

One Slack thread = one Codex thread. Turns in the same Slack thread are queued, never run in parallel.
Codex stores the conversation in its own home (`.data/codex-home/sessions`); the bot stores only
`{slack thread → codex thread id, last seen ts}` in `.data/sessions.json`.

## The brain: Codex on your ChatGPT plan

Auth uses **Sign in with ChatGPT** (SIWC), which OpenAI opened to third-party tools at DevDay on
2026-09-29. The bot registers as its own client, not by reusing the Codex CLI's login.

- `bun run login` runs the documented flow: `client_id=dynamic_agent_client` on first registration,
  `ext_agent_host_id` per machine, PKCE S256, loopback `http://127.0.0.1:1455/auth/callback`, scopes
  `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource
  `https://api.openai.com/v1`. The ID token is verified against OpenAI's JWKS.
- The **plan usage** grant (`chatgpt.tokens.use.direct`) is what lets requests bill your plan.
  Without it the bot refuses to start.
- Access tokens last 1 h and refresh tokens 30 days, rotated on every refresh. `getAccessToken()`
  refreshes 5 min before expiry and serializes refreshes. Terminal refresh errors clear the tokens
  and ask you to run `bun run login` again.
- Codex gets a custom provider in its own `CODEX_HOME/config.toml` (`env_key = "ACCESS_TOKEN"`,
  `wire_api = "responses"`), matching OpenAI's Codex app-server guide. Since every turn is a fresh
  `codex exec`, each turn simply gets a freshly refreshed token, so no process restarts are needed.
- The Codex child gets the environment minus `SLACK_*` secrets, and its own `CODEX_HOME`, so your
  personal `~/.codex` config, MCP servers and sessions never leak in.

What the plan route doesn't support (OpenAI preview limits): hosted MCP/connectors, native computer
use, image generation, file search, Code Interpreter. Local tools (shell, local MCP servers) run
inside Codex and do work, which is how integrations will be added.

Docs: [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source),
[sign-in contract](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[Codex app-server on a plan](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Constraints we designed around

- **Slack free plan.** The bot is one custom app, so it fits under the free plan's 10-app limit.
  Integrations (Outlook, GitHub, TestFlight…) live in this backend as Codex tools, not as Slack apps.
  Free plan history is limited to 90 days, which also bounds what the bot can read.
- **Slack history rate limits.** The 2025 limits on `conversations.history/replies` (1 req/min, 15
  messages) apply to commercially distributed apps. Internal, workspace-built apps like this one keep
  Tier 3 limits.
- **SIWC eligibility.** Plan usage is open to open-source projects, *personal projects that run
  locally*, and selected private apps; paid or remotely hosted apps go through a waitlist. Running
  the bot on your own machine is the clear case. For a server, OpenAI documents a "self-hosted VM"
  path (sign in locally, copy credentials over SSH), but check it still fits the terms before
  relying on it.
- **Owner only.** Your ChatGPT plan and, later, your accounts sit behind this bot, so it answers
  exactly one Slack user.

## Roadmap

**V0 (now).** Listen to mentions and DMs, read surrounding context, answer via Codex. Shell in a
scratch directory, no integrations.

**V1.**

- Integrations as local MCP servers registered in the bot's `CODEX_HOME/config.toml`: GitHub/repos,
  Outlook (Microsoft Graph), App Store Connect/TestFlight, issue tracker.
- A context map: project names ("Ask AI") → repos, trackers and docs, so questions about progress
  land on the right sources.
- Deeper Slack context: older history and linked threads when the tagged message needs them.
- Coding tasks in per-task git worktrees, ending in a PR link in the thread.

**Later.**

- A computer for the bot (browser + computer use) for things no API exposes, similar to OpenAI's
  "dots" (always-on agents with their own cloud computer, launched 2026-09-29). Native computer use
  isn't available on the plan route, so this would be a local tool (e.g. a browser-automation MCP
  server on a VM).
- A dashboard app to watch the bot's computer and running tasks.
- Guardrails: approval before write actions, per-task sandboxes, audit log.
- Multi-user or teammate-run instances (needs per-user SIWC and a look at OpenAI's terms).

## Known V0 limitations

- In channels the bot only responds when tagged, including in threads it's already in.
- In DMs every message is handled, and each top-level DM starts its own thread.
- Files and images in Slack are mentioned by name only; their content isn't fetched.
- Web search is off (support on the plan route depends on model and account policy).
- State is in local JSON files; one process only.
