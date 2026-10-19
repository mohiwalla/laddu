# VISION

## 14th October 2026

A Slack app you can tag anywhere in a workspace, in a DM or a channel, to help with day-to-day work.
For example: "@bot, list all issues reported on TestFlight by a teammate last week" or "@bot, what's
the rough progress on the new search feature, and what's left?"

It should fetch data through a backend that has the integrations the query needs hooked in: email,
calendars, repositories, issue trackers and so on.

The bot talks to that backend, which can spin up Codex threads for real work. For example, "@bot,
finish the remaining parts of the search feature". The bot can't do that by itself, so every request
goes to Codex, which sits behind the bot, listening to the messages it's given and doing the work.
Claude Code is out of scope for now.

Codex is the brain. It runs on a ChatGPT plan through Sign in with ChatGPT, the way agent harnesses
such as Pi or OpenCode let you sign in with ChatGPT instead of using an API key.

## 15th October 2026

The bot exists now. It's called **dot** (`@dot`), and V0 is live in a team workspace. Details live
in `docs/ARCHITECTURE.md` and `docs/SETUP.md`; this is the why and the where-next.

### Decisions so far

- **Codex is the brain, for every request.** The bot never does work itself: each tag becomes a
  Codex turn (via the Codex SDK), and the bot only moves messages between Slack and Codex. Claude
  Code stays out of scope.
- **Billed to the owner's ChatGPT plan via Sign in with ChatGPT.** It did launch (DevDay, 29 Sep
  2026). dot registers as its own client and uses the "plan usage" grant; no API key, no reusing
  the Codex CLI login.
- **Integrations live in the backend, not in Slack.** Email, repos, TestFlight and so on will be
  tools Codex can call (MCP servers), so the bot stays one Slack app and works on Slack's free plan.
- **Stack: Bun + TypeScript, Bun APIs only, Turborepo monorepo.** The backend is `apps/api`; room
  for more apps later (integrations, a dashboard, a marketing site).
- **Slack over Socket Mode.** The machine running dot holds an outgoing connection to Slack; nothing
  is exposed or tunnelled. The app asks for every scope a non-Enterprise workspace allows, so
  features never wait on reinstalls.
- **Context comes from the conversation.** dot reads the thread, or the channel messages before
  the tag, and can tag people properly.
- **Owner first, then the whole team, each in their own computer.** A new install answers only its
  owner; `ALLOWED_SLACK_USERS` opens it up. Everyone who tags `@dot` gets a private Docker
  container (their own workspace that persists, no access to the host). The ChatGPT token never
  enters a container; a small proxy on the host adds it. Being the owner brings no special
  treatment.
- **Containers get the internet only, the owner's included.** No access to the host's services,
  its local network or each other. No owner exception, since dot is meant to run on a shared
  server for a whole team; `ISOLATE_NETWORK="false"` turns it off.
- **Runs as a service** (systemd on Linux). When the host is off, dot is off.
- **A public, generic repo.** Nothing in it is tied to one person, workspace or machine:
  deployment-specific settings live in git-ignored `.env` files and `AGENTS.local.md`.
- **Borrow from Hermes Agent where it fits.** NousResearch's open-source agent (MIT) runs on Codex
  too, so its ideas port: per-person memory, searchable past conversations, a background pass that
  learns from recent turns, surviving restarts, and sorting errors into ones to retry and ones to
  explain. Its context compression and tool retries don't port; Codex owns those.
- **Memory is per person and small.** What dot knows about someone (who they are, how they like
  answers) lives in two capped files in their own container, loaded into every new conversation.
  dot saves on its own, and a background review every few turns catches what it missed. Nobody
  should have to say "remember this".
- **Progress should feel alive.** Replies use Slack's native streaming: each step is a task card
  named in plain words ("Checking the weather on wttr.in"), the command tucked inside it, with a
  clock counting up while it works. Raw commands never show as the status.
- **One conversation per Slack thread, per person.** A new top-level tag starts fresh; follow-ups
  in a thread continue it; memory and files carry across threads.
- **Skills come in three layers.** Built-in (ship with the repo), team (each deployment's own,
  kept out of git) and personal (dot writes them per person and fixes them when they're wrong).
  Personal skills never reach anyone else on their own; sharing one is a deliberate copy into the
  team skills.
- **Integrations are per person, never shared.** Everyone connects their own account and dot sees
  only what they can. Tokens stay on the host; containers go through the bot. One Microsoft
  sign-in (device code, accepted only when the account matches the person's Slack email) covers
  Azure DevOps and Microsoft 365.
- **Changes happen when asked, no approval step.** dot changes Azure DevOps as the person straight
  away (an approval card was tried and dropped), checking first only when the request is unclear
  or deletes something.
- **Code style:** Prettier with tabs and no semicolons, run with `bun run format`.

### What dot can do today

- Answer questions and fetch live data from the web (`curl`); run code in its own container.
- Read anything people attach (images it sees directly, zips, PDFs, documents) and send files back:
  CSVs, charts, Word, Excel, PDF and slide decks.
- Read Slack threads and messages people link to, including their images, without leaking private
  conversations to people who aren't in them.
- Remember people across conversations, and search its past conversations with them.
- Follow skills (how-to guides): built-in ones, a team's own, and personal ones it writes for each
  person when it works something out, then keeps current.
- Show live progress, explain failures in plain words (a used-up plan says when it resets), retry
  the ones worth retrying, and pick up answers a restart cut off.
- Keep a separate conversation with each person in a shared thread.
- Work with Azure DevOps (Boards, Repos, Pipelines) and Microsoft 365 (Outlook mail and calendar,
  OneDrive, SharePoint, Teams, Planner) as each person, once they've connected with a Microsoft
  sign-in it DMs them: read and act, as them.
- Run scheduled tasks: reminders and recurring work ("every Monday 9am, summarize #sales").
- DM people for someone: as them once they've connected their Slack account, otherwise from dot,
  saying who asked it to send it.
- Implement coding tasks in a Git worktree from a per-person Azure Repos or AWS CodeCommit cache,
  run the repo's checks and open a review PR as the person; follow-up requests can update that PR.
- Be asked by @mention, DM, group DM, `/dot`, the "Ask dot" message shortcut, or reacting with 🤖.
  It reacts instead of replying when a message needs no answer, and adds no status reactions
  except ❌ on failure.

What it won't do: identify people from photos (the model refuses), generate images (the ChatGPT
plan route doesn't offer it), or search the web through a built-in tool (it uses `curl` instead).

### Next

- **A context map:** project names → the repos, trackers and docs that describe them.

### Later

Low priority for now (decided 15 Oct):

- **Per-person usage limits** on the ChatGPT plan.
- **Acting in Slack:** search Slack, react, create canvases, lists and reminders, with guardrails.
  (Messaging people is done.)

Not planned (decided 16 Oct):

- **GitHub and Google Workspace:** the organization doesn't use them.
- **An App Store Connect/TestFlight integration:** TestFlight is checked once or twice a week, so
  dot's computer use covers it ("issues reported on TestFlight last week").

Further out:

- **dot's own computer with a browser and computer use**, like OpenAI's dots, for things no API
  exposes (TestFlight's UI, for example). The per-user containers are the first step.
- **A dashboard** to watch what dot is doing on its computer.
- **Always on:** host it on a server (a VPS) for the whole team instead of a personal machine.
- **Guardrails:** an audit log of changes.
- **Per-user billing** (each person signs in with their own ChatGPT) and teammates running their
  own dot.

### Open questions

- Everyone's usage bills the owner's ChatGPT plan. dot explains a used-up plan and backs off, but
  there are no per-person limits yet, and OpenAI's terms on serving others from a personal plan
  need checking before this spreads.
- Sign in with ChatGPT plan usage is meant for local, personal projects; hosting dot remotely may
  need OpenAI's approval.
- Once private integrations exist, anyone who can tag dot could reach them. They'll need scoping
  per user.
- Other people's messages, linked threads and anything dot fetches are untrusted input (prompt
  injection). Memory refuses entries that look like injection and the containers limit the damage,
  but the rules matter more once dot can act on someone's accounts.
