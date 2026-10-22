# Installer plan: one-command setup

Status: built (`apps/cli`). Not yet run end to end against a real Slack workspace and ChatGPT account.

## Goal

On a blank Linux server, one command gets you to a working bot you can DM in Slack:

```sh
curl -fsSL https://<s3-host>/install.sh | sh
```

No second command. The script installs everything and runs the whole setup in the same session.
Afterwards, the local `laddu` command changes settings, updates, and diagnoses problems.

With Bun and Docker already there, `bun create laddu` (or `bunx create-laddu`) does the same from
the setup step on: it installs the package globally, since the service runs the bot from where it's
installed and bunx's copy is a throwaway cache, then runs `laddu setup` (`apps/cli/src/create.ts`).

## Apps

- **`apps/cli`**: the `laddu` CLI. It's published to npm as `create-laddu` (`laddu` was taken;
  `create-laddu` is free as of 2026-10-23, and the name makes `bun create laddu` work) and bundles
  the bot from `apps/api`, so one package has everything. Its bins: `laddu`, and `create-laddu`.
- **`apps/web`**: the marketing website, laddu.wtf.
- **`apps/api`**: the bot, unchanged as an app; it gets built into the CLI package.
- **`install.sh`**: a small POSIX shell bootstrap, versioned in the repo and uploaded to S3.

CI publishes the npm package and uploads `install.sh` to S3 whenever a git tag is pushed. The
installed package is code only and never written to; each instance keeps its own state.

## Root vs. user

The installer decides by who runs it:

|               | Root                                | Normal user                             |
| ------------- | ----------------------------------- | --------------------------------------- |
| State         | `/var/lib/laddu/<name>/`            | `~/.laddu/<name>/`                      |
| Service       | system unit, `/etc/systemd/system/` | user unit, `~/.config/systemd/user/`    |
| Control       | `systemctl …`                       | `systemctl --user …`, lingering enabled |
| Docker access | already has it                      | added to the `docker` group             |

## `install.sh`

1. Detect the OS (Debian/Ubuntu, Fedora/RHEL, Arch) and install `curl`, `unzip` and `ca-certificates`.
2. Install Docker if it's missing and start it. A normal user is added to the `docker` group;
   that group applies only from the next login, so the rest of setup runs under `sg docker`.
3. Install Bun if it's missing.
4. For a normal user, enable lingering (`loginctl enable-linger`) so the service survives logout.
5. Run `bun add -g create-laddu@latest`, which puts `laddu` on the PATH.
6. Run `exec laddu setup < /dev/tty`. With `curl | sh`, stdin is the script itself, so prompts
   have to read from the terminal.

Every step is idempotent, so running the script again repairs or resumes an install.

## `laddu setup [--name <name>]`

The default name is `laddu`. Each instance directory holds `.env`, `.data/`, `AGENTS.local.md` and
`skills.local/`.

1. **Preflight**: Bun, Docker reachable, systemd, free disk space.
2. **Slack** (one manual step):
   - Log in with a ticket. The user pastes `/slackauthticket …` into Slack and clicks Approve, which
     gives us a Slack CLI token for that workspace and user.
   - With that token: `apps.manifest.create` (from the bundled manifest, named after the instance),
     then `apps.developerInstall`, which returns the bot token and the app-level token.
   - The token's `user_id` becomes `OWNER_SLACK_USER_ID`.
   - Fallback when that's blocked (for example, installs need admin approval): paste an app
     configuration token, approve the install from a printed link, and paste the `xoxb` and `xapp` tokens.
3. **Model provider**: only ChatGPT plan for now; the step is pluggable for API keys and other providers later.
   - Headless sign-in: print the authorize URL, the user opens it on any device, and the redirect
     to `127.0.0.1:1455` fails on their machine. They paste that redirected URL back into the
     terminal (the same flow as `gh` and `rclone`). This replaces copying `chatgpt-auth.json` over SSH.
   - List the models the plan allows and pick one, which sets `CODEX_MODEL`.
4. **Options**, all skippable with defaults: who can use it, Docker or host runtime, desktop and
   public URL, Microsoft, CodeCommit.
5. **Write** `.env` with every value quoted.
6. **Service**: install the `laddu@.service` template unit and enable and start
   `laddu@<name>`, as a system or user unit (see above).
7. **Verify**: wait for the service to be active and Slack Socket Mode to connect, then DM the
   owner "I'm up". Print what to do next.

## Other commands

`configure`, `login`, `doctor`, `update` (upgrades the package and restarts every instance), `list`,
`logs`, `start`/`stop`/`restart`, `uninstall`. All take `--name`.

## Code changes

- The bot reads `.env`, data, `AGENTS.local.md` and `skills.local/` from the instance directory
  (`--env-file`, `DATA_DIR`, `CODEX_LOCAL_DIR`), never from the package directory.
- `apps/cli` builds a package with the CLI entry point plus the bot and its non-code files
  (manifest, `agent-home`, `runtime`, `assets`).
- `login` gains the paste-the-redirect-URL mode.
- CI: on each tag, publish to npm and upload `install.sh` to S3.

## How it's built

- **Slack calls:** our own code, no Slack CLI download. The calls and their parameters come from
  the Slack CLI's source (`internal/api/auth.go`, `app.go`). Slack answers the ticket calls only
  for the Slack CLI's User-Agent, so we send that with `laddu` appended. If Slack changes this,
  setup falls back to doing it by hand: a "create app" link with the manifest filled in, then
  pasting the two tokens.
- **Slack app per bot:** named by the user. The slash command follows the name (`/support`), and
  the bot accepts whatever command its app has.
- **State:** the Slack login and the app's credentials go in `.data/slack-app.json` (mode 600).
  `laddu update` uses them to push manifest changes while that login can still be refreshed.
- **Bot changes:** `CODEX_LOCAL_DIR` (where `AGENTS.local.md` and `skills.local/` live) and
  `LADDU_INSTANCE` (labels containers and volumes, so bots never touch each other's). With neither
  set, existing deployments behave as before.

## Open questions

- **Licence:** the package is published as `UNLICENSED` until we pick one.
- **Install host:** the S3 address for `install.sh` (`<install-host>` in the docs).
