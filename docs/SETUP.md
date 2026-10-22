# Setup (apps/api)

## On a server: one command

```sh
curl -fsSL https://<install-host>/install.sh | sh
```

This installs Docker and Bun if they're missing, installs the `slack-dot` CLI (`apps/cli`), and runs
`slack-dot setup`, which creates and installs the Slack app, signs in to ChatGPT, and starts the
bot as a systemd service. See [apps/cli/README.md](../apps/cli/README.md) for the commands
afterwards, and [INSTALLER.md](INSTALLER.md) for how it works. The rest of this page is the manual
setup, for development from this repo.

## Manual setup

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

4. Your Slack profile → ⋮ → **Copy member ID** → `OWNER_SLACK_USER_ID`. At first only you can use
   the bot; open it up with `ALLOWED_SLACK_USERS` (`"*"` for everyone, or member IDs). Being the
   owner gives no other special treatment.
5. Invite the bot to the channels where you'll tag it (`/invite @dot`).

### Updating the app later

When `slack-manifest.yaml` changes (new events, commands, shortcuts), push it with the Slack CLI
from `apps/api`:

```sh
slack login                           # once per machine; see below if it can't prompt
slack manifest validate --app <APP_ID>
slack install --app <APP_ID>          # updates the manifest and reinstalls; tokens stay the same
```

`slack app list` shows the app IDs. Where the CLI can't prompt (scripts, agents), log in in two
steps: `slack login` prints a `/slackauthticket …` command; send it in Slack, approve, then run
`slack login --ticket <ticket> --challenge <code>` with the code Slack shows. Or paste the manifest
by hand: api.slack.com/apps → your app → **App Manifest**.

### Slack agent experience

The manifest declares dot as an agent using `features.agent_view`. For an existing installation,
enable it without overwriting its OAuth URLs, scopes or other deployment settings:

```sh
bun run scripts/slack-sync-events.ts --app <APP_ID> --team <WORKSPACE> --agent-view
systemctl --user restart dot-srafis.service
```

Dot reports native working status while answering. The `agent_session_stopped` event is deliberately
unsubscribed so Slack shows a non-interactive working indicator without a Stop button for anyone.
The sync script removes any existing Stop subscription while preserving other remote events.
The detailed progress accordion appears only after a real tool action, with the current action as
its title. Simple responses use the native indicator until the answer or reaction is ready.
If the workspace rejects agent status calls, ordinary replies and streamed progress still work.
Slack lists top-bar agent display as a paid-plan feature; admins must enable the agent experience,
and members choose visible agents from **More agents → Manage**. The Codex backend is unchanged.

References: [agent development](https://docs.slack.dev/ai/developing-agents/),
[agent sessions](https://docs.slack.dev/ai/agent-sessions/) and
[agent display](https://slack.com/help/articles/33077521383059-Display-AI-agents-and-assistants-in-Slack).

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

Then tag the bot in a channel or DM it. A "Working on it" panel appears in the thread, lists what
Codex is doing with a running clock, and the answer lands under it. The first start builds the
`dot-runtime` image (a few minutes) before the bot connects.

### Private instructions

`agent-home/AGENTS.local.md` (git-ignored) is appended to the persona every turn: use it for
deployment-specific context you'd rather keep out of git (your company, its projects). Anything
there is your own choice, on top of the defaults. Edits to it, or to `AGENTS.md`, apply from the
next message; no restart.

### Team skills

Skills are how-to guides dot follows when a task matches. Put your organization's in
`agent-home/skills.local/<name>/SKILL.md` (git-ignored); the format is in
`agent-home/skills/README.md`. dot also writes personal skills for each person on its own. New
or edited skills apply from the next message.

### Microsoft: Azure DevOps and Microsoft 365 (optional)

Each person connects their own account by asking dot something that needs it; dot DMs them a
Microsoft sign-in code. One app registration in your Microsoft Entra tenant serves both (for Azure
DevOps, the organization must be connected to that tenant: Organization settings → Microsoft
Entra):

1. <https://entra.microsoft.com> → **Applications → App registrations → New registration**. Name it
   `dot`, pick **Accounts in this organizational directory only**, leave the redirect URI empty.
2. **Authentication** → **Allow public client flows** → **Yes** → Save.
3. **API permissions → Add a permission**, all **Delegated**:
   - **Azure DevOps** (under "APIs my organization uses"): `user_impersonation`.
   - **Microsoft Graph**: `User.Read`, `User.ReadBasic.All`, `Mail.ReadWrite`, `Mail.Send`,
     `Calendars.ReadWrite`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `Chat.ReadWrite`,
     `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Team.ReadBasic.All`,
     `Channel.ReadBasic.All`, `Tasks.ReadWrite`. Leave out any area you don't want dot to touch.

   Then **Grant admin consent** (needed for `ChannelMessage.Read.All`, and for everything if your
   tenant doesn't let people approve apps themselves). Without it, each person approves the
   permissions at their own sign-in.

4. From **Overview**, copy the IDs into `.env` and restart:

   ```sh
   MICROSOFT_CLIENT_ID="<Application (client) ID>"
   MICROSOFT_TENANT="<Directory (tenant) ID>"
   ```

If people get **Need admin approval** at sign-in, your tenant's consent policy keeps some of
these for admins (often `Files.ReadWrite.All` and `Sites.ReadWrite.All`). Until an admin grants
consent, list only what people may approve themselves, e.g. with `Files.ReadWrite` (their own
OneDrive) in place of the two `.All` ones; `ms files search` then searches their OneDrive only:

```sh
MICROSOFT_GRAPH_SCOPES="User.Read User.ReadBasic.All Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite Chat.ReadWrite ChannelMessage.Send Team.ReadBasic.All Channel.ReadBasic.All Tasks.ReadWrite"
```

A sign-in is only accepted when the Microsoft account's email matches the person's Slack email.
dot then reads and changes Azure DevOps and Microsoft 365 as the person asking. Permissions added
later apply within minutes after admin consent; otherwise people run the sign-in again.

### dot's computer: watch links

On by default with the Docker runtime. The links dot sends to watch or take over its computer point
at a gateway on `http://localhost:6900`, so they open only on this machine. For people on other
machines, put a tunnel or an HTTPS reverse proxy in front of it and point the links there.

With a domain on Cloudflare, a named tunnel gives a stable HTTPS address (`dot.example.com` here):

```sh
cloudflared tunnel login                          # once; pick the domain in the browser
cloudflared tunnel create dot
cloudflared tunnel route dns dot dot.example.com
```

```yaml
# ~/.cloudflared/dot.yml
tunnel: <tunnel ID printed by `create`>
credentials-file: /home/<you>/.cloudflared/<tunnel ID>.json
ingress:
  - hostname: dot.example.com
    service: http://127.0.0.1:6900
  - service: http_status:404
```

Run it as a user service next to the bot (`ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel
--config /home/<you>/.cloudflared/dot.yml run`, otherwise like the unit below), then in `.env`:

```sh
DESKTOP_PUBLIC_URL="https://dot.example.com"
```

To try it without a domain, `cloudflared tunnel --url http://localhost:6900` prints a
`https://<random>.trycloudflare.com` address; it changes on every restart, and old links stop working.

Keep `DESKTOP_VIEWER_HOST` on `127.0.0.1`: every request needs a signed link, but the tunnel or
proxy is what should face the network. `DESKTOP="false"` turns the computer off.

### Slack Free tools and sending as people (optional)

Without this, DMs dot sends for someone come from dot ("<them> asked me to send you this:"). With
it, each person can connect their own Slack account to search and manage Slack, and their DMs go out as them.

1. The public address from "dot's computer" above has to be set up: Slack sends people back to
   `DESKTOP_PUBLIC_URL/slack/oauth` (HTTPS). The gateway runs for this even with `DESKTOP="false"`.
2. In the Slack app's settings, **OAuth & Permissions → Redirect URLs**: add
   `https://dot.example.com/slack/oauth` (your address) and save. Or put it under
   `oauth_config.redirect_urls` in the manifest.
3. **Basic Information → App Credentials**: copy the Client ID and Client Secret into `.env` and
   restart:

   ```sh
   SLACK_CLIENT_ID="1234567890.1234567890"
   SLACK_CLIENT_SECRET="..."
   ```

People connect by asking dot to DM someone (or "connect my Slack"): dot DMs them a link, they
allow the Free-tool scopes listed in `slack/user-tokens.ts` as themselves, and dot keeps the token in
`.data/slack-users.json`. It's only accepted from the Slack account that asked. "Disconnect my
Slack" revokes it.

Existing DM-only connections must reconnect to grant search, history, channel/file management,
profiles/status, reminders and channel canvas access. The manifest already declares these scopes;
an installer may need to reinstall dot if the installed app has an older grant. No Slack Pro
subscription is needed for these core tools. Free history is limited to 90 days and dot counts
as one of the workspace's ten apps. Lists, Workflow Builder, standalone canvases, custom user
groups and Enterprise APIs are excluded from these tools. The optional Slack agent surfaces above
have their own plan requirements.

Enable the saved event-rule subscriptions on an existing app without overwriting its OAuth URLs:

```sh
cd apps/api
bun run scripts/slack-sync-events.ts --app <APP_ID> --team <WORKSPACE>
systemctl --user restart dot-srafis.service
```

The operator must already be signed in through `slack-cli auth`. Invite dot to channels where
rules or forms should run. Nothing posts automatically until someone creates a rule or form.
Ask dot "welcome everyone joining #general" to save a welcome rule; `slack automate list` and
`slack automate history` show configuration and results. Link-preview rules additionally require
registering the relevant unfurl domains in the Slack app's settings. Forms use ordinary Slack
buttons and modals, and event rules run in our service rather than paid Workflow Builder.

### Azure Repos coding tasks

Uses the existing per-person Microsoft connection above; no PAT or new env settings. The person
needs permission to read the repository, create a branch, contribute code and create PRs.

Ask dot: "In `https://dev.azure.com/<org>/<project>/_git/<repo>`, fix <specific bug> and open a PR."
It creates a separate Git worktree, follows the repo's instructions, runs its checks, and returns a
draft PR with the change and validation. The default target is the repo's default branch; name
another branch in the request when needed. Follow-ups in the same thread can update that PR.
It doesn't merge the PR.

The underlying commands are `code checkout <url> [--base <branch>]` and, from its directory,
`code pr --title "…" --body-file /tmp/pr-description.md`. PR publication needs committed changes
and a clean checkout. Task files persist inside the person's container, under `~/workspace/code/`.
One clone per repo is cached privately under `~/workspace/code/.repos/`; new tasks fetch the latest
target branch and share the cached history through separate worktrees. Their files and indexes
remain independent. Follow-ups reuse the task directory. Existing task clones remain supported.
The helper uses the connected Microsoft account's name and email for commits; its tokens stay
on the host.

Build tools must be available inside the Linux container or installable by its non-root user.
Tasks needing macOS/Xcode, a physical device or unavailable private services report which checks
couldn't run. Private submodules and Git LFS need additional support. Restart the bot after
updating its backend and runtime commands, once no turns are in progress.

### AWS CodeCommit coding tasks

Install AWS CLI v2 on the bot host and sign each person into their own named profile (`aws login
--profile <name>` or `aws sso login --profile <name>` for an IAM Identity Center profile). Keep its
AWS configuration and credentials on the host. The profile needs repository read, Git push,
repository metadata, PR list/read/create and PR title/description update permissions.

Assign profiles explicitly in the same `.env` (comma-separated `SlackID=profile` pairs):

```sh
CODECOMMIT_PROFILES="U0123456789=default,U0987654321=teammate"
AWS_CLI_PATH="/absolute/path/to/aws"
```

`AWS_CLI_PATH` defaults to `aws`; set an absolute path if the service's PATH doesn't include it.
An unassigned Slack user cannot use the host's default profile. Sessions must be renewed on the
host when they expire; no AWS keys or login codes go through Slack.

Ask dot to make a specific change in
`https://git-codecommit.<region>.amazonaws.com/v1/repos/<repo>`, naming the target branch when
needed. `code checkout <url> [--base <branch>]` and `code pr --title "…" --body-file /tmp/pr.md`
use the same cached-repo and per-task worktree workflow. CodeCommit creates an open review PR,
since it has no draft state.
Repeated publication updates that PR; closed PRs need a fresh task. Azure's `ado checkout` and
`ado pr` remain aliases for the unified commands.

### Run as a service (Linux, systemd)

So the bot starts at boot and comes back if it crashes. A user service needs no root:

```ini
# ~/.config/systemd/user/dot.service
[Unit]
Description=dot Slack bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/path/to/repo/apps/api
Environment=PATH=/home/<you>/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/<you>/.bun/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dot          # start now and at every login
sudo loginctl enable-linger $USER          # keep it running when you're logged out / at boot
```

Day to day:

```sh
systemctl --user restart dot               # after code changes (src/, runtime/, docker/)
systemctl --user status dot                # running? since when?
journalctl --user -u dot -f                # live logs (Ctrl-C to stop following)
systemctl --user stop dot                  # stop until the next start or reboot
```

A restart mid-answer is safe: the bot closes the half-finished reply and answers again. Prompt
edits (`AGENTS.md`, `AGENTS.local.md`) need no restart; Slack app changes need `slack install`, not
a restart. Changing `docker/Dockerfile` rebuilds the image on the next start (a few minutes
offline).

## Configuration

| Var                      | Default                 | Notes                                                                                                            |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`        | required                | `xoxb-…`, from installing the app                                                                                |
| `SLACK_APP_TOKEN`        | required                | `xapp-…`, app-level token with `connections:write` (Socket Mode)                                                 |
| `CODEX_MODEL`            | required                | Model slug from `bun run login`                                                                                  |
| `OWNER_SLACK_USER_ID`    | required                | You; see step 2.4. Only the default for `ALLOWED_SLACK_USERS`, no special treatment                              |
| `ALLOWED_SLACK_USERS`    | the owner               | `"*"` for everyone, or comma-separated member IDs                                                                |
| `CODEX_USERS`            | `"*"`                   | Who can run on Codex (your ChatGPT plan): `"*"` or member IDs; everyone else is on OpenCode                      |
| `CODEX_RUNTIME`          | `docker`                | `docker`: one container per Slack user; `host`: on this machine (just yourself, at most)                         |
| `CODEX_REASONING_EFFORT` | `medium`                | `minimal` … `xhigh`                                                                                              |
| `CODEX_FAST`             | `false`                 | `true`: fast mode, quicker answers that use more of the plan's limits                                            |
| `ISOLATE_NETWORK`        | `true`                  | Docker: every container (yours too) gets internet only, not this machine's services, the LAN or other containers |
| `CODEX_SANDBOX`          | `workspace-write`       | Host runtime only: `read-only`, `workspace-write`, `danger-full-access`                                          |
| `CODEX_NETWORK`          | `true`                  | Host runtime only: internet for Codex's shell; containers are always networked                                   |
| `CODEX_WORKDIR`          | `agent-home`            | Codex's working directory; its `AGENTS.md` is the persona                                                        |
| `CONTEXT_MESSAGES`       | `20`                    | Channel messages read before a top-level tag                                                                     |
| `MEMORY_REVIEW_EVERY`    | `3`                     | Turns per person between background memory reviews; `"0"` turns them off                                         |
| `TRIGGER_EMOJI`          | `robot_face`            | Reacting with this emoji to a message asks dot to handle it                                                      |
| `MICROSOFT_CLIENT_ID`    | unset (off)             | Entra app for Azure DevOps and Microsoft 365 sign-in; see "Microsoft" above                                      |
| `MICROSOFT_TENANT`       | `organizations`         | Directory (tenant) ID of that app                                                                                |
| `MICROSOFT_GRAPH_SCOPES` | all of them             | Graph permissions asked for at sign-in; trim when the tenant needs admin approval for some                       |
| `SLACK_CLIENT_ID`        | unset (off)             | With `SLACK_CLIENT_SECRET`: per-person Slack Free tools and sending messages as them; see above                  |
| `SLACK_CLIENT_SECRET`    | unset                   | The Slack app's Client Secret                                                                                    |
| `DESKTOP`                | `true`                  | Docker: a desktop per person that Codex drives and they can watch (see ARCHITECTURE.md, "dot's computer")        |
| `DESKTOP_VIEWER_HOST`    | `127.0.0.1`             | Where the viewer gateway listens                                                                                 |
| `DESKTOP_VIEWER_PORT`    | `6900`                  |                                                                                                                  |
| `DESKTOP_PUBLIC_URL`     | `http://localhost:6900` | What watch/control links point to: a tunnel or an HTTPS domain when people open them from elsewhere              |
| `DESKTOP_TAILNET_URL`    | none                    | This machine on Tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:6901`                              |
| `DESKTOP_TAILNET_PORT`   | viewer port + 1         | The gateway's local port for `tailscale serve`; only it should reach this one                                    |
| `DESKTOP_TAILNET_USERS`  | nobody                  | `U0123=name@github,…`: Slack member → Tailscale login. Their links point to the tailnet address (much faster than a tunnel), which also opens for them without a link|
| `DESKTOP_IDLE_MINUTES`   | `10`                    | A desktop with no actions and no viewers this long is stopped (files and logins stay)                            |
| `DATA_DIR`               | `.data`                 | Credentials, sessions, the bot's `CODEX_HOME`                                                                    |
| `APP_NAME`               | `slack-codex-bot`       | Name shown on the ChatGPT consent screen at first registration                                                   |

Relative paths resolve against `apps/api`.
