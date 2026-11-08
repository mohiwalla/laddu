<p align="center"><img src="apps/web/public/mascots/laddu.webp" width="180" alt="laddu, a smiling boondi laddoo in a bow tie"></p>

# laddu

laddu is an AI teammate that lives in Slack. You tag it in a channel or send it a DM, and it does
the work: answers questions, looks things up, writes files, runs tasks on a schedule and works in
your connected accounts. It lives at [laddu.wtf](https://laddu.wtf).

## What laddu stands for

- **Open source.** The code is MIT licensed. Read it, change it, run it.
- **Free forever.** laddu never charges anyone. There are no plans, credits or paid tiers.
- **Your own AI subscription.** Each person signs in with their own ChatGPT or Claude plan, or
  their own API key, and pays that provider directly. OpenCode's free models need no sign-in.
- **Your own computer.** Everyone gets a private computer (a container) on the server laddu runs
  on. Their files, memory and sign-ins live there. Nobody else in the team can see it.
- **Your accounts stay yours.** Each person connects their own accounts. laddu only sees what that
  person can see, and acts only as the person who asked.

You run laddu on your own server. Whoever runs that server can reach everything on it, so pick a
host your team trusts.

## What it can do

- Read the thread or channel it's tagged in, and the Slack links and files people share.
- Search the web, run code, and send back real files: CSVs, charts, Word, Excel, PDF and slides.
- Remember each person, and search its past conversations with them.
- Use its own desktop with a browser. You can watch it work and take over.
- Run reminders and recurring tasks ("every Monday at 9, summarize #sales").
- DM people for you, as you or from laddu.
- Work with Microsoft 365 (mail, calendar, OneDrive, SharePoint, Teams, Planner) and Azure DevOps.
- Make code changes in Azure Repos or AWS CodeCommit and open a pull request.

It asks first before it does something as you that you didn't ask for, like sending a message or
deleting something.

## Install

You need a Linux server with systemd and a Slack workspace (the free plan works). Run:

```sh
curl -fsSL https://laddu.wtf/install.sh | sh
```

This installs Docker and Bun if they're missing, creates the Slack app, asks a few questions and
starts laddu as a service. laddu DMs you when it's ready. Setup asks who can use it. Run
`laddu configure` to change that later.

- Commands after install: [apps/cli/README.md](apps/cli/README.md)
- Manual setup and optional integrations (Microsoft, coding tasks, desktop links):
  [docs/SETUP.md](docs/SETUP.md)

## Using it in Slack

**Pick your AI.** Open laddu's **Home** tab in Slack and go to **Settings**. Pick Codex (sign in
with ChatGPT or use an OpenAI key), Claude Code (sign in with Claude or use an Anthropic key) or
OpenCode's free models. You can also pick the model, give laddu your own name and picture, and
connect your accounts there. If you ask before signing in, laddu sends you a private link.

**Ask it.** Any of these work:

- Tag `@laddu` in a channel or thread.
- Send it a DM.
- Type `/laddu` and your request.
- Use the **Ask laddu** shortcut on a message.
- React to a message with 🤖.
- Reply in a thread laddu is already part of. No tag needed.

laddu answers in the thread and shows its steps while it works. Each person has their own
conversation with it, even in a shared thread. Press Slack's **Stop** button to stop it. It only
stops your own request.

**Home tab.** Overview shows what laddu is working on and your scheduled tasks. Skills and Memory
show what it has learned about how you work. You can edit or remove any of it. **Open computer**
lets you watch laddu's desktop.

## More

- How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- License: [MIT](LICENSE)
