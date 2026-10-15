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
      sessions.ts      (Slack thread, user) ↔ Codex thread map, per-key queue
      inflight.ts      turns in progress, so a restart can resume them
      auth/siwc.ts     Sign in with ChatGPT credentials + token refresh
      auth/login.ts    `bun run login`: one-time OAuth (PKCE, loopback)
      agent/codex.ts   runs Codex turns on the ChatGPT plan (in the user's container)
      agent/containers.ts runtime image + one Docker container per Slack user
      agent/model-proxy.ts keeps the ChatGPT token out of containers
      agent/codex-config.ts Codex provider config (direct, or via the proxy)
      agent/steps.ts   Codex items → plain-language progress steps
      agent/errors.ts  failure classes → message + recovery (retry, fresh thread, quota pause)
      agent/learning.ts turn log + background memory review
      agent/tools.ts   runs runtime/ commands for a user (container or host)
      slack/context.ts Slack messages → transcript for Codex
      slack/attachments.ts Slack files in (downloads) and out (outbox uploads)
      slack/handlers.ts mention/DM handling
      slack/reply.ts   streamed reply: steps as Slack task cards, then the answer
      slack/socket-mode.ts Socket Mode receiver on Bun's WebSocket (Bolt's built-in one
                       needs undici's `ping`, which Bun's undici lacks)
    agent-home/        AGENTS.md = bot persona (mounted read-only into containers)
    runtime/           commands for Codex (Python, stdlib): `memory` (per-user memory),
                       `recall` (search past conversations)
    docker/Dockerfile  per-user runtime image (Debian + the SDK's own codex build)
    scripts/codex-docker.sh stand-in `codex` that runs the real one via `docker exec`
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
   1. allow-list: ALLOWED_SLACK_USERS ("*" = everyone; default: owner only)
   2. react 👀, post "Working on it…" in the thread
   3. build transcript:
        in a thread  → thread replies (conversations.replies)
        top-level    → last N channel messages up to the tag (conversations.history)
        follow-up    → only messages newer than the last turn
   4. Codex turn in the requester's container: new thread, or resume theirs for this Slack thread
        • spawned per turn via @openai/codex-sdk (`codex exec`, through scripts/codex-docker.sh)
        • billed to your ChatGPT plan; the token stays on the host (model proxy)
        • progress events edit the placeholder ("Running `git log`", plan checklist…)
   5. final answer replaces the placeholder (Markdown; split past 12k chars), 👀 → ✅
```

One (Slack thread, user) = one Codex thread, so two people in the same thread each have their own
conversation with the bot. Turns for the same key are queued. Codex stores conversations in the
user's container volume; the bot stores only `{key → codex thread id, last seen ts}` in
`.data/sessions.json`.

## Isolation: one container per user

Everything Codex executes runs in a Docker container dedicated to the Slack user who asked
(`dot-<team>-<user>`, created on first use, `--restart unless-stopped`):

- Non-root user `dot`, all Linux capabilities dropped, `no-new-privileges`, no sudo; 2 GB memory,
  2 CPUs, 512 processes.
- No host files except the persona and Codex config, both read-only. A named volume
  (`dot-home-<team>-<user>`) keeps the user's workspace and Codex sessions; nobody else sees it.
- Internet access on (Codex needs it to reach the model proxy; users need it for `curl`).
- **The ChatGPT token never enters a container.** Codex there talks to `agent/model-proxy.ts`, a
  Bun server on the Docker bridge address (not reachable from the LAN). It requires a random
  per-process key, allows only `POST /v1/responses` and `GET /v1/models`, and adds the real token.
  Verified: no token in any process environment inside the container; other API paths get 403.
- The image (~2.8 GB) carries tools for files people send and ask for: pandas, matplotlib,
  python-docx, openpyxl, reportlab, pypdf, Pillow, pandoc, poppler, qpdf, ImageMagick, ffmpeg.
- The image bundles the exact codex build the SDK ships (`node_modules/@openai/codex-linux-*`),
  and is rebuilt (containers recreated, volumes kept) when that version or the Dockerfile changes.

`CODEX_RUNTIME="host"` runs Codex on the host instead (Codex sandbox only: blocks writes outside
`agent-home`, but can read your files). Owner-only use at most.

## Memory and reliability

Adapted from [Hermes Agent](https://github.com/nousresearch/hermes-agent) (MIT, Nous Research).

- **Per-user long-term memory.** Two capped files on the user's volume, `~/memory/USER.md` (who
  they are, how they like answers; 1,375 chars) and `~/memory/MEMORY.md` (Codex's notes; 2,200
  chars). Codex edits them with the `memory` command (`runtime/memory`, copied into the runtime
  mount and linked into `~/.local/bin`), which enforces the caps and refuses entries that look
  like prompt injection. The bot loads them into the first turn of every new Codex thread, in a
  `<memory-context>` block; resumed threads already have them. When to save is in the persona.
- **Searchable past conversations.** After each turn the bot logs the Slack messages and the reply
  to `~/history/history.db` (SQLite FTS5) on the user's volume; Codex searches it with `recall`
  (`search`, `recent`, `show`). Raw messages, no summaries in between. (Not called `history`:
  that's a bash builtin.)
- **Background memory review.** Every `MEMORY_REVIEW_EVERY` turns per person (default 3; "0" turns
  it off), a separate low-effort Codex run in their container reads the recent turns with `recall`
  and updates memory, catching facts the turns didn't save. It uses plan quota.
- **Duplicate events.** Slack can redeliver an event (e.g. after a socket reconnect); each message
  is answered once (in-memory, 10 minutes).
- **Failures.** `agent/errors.ts` sorts them: usage limit (message with the reset time; Codex is
  skipped for 10 minutes, reviews too), context window full or a capability the plan rejects
  (fresh Codex thread, one retry), dropped model connection (one retry after 15 s; Codex already
  retried), Docker trouble (one retry), auth (log in again), anything else (the error's first line).
  Retries show as a failed step in the reply.
- **Restarts mid-answer.** Every turn is recorded in `.data/inflight.json` until it ends. On startup
  (after stopping orphaned Codex runs) the bot closes replies it left open, marking spinning steps
  failed, and answers turns younger than 30 minutes again; older ones get "please ask again".

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
- **Shared plan.** Every allowed user's turns bill the owner's ChatGPT plan. OpenAI's terms on
  serving others from a personal plan are worth checking before opening this up widely.
- **Integrations vs. multi-user.** Anything private wired in later (email, repos) would be reachable
  by every allowed user unless scoped per user.

## Roadmap

**V0 (now).** Listen to mentions and DMs, read surrounding context, answer via Codex. Shell in a
scratch directory, no integrations.

**V1.**

- Integrations as local MCP servers registered in the bot's `CODEX_HOME/config.toml`: GitHub/repos,
  Outlook (Microsoft Graph), App Store Connect/TestFlight, issue tracker.
- A context map: project names ("Ask AI") → repos, trackers and docs, so questions about progress
  land on the right sources.
- Deeper Slack context: older history when the tagged message needs it.
- Coding tasks in per-task git worktrees, ending in a PR link in the thread.

**Later.**

- A computer for the bot (browser + computer use) for things no API exposes, similar to OpenAI's
  "dots" (always-on agents with their own cloud computer, launched 2026-09-29). Native computer use
  isn't available on the plan route, so this would be a local tool (e.g. a browser-automation MCP
  server on a VM).
- A dashboard app to watch the bot's computer and running tasks.
- Guardrails: approval before write actions, per-task sandboxes, audit log.
- Per-user billing (each user signs in with their own ChatGPT) and per-user usage caps.

## Known V0 limitations

- In channels the bot only responds when tagged, including in threads it's already in.
- In DMs every message is handled, and each top-level DM starts its own thread.
- Files attached to messages new this turn (up to 100 MB each, 20 per turn) are saved in the user's
  workspace under `slack-files/` (host runtime: `.data/slack-files/<team>-<user>/`); PNG, JPEG,
  WebP and GIF up to 20 MB are also shown to the model. Codex reads other formats with its own tools.
- Slack links in the new messages (typed, unfurled or forwarded; up to 3) are read through the API
  and added to the transcript with their attachments, up to 100 messages each. Private channels and
  DMs only if the person asking is a member, so a link can't expose what they couldn't read.
- Each turn gets an outbox, `slack-outbox/<turn>/` (host runtime: `.data/slack-outbox/...`, added
  as a writable dir to the sandbox). Files Codex saves there (up to 10, 50 MB each) are uploaded to
  the thread after the reply. Codex can't generate images on the plan route; it can draw them with code.
- No hosted web search on the plan route (the tool isn't offered); Codex fetches live data with `curl`.
- Anyone allowed can reach the model proxy from their container with its key, i.e. use the plan
  directly (as they can through the bot). No per-user rate limits yet.
- Containers share Docker's default bridge: they can reach services on the host bound to
  `0.0.0.0`/the bridge, and each other's IPs.
- Cancelling a turn stops `docker exec` on the host, not the Codex process inside the container.
- State is in local JSON files; one process only.
