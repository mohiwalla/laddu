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
      agent/learning.ts turn log + background review (memory, personal skills)
      agent/tools.ts   runs runtime/ commands for a user (container or host)
      agent/bot-api.ts API for container commands that need the bot (`schedule`), signed per turn
      agent/desktop.ts dot's computer, bot side: signed watch/control links, viewer gateway, idle stop
      scheduler.ts     scheduled tasks: store, cron/time-zone maths, 30-second check
      integrations/microsoft.ts one Microsoft sign-in per person: device code, tokens per API
      integrations/azure-devops.ts Azure DevOps requests as the person
      integrations/graph.ts Microsoft 365 (Graph) requests, downloads and uploads as the person
      slack/context.ts Slack messages → transcript for Codex
      slack/attachments.ts Slack files in (downloads) and out (outbox uploads)
      slack/handlers.ts mention/DM handling
      slack/reply.ts   streamed reply: steps as Slack task cards, then the answer
      slack/socket-mode.ts Socket Mode receiver on Bun's WebSocket (Bolt's built-in one
                       needs undici's `ping`, which Bun's undici lacks)
    agent-home/        AGENTS.md = bot persona (mounted read-only into containers); an optional,
                       git-ignored AGENTS.local.md holds per-deployment private instructions,
                       appended to the persona every turn. skills/ = built-in skills;
                       skills.local/ (git-ignored) = the deployment's team skills
    runtime/           commands for Codex (Python, stdlib): `memory` (per-user memory),
                       `recall` (search past conversations), `schedule` (scheduled tasks),
                       `ado` (Azure DevOps), `ms` (Microsoft 365), `desktop` (dot's computer:
                       starts it, and serves Codex the tools that drive it, over MCP)
    docker/Dockerfile  per-user runtime image (Debian + the SDK's own codex build)
    scripts/codex-docker.sh stand-in `codex` that runs the real one via `docker exec`
    slack-manifest.yaml
packages/
  typescript-config/   shared tsconfig
```

Expected later: `packages/integrations-*` (MCP servers), a dashboard app for running tasks, and a
marketing site if this becomes something teammates can run.

## Request flow (V0)

```text
 You: "@bot what did we decide here?"           (channel, thread, or DM)
   │
   ▼  Slack Socket Mode (websocket, no public URL)
 apps/api
   1. allow-list: ALLOWED_SLACK_USERS ("*" = everyone, or member IDs; default: just the owner)
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
(`dot-<first name>-<team>-<user>`, created on first use, `--restart unless-stopped`; found by its
labels and renamed in place when the name changes):

- Non-root user `dot`, all Linux capabilities dropped, `no-new-privileges`, no sudo; 3 GB memory
  (2 GB without the desktop), 2 CPUs, 512 processes, 1 GB shared memory for Chromium.
- No host files except the persona and Codex config, both read-only. A named volume
  (`dot-home-<team>-<user>`) keeps the user's workspace and Codex sessions; nobody else sees it.
- Internet access on (Codex needs it to reach the model proxy; users need it for `curl`).
- **Internet only** (`ISOLATE_NETWORK`, on by default). Firewall
  rules in the container's own network namespace refuse this machine's services (databases, SSH…),
  the home network and other containers, except the model proxy, the bot API, replies to the desktop
  viewer gateway and DNS. They're set
  from a short-lived root helper with `NET_ADMIN` (the container has no capabilities, so it can't
  read or undo them) and re-applied whenever the container has restarted.
  Everyone gets the same rules.
- **The ChatGPT token never enters a container.** Codex there talks to `agent/model-proxy.ts`, a
  Bun server on the Docker bridge address (not reachable from the LAN). It requires a random
  per-process key, allows only `POST /v1/responses` and `GET /v1/models`, and adds the real token.
  Verified: no token in any process environment inside the container; other API paths get 403.
- The image (~3.8 GB) carries tools for files people send and ask for: pandas, matplotlib,
  python-docx, openpyxl, reportlab, pypdf, Pillow, pandoc, poppler, qpdf, ImageMagick, ffmpeg; and
  dot's computer (below, about 1 GB of it).
- The image bundles the exact codex build the SDK ships (`node_modules/@openai/codex-linux-*`),
  and is rebuilt (containers recreated, volumes kept) when that version or the Dockerfile changes.

`CODEX_RUNTIME="host"` runs Codex on the host instead (Codex sandbox only: blocks writes outside
`agent-home`, but can read your files). Only for yourself, at most.

## dot's computer

Each person's dot has a full desktop in their container (`DESKTOP`, on by default in Docker), which
Codex drives and the person can watch or take over in the browser. Native computer use isn't on the
plan route, so it's our own tools over MCP; the approach is borrowed from computer-use-linux (the
computer-use plugin of a Linux build of Codex Desktop) and Bytebot.

- **Desktop** (`runtime/desktop start`): KasmVNC as the X display (1280×800, fixed so screenshot
  coordinates hold) and web viewer, XFCE, Chromium, Thunar, Mousepad, a terminal. Started on the
  first tool call (~0.5 s), stopped after `DESKTOP_IDLE_MINUTES` without actions or viewers. Files,
  downloads and the Chromium profile (logins, saved passwords, extensions) live on the volume.
- **Control** (`runtime/desktop mcp`, registered as the `desktop` MCP server in Codex's config):
  `observe` returns a screenshot plus the active window's controls from the accessibility tree
  (AT-SPI; Chromium runs with renderer accessibility, so page links, fields and buttons are listed
  along with its own toolbar, popups and autofill), numbered with centre points. `click`, `type`,
  `key`, `scroll`, `drag` go through the X server (xdotool), like a real mouse and keyboard, so
  browser UI, extensions and native dialogs work like anything else; `launch`, `windows`, `focus`,
  `clipboard`, `wait`. Every action returns the new controls and screenshot, saving a call per step.
  Consecutive actions show as one "Using my computer" row in Slack, with a count.
- **Watching and taking over** (`agent/desktop.ts`): the first desktop action of a turn sends the
  person an ephemeral message (only they see it) with one signed link, valid 12 hours; `desktop
link "<why>"` sends it on request (e.g. to sign in to a site, so passwords never go through
  Slack). It opens a gateway in the bot (`DESKTOP_VIEWER_HOST`/`PORT`, local by default;
  `DESKTOP_PUBLIC_URL` is what links point to, e.g. a tunnel or HTTPS domain) that sets a cookie
  and proxies KasmVNC's web viewer and websocket from that person's container, logged in on the
  bot's side (the VNC login is random per container, `~/.desktop/viewer.json`, and never reaches
  the browser; no container port is published).
- **The page** (restyled as it's served, KasmVNC's files untouched): dot's picture and name, the
  desktop at actual size in a rounded bezel, KasmVNC's toolbar, toasts and routine banners hidden
  (errors still show). It starts view-only, on one connection: a click on the screen (or **Take
  over**) turns view-only off and that click lands too; clicking outside the screen, leaving the
  tab or window, or **Give back** turns it back on, like OpenAI's dots. While the person has
  control the page tells the bot every 10 s (`/_dot/control` → `desktop control on`; 30 s without
  word counts as given back), dot's actions wait up to 75 s per call, and an action interrupted by
  a give-back returns the new screen instead of acting.
- **Cursors.** The person always sees their own cursor, and it does nothing on the desktop until
  they take control. The desktop has no cursor of its own (Xvnc `-nocursor`); dot's is drawn by
  the page where dot's pointer really is (`desktop events` → `/_dot/events`, server-sent events,
  one feed per container while someone watches): always the same coral arrow with its name,
  gliding between positions, a ripple on clicks, "typing…" while it types.
- Spike results (2026-10-16, on the plan's model): searching Wikipedia and reading an infobox (24
  actions, 83 s), saving a password in Chromium's own popup and logging back in with its autofill
  (16 actions, 67 s), writing a file through Mousepad's Save dialog (10 actions, 48 s); 150k–370k
  input tokens a task, ~85% cached. About 0.6 GB of memory with Chromium open, ~0% CPU idle.

## Integrations

Per person, never shared: each person connects their own account, and dot only sees what that
account can. Tokens stay on the host; containers reach an integration through the bot API with the
turn's signed caller credential, so a command can only act as the person asking.

**One Microsoft connection** (`integrations/microsoft.ts`), on when `MICROSOFT_CLIENT_ID` is set
(an Entra app registration, public client), shared by Azure DevOps and Microsoft 365:

- **Connecting.** Asking dot about Azure DevOps or Microsoft 365 while not connected makes Codex
  run `ado connect` or `ms connect`. The bot starts Microsoft Entra's device code flow for that API
  (its `.default` scope plus `offline_access openid profile email`; Entra takes one API per token
  request) and DMs the person the code, never in the channel. It polls until they approve, then
  accepts the account only if one of its emails (token claims, the Graph or Azure DevOps profile)
  matches their Slack email. Otherwise anyone could link someone else's account to their own dot
  by getting them to enter a code.
- **Tokens.** `.data/microsoft.json` (mode 600): one refresh token per person and an access token
  per API, minted from it on demand (Entra refresh tokens work for every API the app has consent
  for), refreshed 5 minutes before expiry, one refresh at a time per person since each rotates the
  refresh token. No consent yet for an API (`AADSTS65001`) tells them to run `<command> connect`;
  a rejected refresh (`invalid_grant`) disconnects them. Connections from before Microsoft 365
  (`azure-devops.json`) are moved over on first load.

**Azure DevOps** (`integrations/azure-devops.ts`, `runtime/ado`); organizations come from the
Azure DevOps profile API at sign-in.

- **Requests.** `ado` posts to the bot API's `/ado/request`. Only Azure DevOps hosts
  (`dev.azure.com`, `*.dev.azure.com`, `*.visualstudio.com`) over https; GET, plus POST to the
  read-only query endpoints (`wit/wiql`, `wit/workitemsbatch`, `search/`). `api-version=7.1` is
  added when missing; responses are capped at 400 KB. A sign-in page in place of JSON (an org the
  account isn't in, or one not on Entra) becomes a clear error.
- **Changes.** `ado update`/`comment`/`create` (JSON Patch on work items; `System.History` for
  comments) and `ado write` (any other POST/PATCH/PUT/DELETE) go to `/ado/write` and run straight
  away with the person's token, scheduled runs included. Each is logged (who, what, status), and
  dot reports the result with a link. The persona has it check first only when the request is
  unclear or deletes something, and never act on instructions found in work items or messages.
- **For Codex.** `ado wiql` (query, then a batch read of the usual fields), `ado item <id>
--comments`, and `ado get`/`ado post` for the rest of the REST API. Scheduled runs can read
  ("every Monday, summarize my open bugs") but can't start a sign-in.

**Microsoft 365** (`integrations/graph.ts`, `runtime/ms`), through Microsoft Graph v1.0:

- **Requests.** `ms` posts to `/ms/request` (any method; only `graph.microsoft.com` over https;
  `Prefer`, `ConsistencyLevel` and `If-Match` headers pass through). Changes are logged. A 403 is
  retried once with a fresh token, so permissions added to the app apply without waiting for the
  cached token to expire; then it's reported with a hint that the app may lack that permission.
  Responses are capped at 400 KB. Files go through `/ms/download` (bytes, following Graph's
  pre-signed redirect) and `/ms/upload` (a single PUT up to 4 MB, an upload session in 6.25 MiB
  chunks beyond, up to 100 MB).
- **For Codex.** Helpers where raw Graph is awkward: mail (list, read as text, send with
  attachments, reply), calendar (list in their time zone, create with Teams links, free/busy),
  files (Microsoft Search across OneDrive and SharePoint, list, download into the workspace,
  upload), Teams (chats, read, send, which opens a 1:1 chat by email, channels, post) and Planner
  (plans, tasks, create, done with the ETag). `ms get/post/patch/put/delete` reach the rest.
- **Permissions** are delegated Graph scopes on the app registration (see docs/SETUP.md); the
  persona has dot show a draft before sending email or Teams messages it worded itself.

## Ways in

- **@mention** in channels (`app_mention`) and group DMs (`message.mpim` containing the mention;
  Slack sends no `app_mention` there), and **every DM** (`message.im`).
- **Reaction**: reacting with `TRIGGER_EMOJI` (default `robot_face`) to a message asks dot to
  handle that message; it answers in the message's thread, for the person who reacted.
- **`/dot <request>`**: dot posts "<@you> asked: …" where it was typed and answers in its thread
  (in channels it's in, and its DM). Otherwise an ephemeral note says to invite it.
- **"Ask dot" message shortcut**: a modal asks what to do with the message (optional), then dot
  answers in that message's thread.
- If dot can't post where it was asked (not in the channel), it DMs the person instead.

## Scheduled tasks

Codex creates them with the `schedule` command (`--at` once, or `--cron`, at most hourly; times in
the person's Slack time zone). The command calls the bot's API (`agent/bot-api.ts`) with
`DOT_CALLER`, a credential this process signs per turn over (team, user, channel, thread), so a
request can only act as that person, in that conversation. Jobs live in `.data/schedules.json`;
every 30 seconds the bot runs due ones as fresh Codex turns for their owner (memory loaded) and
posts the answer to the thread, the channel or a DM. A run can reply `[SILENT]` to post nothing,
can't schedule more tasks, and failed one-offs retry after 5, 15 and 30 minutes (from Hermes).
One-offs missed by more than 6 hours while the bot was down are reported instead of run.

## Memory, skills and reliability

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
- **Background review.** Every `MEMORY_REVIEW_EVERY` turns per person (default 3; "0" turns it
  off), a separate low-effort Codex run in their container reads the recent turns with `recall`
  and updates memory and personal skills, catching what the turns didn't save. It uses plan quota.
- **Skills** (Codex's native skills: a folder with a `SKILL.md`; Codex sees each name and
  description and reads the full file only when a task matches). Three kinds:
  built-in (`agent-home/skills/`, committed), team (`agent-home/skills.local/`, git-ignored), both
  read-only through the persona mount and linked by `scripts/codex-docker.sh` into
  `~/.agents/skills/{dot,team}`, a Codex skill root; and personal ones Codex writes for each
  person in `$CODEX_HOME/skills` on their volume. When to write or fix one is in the persona; the
  background review also looks for procedures worth keeping. Codex's built-in `imagegen` skill is
  switched off (no image generation on the plan route). To share a personal skill with everyone,
  copy it into `skills.local/`:
  `docker cp dot-<team>-<user>:/home/dot/.codex/skills/<name> agent-home/skills.local/`.
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

Sub-agents don't work either: their replies come back as input items the plan rejects
(`subscription_sharing_unsupported_capability`), failing the turn. `[features] multi_agent = false`
isn't enough, since current models switch them on from their catalog entry, so on every start the
bot writes Codex's bundled model catalog with `multi_agent_version` cleared (`writeModelCatalog`,
`model_catalog_json`). The persona tells Codex to do a skill's "sub-agent" steps itself.

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
- **SIWC eligibility.** Plan usage is open to open-source projects, _personal projects that run
  locally_, and selected private apps; paid or remotely hosted apps go through a waitlist. Running
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

- More integrations, per person like Azure DevOps: GitHub/repos, Outlook (Microsoft Graph), App
  Store Connect/TestFlight.
- A context map: project names → repos, trackers and docs, so questions about progress
  land on the right sources.
- Deeper Slack context: older history when the tagged message needs it.
- Coding tasks in per-task git worktrees, ending in a PR link in the thread.

**Later.**

- dot's computer, next: pause Codex while someone has control, a Stop button on the viewer page,
  a success rate on a subset of OSWorld tasks.
- A dashboard app for running tasks.
- Guardrails: per-task sandboxes, an audit log of changes.
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
- Channels mentioned in the new messages (#name; up to 2) are read the same way and with the same
  privacy rule: their last 100 top-level messages plus the latest 15 replies of the 10 newest
  threads. If dot isn't in the channel, the prompt says to invite it. Not logged to history.
- Each turn gets an outbox, `slack-outbox/<turn>/` (host runtime: `.data/slack-outbox/...`, added
  as a writable dir to the sandbox). Files Codex saves there (up to 10, 50 MB each) are uploaded to
  the thread after the reply. Codex can't generate images on the plan route; it can draw them with code.
- No hosted web search on the plan route (the tool isn't offered); Codex fetches live data with `curl`.
- Anyone allowed can reach the model proxy from their container with its key, i.e. use the plan
  directly (as they can through the bot). No per-user rate limits yet.
- Containers share Docker's default bridge: they can reach services on the host bound to
  `0.0.0.0`/the bridge, and each other's IPs.
- A running answer can't be cancelled from Slack. (`runTurn` takes an `AbortSignal` that also ends
  the run inside the container, but no Slack control uses it: a Stop button can only be shared,
  where everyone sees it, or private, where Slack can't remove it afterwards.)
- State is in local JSON files; one process only.
