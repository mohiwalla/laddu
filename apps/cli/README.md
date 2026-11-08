# laddu

Set up and run **laddu**, an AI teammate in Slack, on a Linux server. Each person uses their own
AI subscription (ChatGPT, Claude) or OpenCode's free models. laddu is open source (MIT) and free
forever. More at [github.com/mohiwalla/laddu](https://github.com/mohiwalla/laddu).

```sh
curl -fsSL https://laddu.wtf/install.sh | sh
```

That one command installs Docker and Bun if they're missing, installs this CLI, and runs
`laddu setup`. Setup:

1. Creates and installs the Slack app: you send one `/slackauthticket …` command in Slack and type
   back the code it shows.
2. Asks a few questions (name, who can use it, a desktop, a public address).
3. Starts the bot as a systemd service and waits until it's connected. The bot DMs you when it's up.

Run as root, bots are system services with state in `/var/lib/laddu/<name>/`. As anyone else,
they're that user's services (`systemctl --user`), with state in `~/.laddu/<name>/`.

## Commands

| Command                           | What it does                                            |
| --------------------------------- | ------------------------------------------------------- |
| `laddu setup [--name <bot>]`      | Set up a bot, or run again to fix or change one         |
| `laddu configure`                 | Model, access, Microsoft, CodeCommit, private notes     |
| `laddu doctor`                    | Check settings, service, Docker and Slack               |
| `laddu update`                    | Update the CLI and bot, push Slack app changes, restart |
| `laddu list`                      | Bots on this machine                                    |
| `laddu logs [-f]`                 | A bot's log                                             |
| `laddu start/stop/restart/status` | Control a bot's service                                 |
| `laddu uninstall [--yes]`         | Remove a bot, its Slack app and (if asked) its data     |

Several bots can share a machine, even a Slack workspace: give each its own `--name`.
