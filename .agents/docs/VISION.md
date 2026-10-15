# VISION

## 14th October 2026

I want to create an slack app/bot which I can tag anywhere in my workspace being it a DM or channel to help me with day to day stuff.
Eg: "@bot, list all issues reported on TestFlight by Troy in last week"/"@bot, What's the rough progress we've made so far in Ask AI feature, what's left?"

And it should be able to fetch the data from my backend, which will have all the plugins and stuff that we need hooked into it, being it Outlook, the external sources like access to my repositories or whatever the query demands.

So the bot will basically be communicating with my backend. I don't know how that's going to work, but that's what I have in my mind. It could spin new Claude code or Codex threads for me. to handle some real-life work. For example, I could say "@bot complete the rest of the features for Ask AI", Of course, bot itself can't do that, so it will have to intelligently use Codex or Claude code. Of course, I don't think there will be even one instance where it will be able to do anything. For every single use case, it will have to spin up Codex, let's say. Let's not consider Claude code in this scope for now. So yeah, I will be able to hook in the Codex and delegate some tasks, which will be sitting at the backend listening to all the messages. I don't know how that's going to work. I don't know the details, but I know how it should function from user's perspective.

And for Codex, basically the AI part, the brain, should be working behind the scenes for bot. We need to implement some sign in with ChatGPT feature. I think they have launched it recently, although I don't know if it is widely available for us to use. And if it is, then we can simply hook up like any other agent harness, being it Pi agent, open code. Like they also give us the option to sign in with Codex or sign in with ChatGPT. So I think with that, we should be good with that.

## 15th October 2026

The bot exists now. It's called **dot** (`@dot`), and V0 is live in the srafis workspace. Details
live in `docs/ARCHITECTURE.md` and `docs/SETUP.md`; this is the why and the where-next.

### Decisions so far

- **Codex is the brain, for every request.** The bot never does work itself: each tag becomes a
  Codex turn (via the Codex SDK), and the bot only moves messages between Slack and Codex. Claude
  Code stays out of scope.
- **Billed to my ChatGPT plan via Sign in with ChatGPT.** It did launch (DevDay, 29 Sep 2026).
  dot registers as its own client and uses the "plan usage" grant; no API key, no reusing the
  Codex CLI login.
- **Integrations live in the backend, not in Slack.** Outlook, repos, TestFlight and so on will be
  tools Codex can call (MCP servers), so the bot stays one Slack app and works on Slack's free plan.
- **Stack: Bun + TypeScript, Bun APIs only, Turborepo monorepo.** The backend is `apps/api`; room
  for more apps later (integrations, a dashboard, a marketing site).
- **Slack over Socket Mode.** My machine holds an outgoing connection to Slack; nothing is exposed
  or tunnelled. The app asks for every scope a non-Enterprise workspace allows, so features never
  wait on reinstalls.
- **Context comes from the conversation.** dot reads the thread, or the channel messages before
  the tag, and can tag people properly.
- **Open to everyone in srafis, each in their own computer.** Started as owner-only; now anyone
  who tags `@dot` gets a private Docker container (their own workspace that persists, no access to
  my machine). My ChatGPT token never enters a container; a small proxy on my machine adds it.
  mohiwalla stays owner-only.
- **Runs on my machine** as a systemd service. When my machine is off, dot is off.

### What dot can do today

Answer questions, fetch live data from the web (`curl`), run code in its container, read files
people attach and send files back, and keep a separate conversation with each person in a shared
thread.

### Next (V1)

- **Integrations:** GitHub/repos, Outlook, App Store Connect/TestFlight, issue tracker, so the
  original examples work ("issues reported on TestFlight by Troy last week", "progress on Ask AI").
- **A context map:** project names ("Ask AI") → the repos, trackers and docs that describe them.
- **Deeper Slack context:** older history and search when the tagged message needs it.
- **Real work:** "complete the rest of Ask AI" runs in an isolated checkout and ends with a PR link
  in the thread.

### Later

- **dot's own computer with a browser and computer use**, like OpenAI's dots, for things no API
  exposes (TestFlight's UI, for example). The per-user containers are the first step.
- **A dashboard** to watch what dot is doing on its computer.
- **Always on:** host it somewhere other than my laptop.
- **Guardrails:** approval before write actions, per-user limits, an audit log.
- **Per-user billing** (each person signs in with their own ChatGPT) and teammates running their
  own dot.

### Open questions

- Everyone's usage bills my ChatGPT plan, and there are no per-user limits yet. OpenAI's terms on
  serving others from a personal plan need checking before this spreads.
- Sign in with ChatGPT plan usage is meant for local, personal projects; hosting dot remotely may
  need OpenAI's approval.
- Once private integrations exist, anyone who can tag dot could reach them. They'll need scoping
  per user.
- Other people's messages, and anything dot fetches, are untrusted input (prompt injection). The
  containers limit the damage, but the rules matter more once dot can act on my accounts.
