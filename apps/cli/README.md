# slack-dot

Set up and run **dot**, a Slack assistant backed by Codex on your ChatGPT plan, on a Linux server.

```sh
curl -fsSL https://<install-host>/install.sh | sh
```

That one command installs Docker and Bun if they're missing, installs this CLI, and runs
`slack-dot setup`. Setup:

1. Creates and installs the Slack app: you send one `/slackauthticket …` command in Slack and type
   back the code it shows.
2. Signs in to ChatGPT: open a link on any device; on a server, paste back the address the browser
   ends on.
3. Asks a few questions (name, who can use it, Docker or not, a public address) and the model.
4. Starts the bot as a systemd service and waits until it's connected. The bot DMs you when it's up.

Run as root, bots are system services with state in `/var/lib/slack-dot/<name>/`. As anyone else,
they're that user's services (`systemctl --user`), with state in `~/.slack-dot/<name>/`.

## Commands

| Command                               | What it does                                            |
| ------------------------------------- | ------------------------------------------------------- |
| `slack-dot setup [--name <bot>]`      | Set up a bot, or run again to fix or change one         |
| `slack-dot configure`                 | Model, access, Microsoft, CodeCommit, private notes     |
| `slack-dot login`                     | Sign in to ChatGPT again                                |
| `slack-dot doctor`                    | Check settings, service, Docker, Slack and ChatGPT      |
| `slack-dot update`                    | Update the CLI and bot, push Slack app changes, restart |
| `slack-dot list`                      | Bots on this machine                                    |
| `slack-dot logs [-f]`                 | A bot's log                                             |
| `slack-dot start/stop/restart/status` | Control a bot's service                                 |
| `slack-dot uninstall [--yes]`         | Remove a bot, its Slack app and (if asked) its data     |

Several bots can share a machine, even a Slack workspace: give each its own `--name`.
