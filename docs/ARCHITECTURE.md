# Architecture

A personal Slack assistant. You tag it in a channel (or DM it); it reads the conversation around the
tag, hands the job to an agent, and replies in the thread. The agent is the brain for every request:
Codex on the owner's ChatGPT plan, or OpenCode's free models, each person's pick on dot's Home tab.
The bot itself only moves messages between Slack and the agent.

Status: **V0**, with per-person integrations, computer use and Azure Repos coding tasks.
See [Roadmap](#roadmap).

## Repository layout

Turborepo monorepo on Bun workspaces. Bun APIs only, no `node:*` imports (see `AGENTS.md`).

```text
apps/
  cli/                 `slack-dot`, the installer and admin CLI (docs/INSTALLER.md), published to
                       npm with the bot inside; install.sh is its one-command bootstrap
  api/                 the bot backend (this doc)
    src/
      index.ts         boot: config, ChatGPT token check, Slack Socket Mode
      config.ts        env + paths
      files.ts         JSON / private-file helpers
      sessions.ts      (Slack thread, user) ↔ agent conversation map, per-key queue
      preferences.ts   each person's picks from the Home tab (agent, model, effort, speed)
      inflight.ts      turns in progress, so a restart can resume them
      auth/siwc.ts     Sign in with ChatGPT credentials + token refresh
      auth/login.ts    `bun run login`: one-time OAuth (PKCE, loopback)
      agent/agents.ts  the agents a person can pick, and the one entry point for a turn
      agent/turn.ts    what every agent shares: turn inputs/result, env, workspace, outbox, memory
      agent/codex.ts   runs Codex turns on the ChatGPT plan (in the user's container)
      agent/acp.ts     runs a turn on any Agent Client Protocol agent (steps, steering, Stop)
      agent/opencode.ts OpenCode's free models over ACP (in the user's container)
      agent/containers.ts runtime image + one Docker container per Slack user
      agent/model-proxy.ts keeps the ChatGPT token out of containers
      agent/codex-config.ts Codex provider config (direct, or via the proxy)
      agent/steps.ts   agent items → plain-language progress steps
      agent/errors.ts  failure classes → message + recovery (retry, fresh thread, quota pause)
      agent/learning.ts turn log + background review (memory, personal skills)
      agent/tools.ts   runs runtime/ commands for a user (container or host)
      agent/bot-api.ts API for container commands that need the bot (`schedule`, `ado`, `ms`,
                       `slack`, `desktop link`), signed per turn
      agent/desktop.ts dot's computer, bot side: signed watch/control links, viewer gateway, idle stop
      scheduler.ts     scheduled tasks: store, cron/time-zone maths, 30-second check
      integrations/microsoft.ts one Microsoft sign-in per person: device code, tokens per API
      integrations/azure-devops.ts Azure DevOps requests as the person
      integrations/codecommit.ts CodeCommit Git + PRs using each person's assigned host AWS profile
      integrations/git-http.ts shared Git smart HTTP relay and task branch validation
      integrations/graph.ts Microsoft 365 (Graph) requests, downloads and uploads as the person
      slack/context.ts Slack messages → transcript for Codex
      slack/attachments.ts Slack files in (downloads) and out (outbox uploads)
      slack/handlers.ts mention/DM handling
      slack/messaging.ts `slack find` / `slack dm`: dot DMs people for the person
      slack/api.ts      Slack Free method catalog + bot/user identity and channel access checks
      slack/transfers.ts user-authorized file downloads and external uploads
      slack/automations.ts persisted event rules, delivery queue, retries and history
      slack/forms.ts    persistent button/modal forms; submissions run as their submitter
      slack/user-tokens.ts each person's Slack sign-in (user token), so DMs can go out as them
      slack/reply.ts   streamed reply: steps as Slack task cards, then the answer
      slack/agent-sessions.ts native working status and cancellation for active/queued thread requests
      slack/socket-mode.ts Socket Mode receiver on Bun's WebSocket (Bolt's built-in one
                       needs undici's `ping`, which Bun's undici lacks)
    agent-home/        AGENTS.md = bot persona (mounted read-only into containers); an optional,
                       git-ignored AGENTS.local.md holds per-deployment private instructions,
                       appended to the persona every turn. skills/ = built-in skills;
                       skills.local/ (git-ignored) = the deployment's team skills
    runtime/           commands for Codex (Python, stdlib): `memory` (per-user memory),
                       `recall` (search past conversations), `schedule` (scheduled tasks),
                       `ado` (Azure DevOps), `code` (Azure Repos / CodeCommit coding tasks),
                       `ms` (Microsoft 365), `slack` (Slack Free tools and event rules), `desktop` (dot's computer:
                       starts it, and serves Codex the tools that drive it, over MCP; with
                       `desktop-agent.py`, the person's own computers over SSH), `tailnet`
                       (the container on the person's Tailscale network)
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
   2. set the native agent status to working (no reply placeholder)
   3. build transcript:
        in a thread  → thread replies (conversations.replies)
        top-level    → last N channel messages up to the tag (conversations.history)
        follow-up    → only messages newer than the last turn
   4. Codex turn in the requester's container: new thread, or resume theirs for this Slack thread
        • spawned per turn via @openai/codex-sdk (`codex exec`, through scripts/codex-docker.sh)
        • billed to your ChatGPT plan; the token stays on the host (model proxy)
        • the first action opens a detailed progress accordion; later actions update it
   5. finish the activity record and post the answer (Markdown; split past 12k chars)
      • no actions: post only the answer, or react without posting
      • clear native working status after the turn
```

One (Slack thread, user) = one Codex thread, so two people in the same thread each have their own
conversation with the bot. Turns for the same key are queued. Codex stores conversations in the
user's container volume; the bot stores only `{key → codex thread id, last seen ts}` in
`.data/sessions.json`.

The Slack app declares `agent_view`. Interactive turns set `agents.sessions.setStatus` to
`processing`, then `active` after success, failure or cancellation. The status remains processing
while another person still has work running in that thread. The `agent_session_stopped` event is
deliberately unsubscribed, so Slack shows working status without a native Stop button for anyone.
These native surfaces supplement streamed task cards; unavailable agent APIs don't prevent replies.
The native working indicator is the only progress UI until Codex executes its first action. That
action opens the streamed accordion, titled with the current action and containing actual tools,
commands and file edits. There are no synthetic reading or thinking steps. Turns without actions
post only their final answer (or react), and completed action streams retain an activity record.
The message is saved for restart recovery when it is actually posted, rather than when work starts.

## Isolation: one container per user

Everything Codex executes runs in a Docker container dedicated to the Slack user who asked
(`dot-<first name>-<team>-<user>`, created on first use, `--restart unless-stopped`; found by its
labels and renamed in place when the name changes):

- Non-root user `dot`, all Linux capabilities dropped, `no-new-privileges`, no sudo; 3 GB memory
  (2 GB without the desktop), 2 CPUs, 4096 threads (512 without the desktop), 1 GB shared memory for Chromium.
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
  dot's computer (below, about 1 GB of it). Local speech-to-text uses faster-whisper in
  `/opt/dot/audio`, with compatible pinned PyAV and CTranslate2 versions and a bundled multilingual
  base model. Audio attachments (including Slack recorder `.m4a` files) need no per-turn installs
  or model downloads; the persona gives the exact transcription recipe.
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
- **Watching and taking over** (`agent/desktop.ts`): each person's link lives in dot's **Home tab**
  in Slack (private to them): a banner, the computer's status (on / asleep / not set up), an
  **Open dot's computer** button and how taking over works. It's redrawn with a fresh signed link
  (valid 12 hours) whenever they open the tab (`app_home_opened`) and whenever dot starts using the
  computer for them. Threads stay clean: only the first time someone's dot uses its computer
  does the thread get a note, visible only to them, saying where to find it
  (`.data/…/desktop-introduced.json`). `desktop link "<why>"` still sends the link privately on
  request (e.g. to sign in to a site, so passwords never go through Slack). The link opens a
  gateway in the bot (`DESKTOP_VIEWER_HOST`/`PORT`, local by default; `DESKTOP_PUBLIC_URL` is what
  links point to, e.g. a tunnel or HTTPS domain; `DESKTOP_TAILNET_USERS` get `DESKTOP_TAILNET_URL`
  instead, this machine over Tailscale, ~7 ms where the Cloudflare tunnel took ~150 ms through
  Marseille) that sets a cookie
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

### The person's own computers

The same tools take `machine`, an SSH host in the container's `~/.ssh/config`, and then drive that
computer instead (KDE Plasma for now; macOS, Windows and GNOME later). It's for when the person
isn't using it: there's one pointer, so dot stops when it moves under it.

- **Reach.** `runtime/tailnet` runs Tailscale in userspace in the container (state on the volume,
  the person signs it in once), since the network rules close the tailnet's addresses to the
  container like every private range; SSH goes through it as a `ProxyCommand`. A machine reachable
  from the internet needs only the SSH config.
- **Far end.** `desktop` keeps one SSH connection per machine for its MCP process and sends it
  `runtime/desktop-agent.py`, which runs on that machine's own Python (nothing installed there)
  and answers JSON lines: screenshots from spectacle; screens, windows, focus and the pointer from
  a KWin script that reports back over D-Bus; mouse and keyboard from two virtual devices made
  through `/dev/uinput` (an absolute tablet, so a move lands on the exact pixel, and a keyboard),
  which Plasma's udev rule already opens to whoever is logged in at the screen; controls from
  AT-SPI, turned on for the session (Qt apps share nothing until it is) and moved by each window's
  place from KWin, since Wayland apps only know positions inside their own window.
- **Codex's view.** One screen at a time (the active window's, or `screen=N`), cut out of the
  whole-desktop screenshot and scaled into the same 1280×800 box as dot's own. Before acting it
  checks the screen isn't locked and that the pointer is where dot left it; if not, someone is
  using the machine and nothing is done. Text a US layout can't type is pasted.
- `desktop check <host>` reports the desktop and anything missing, with the commands that fix it.

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

### Coding tasks

The same Codex turn can implement a requested change and return a PR in the Slack thread:

- `code checkout <HTTPS clone URL> [--base <branch>]` reads repo metadata and the connected person's
  commit identity, then creates a Git worktree under `~/workspace/code/<task>/` (host runtime:
  `.data/code/<team>-<user>/<task>/`). Each person caches one clone per canonical repo URL in
  `code/.repos/<hash>/`; the hash also includes the caller's team/user identity. The first clone
  has no checked-out files. Later tasks fetch the latest default or requested branch into the
  cache, then create their own `dot/<slack-user>/<task>` branch at that exact commit. A per-repo
  file lock serializes initialization, fetch and worktree creation, and a completed clone is
  moved into the cache atomically.
- Worktrees share Git objects and refs; working files, indexes, HEADs, commit identities and task
  metadata are separate. `extensions.worktreeConfig` and `git config --worktree` keep identities
  local to each task. `git rev-parse --git-path dot-task.json` locates each worktree's repo/target,
  starting commit and owner in its private Git admin directory. Follow-ups reuse the same worktree.
  Existing standalone task clones still work with `code pr`. There is no automatic task deletion;
  use `git worktree remove` when a task is explicitly discarded, preserving the shared cache.
- Git uses the bot API's `/ado/git/<org>/<project>/_git/<repo>/…` smart HTTP relay. Only the host
  adds the person's Microsoft bearer token; the cached repo's origin stays the canonical Azure URL.
  The signed caller and URL rewrite are passed in the Git process environment, never saved to
  Git config. The relay accepts discovery, fetch and push on `dev.azure.com`, never follows a
  redirect, and streams Git data without the REST response cap. Push requests are limited to
  64 MB; only the caller's `dot/<slack-user>/…` branches may be created or updated. Deletions,
  other refs and compressed pushes are refused.
- Codex reads the repo's instructions, makes the requested change, runs its checks, reviews the
  diff and commits the intended files. `code pr --title "…" --body-file /tmp/pr.md` requires a clean
  checkout with commits after the starting commit, pushes only its task branch without force,
  and opens a draft PR through `/ado/write`. A retry finds the existing active PR and updates
  its branch, title and description. A closed PR requires a new task. No merge or auto-complete
  is configured.
- The persona reports what changed, the PR link, checks that passed and checks it couldn't run.
  A toolchain or service unavailable in the Linux container is reported as a limitation, rather
  than treating a partial check as successful. Private submodules and Git LFS aren't handled by
  these helpers yet.

**AWS CodeCommit.** `code checkout https://git-codecommit.<region>.amazonaws.com/v1/repos/<repo>`
uses the same task directories and Git relay, through `/codecommit/*`. `CODECOMMIT_PROFILES` maps
each Slack user to their own AWS CLI profile on the host; an unassigned user is refused instead
of falling back to the host's default. The CLI's CodeCommit credential helper signs Git access
on the host, and only the relay receives its short-lived credentials. No AWS config, SSH keys,
access keys or signed Git credentials enter a container.

Repository metadata and PR operations use the host CLI. Commit identity comes from the person's
Slack profile. PRs target the recorded branch; source branches must be under the caller's task
namespace. CodeCommit PRs are open for review (there is no draft state); no merge or approval is
requested. The task records the returned PR ID. Retries check that PR's source/target and open
state, then update its title and description. Creation also supplies a stable idempotency token
for a lost response. An expired AWS session tells the operator to renew the assigned profile on
the host. CodeCommit authentication uses the [AWS CLI credential helper](https://docs.aws.amazon.com/cli/latest/reference/codecommit/credential-helper/).

Protocol and authentication: [Git smart HTTP](https://git-scm.com/docs/http-protocol),
[Microsoft Entra authentication for Azure Repos](https://learn.microsoft.com/en-us/azure/devops/repos/git/auth-overview?view=azure-devops).

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

## Messaging people

`runtime/slack` posts to the bot API's `/slack/*` (`slack/messaging.ts`, `slack/user-tokens.ts`).

- **Find.** `slack find` searches the workspace directory (users.list, cached 10 minutes; no bots
  or deactivated accounts) by name or email.
- **As the person.** `slack connect` DMs them a Slack OAuth link with scopes for the Free tools
  (search, conversation/message/file management, profiles, reminders and channel canvases;
  a one-time `state` that lasts 15 minutes). Older DM-only grants need reconnecting. Slack sends them back to
  `/slack/oauth` on the gateway (`DESKTOP_PUBLIC_URL`; it runs for this even without the desktop),
  where the code becomes a user token, kept in `.data/slack-users.json` on the host, never in a
  container. It's refused (and revoked) unless the account that allowed it is the one that asked,
  in this workspace. Then `slack dm` opens their own DM with the recipient and posts the text as
  them. A token Slack stops accepting (revoked, deactivated) is dropped and dot says to reconnect.
  `slack disconnect` revokes it.
- **From dot.** Not connected, or `--from-dot`: dot's DM with the recipient, headed
  "<@sender> asked me to send you this:" and signed "Sent by dot for <@sender>. To answer, message
  them directly."
- **Guardrails.** No bots, deactivated accounts, people outside the workspace or the sender; 20 DMs
  an hour per sender (in memory); every send logged (sender, recipient, how, length). Replies
  aren't relayed. The persona has dot show a draft first when it worded the message itself, and
  send only what the person asked for. Scheduled runs can send, but can't start a sign-in.

## Slack Free tools and event rules

`slack/api.ts` is an explicit method catalog, exposed through signed `/slack/api` requests and
`runtime/slack`. `slack methods [method]` describes arguments and scopes; `slack capabilities`
reports the grant and Free-plan exclusions. The catalog covers search, channel/history/thread
access, messaging/scheduling, reactions, pins, bookmarks, directory/profile/status/DND, files,
reminders and channel canvases. It rejects unknown methods and arguments, caller-supplied tokens,
other-person profile writes, standalone canvas creation, Lists, Workflow Builder and Enterprise
methods. Each call reports the identity used. Auto uses the connected person's token where
supported; an explicit `--as dot` uses the bot. User-only methods never fall back to bot access.
Bot channel access requires the requester to be a member, including public-channel writes.
Private channels in bot directory results are filtered by the requester's membership. Pagination
is explicit and returned results are capped at 400 KB. Slack enforces actual scopes, API method
availability and the Free plan's 90-day history limit.

Uploads/downloads use the person's token through `/slack/upload` and `/slack/download`, capped
at 50 MB. Download hosts and every redirect are checked before sending credentials. Uploads use
Slack's current external-upload protocol. Ordinary reply attachments still use the outbox.

`slack automate welcome <channel> 'Welcome <@{user}>!'` creates a persisted rule, not a memory
note. General rules accept an event, channel, optional text/emoji/domain filters, and a message,
reaction or task action. Task actions run as the owner using the existing scheduled-turn runner;
event content is explicitly untrusted. Rules and deliveries live in `.data/slack-automations.json`,
written atomically with mode 600. A five-second worker rechecks owner access, deduplicates event
IDs, retries deterministic actions up to three times with a stable message ID, and records
results. Interrupted model tasks are marked failed rather than repeating unknown external
effects. Limits: 20 rules per person, 20 deliveries per rule per hour, seven days of terminal
delivery history. Owners can list, inspect history, enable, disable or remove their own rules.
Rules require dot to be in the channel. Link events additionally require matching unfurl domains
in Slack app settings. No rules are enabled merely by installing this feature.

`slack form <JSON>` creates a channel button backed by a stored form definition. The button opens
a modal with text, select and date fields; it displays the instruction and where responses will
be shared. Submission runs as the submitter after rechecking channel membership and the bot's
allow-list. Duplicate view submissions are suppressed. Definitions survive restarts and expire
after 30 days. Slack Free supports these ordinary interactions without Workflow Builder.

`slack ask` (src/slack/questions.ts) posts a question in the turn's thread: one-click buttons, or
radio buttons, checkboxes or a dropdown (in an input block, so picks don't round-trip) with Send,
and a modal for a typed answer. A JSON question is a one-time form: its Answer button opens a modal
with any of Slack's inputs (src/slack/question-fields.ts: text, number, email, URL, selects, radio,
checkboxes, date/time pickers, people and channel pickers, files, rich text). Only the person the
turn is for can answer. The command returns as soon as the question is posted and dot ends its turn
with just a reaction; the answer comes back as a turn of its own (`via: "answer"`), or steers into
theirs if one is running. A reply typed in the thread is their next message and closes the question.
STOP withdraws open questions. Questions live in memory, for 24 hours.

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

Codex creates them with the `schedule` command (`--at` once, or `--cron`, minimum interval one
minute; times in the person's Slack time zone). The command calls the bot's API (`agent/bot-api.ts`) with
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

## The other brain: OpenCode over ACP

Each person picks their agent on dot's Home tab (`preferences.ts`; `DOT_AGENT` is the default), and
everything for them runs on it, background memory reviews included. The second agent is
[OpenCode](https://opencode.ai) on its free models: no sign-in, no plan. Free models may keep what
they're sent; dot is experimental, so that's accepted. `CODEX_USERS` limits who can run on Codex
(the owner's ChatGPT plan); everyone else is on OpenCode whatever `DOT_AGENT` or their pick says, and
their Home tab doesn't offer Codex.

dot talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), the open
protocol most coding agents speak (Claude, Antigravity, Gemini, Codex and about 40 more in the
[ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)), using the
official `@agentclientprotocol/sdk`. `agent/acp.ts` is the only file that knows the SDK: it starts
the agent, opens or resumes the session, sets the model, approves every permission request (the
container is the boundary), maps tool calls onto the same steps as Codex's (commands, edits, web
search, the desktop's MCP tools) and handles Stop. ACP can't add to a running prompt, so steering
cancels it and sends the new message as the next prompt, as T3 Code does. Adding another ACP agent
is a launch command and its sign-in.

OpenCode runs only in the Docker runtime: the image carries its binary (`ARG OPENCODE`), and
`scripts/opencode-docker.sh` runs `opencode acp` in the person's container with the same persona,
commands, skills and desktop as Codex, config in `OPENCODE_CONFIG_CONTENT` (everything allowed,
no sharing or snapshots) and web search through Exa (`OPENCODE_ENABLE_EXA`). Its conversations
live in the container's home volume; a thread remembers which agent it used, and switching agents
starts it over. The model list on the Home tab is `opencode models opencode` in the image, free
ones only; images are sent only to models that take them.

## Roadmap

**V0 (now).** Slack context, per-person Azure DevOps and Microsoft 365, computer use, scheduled
tasks, Slack DMs and coding tasks in isolated checkouts ending in a draft Azure Repos PR.

**V1.**

- A context map: project names → repos, trackers and docs, so questions about progress
  land on the right sources.
- Deeper Slack context: older history when the tagged message needs it.

**Later.**

- dot's computer, next: pause Codex while someone has control, a Stop button on the viewer page,
  a success rate on a subset of OSWorld tasks.
- A dashboard app for running tasks.
- Guardrails: per-task sandboxes, an audit log of changes.
- More agents over ACP: Claude, Antigravity, DeepSeek (through OpenCode) with each person's sign-in.
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
