# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: the admin who installs laddu.** A developer or IT person on a team that already lives in Slack. They decide whether to run `curl -fsSL https://laddu.wtf/install.sh | sh` on a Linux server, and they answer to their team for what it can reach. The page speaks to them first.
- **Secondary: the teammate who tags @laddu.** Often arrives from a colleague's link after laddu is already installed. Needs only to learn "tag @laddu in a channel, thread or DM".

## Product Purpose

laddu is a personal AI assistant that lives in Slack. You tag it in a channel, thread or DM. It reads the conversation, does the work on its own computer, and answers in the thread. Success for the site: an admin understands within one screen what laddu is, that it runs on their own server, and how to install it, and trusts it enough to run the command.

## Positioning

- Self-hosted: it runs on the admin's own Linux server, not a vendor cloud.
- Every person who tags it gets their own private computer (a container with a desktop, a browser, files that persist, internet only). laddu clicks and types through things no API reaches, and the person can watch, take over and hand back from laddu's Home tab in Slack.
- It works *as* the person in Azure DevOps and Microsoft 365, seeing only what they can, and ships code as pull requests on Azure Repos or AWS CodeCommit.
- Brains are each person's pick: Codex on the owner's ChatGPT plan, or OpenCode's free models.

## Operating Context

- Lives entirely inside Slack: mentions, threads, DMs, the Home tab. Progress shows as plain-language steps while it works ("laddu is working"), then the answer.
- Install: one command on a Linux server with systemd; the installer adds Docker and Bun if missing, makes the Slack app, signs in to ChatGPT, asks a few questions, starts as a service and DMs the installer. At first it answers only the installer. `bun create laddu` is the alternative when Bun and Docker exist.
- Remembers each person (who they are, how they like answers), can search past conversations, writes itself how-tos, runs reminders and recurring tasks, can DM people for you, hands back real files (CSV, charts, Word, spreadsheets, PDF, slides).

## Capabilities and Constraints

- The ChatGPT sign-in never enters the containers; a proxy on the host adds it.
- Containers have internet only: no way into the host's servers, network, or anyone else's computer.
- **Not yet decided / not claimable:** the repository has no license, so the site must not say "open source". No pricing statement beyond what is true (Codex uses the owner's ChatGPT plan; OpenCode models are free). No user counts, stars, customers or testimonials exist to cite.

## Brand Commitments

- Name is **laddu** (lowercase), Punjabi ਲੱਡੂ. Formerly "dot"; "dot" must never appear on the site. Domain laddu.wtf.
- Mascot world: laddu (an orange boondi laddoo with sparkly eyes and a black bow tie) plus the mithai gang (Jalebi ਜਲੇਬੀ, Kaju Katli ਕਾਜੂ ਕਤਲੀ, Gulab Jamun ਗੁਲਾਬ ਜਾਮਣ, Rasgulla ਰਸਗੁੱਲਾ), each in a bow tie. The owner likes this theme and its warm pink / saffron / pistachio palette and wants it kept.
- The mithai are not separate helpers and have no roles: they are names and looks the same bot can be given (laddu is the default; the name and picture are customizable, per the owner). The site must never imply a mithai does a particular job; capabilities are always shown as laddu's.
- Voice: warm, playful, plain words; never at the cost of being clear about what it is and what it can reach.
- Source link: https://github.com/mohiwalla/laddu (confirmed by the owner).

## Evidence on Hand

- Mascot cutouts: `public/mascots/` (sources in `brand-source/`).
- A real screen recording (`/Screencast_20261102_144518.webm` at the repo root, not for publishing: it shows the old name and private workspace data). The real exchange it shows, approved for recreation on the site with the name changed to laddu and the reply kept verbatim:
  - You: "hii laddu, what can you do for me?"
  - Status: "laddu is working" with a spinner.
  - laddu (AGENT): "I can help you with:" **Neon Rift:** build features, fix bugs, review code, and get changes ready to test. **Arch Linux:** troubleshoot problems, configure settings, and write scripts. **Research:** find current information and explain tricky topics. **Files:** analyse data and create spreadsheets, charts, documents, or slides. **Writing:** draft messages, polish résumés, and summarise documents. **Reminders:** remind you later or set up recurring tasks. "Send me a task, a file, or something that's broken 🙂"
  - The personalised lines (Neon Rift, Arch Linux) come from laddu's memory of the person, which is the point of showing them.
  - On the site (owner's decision, 2026-11-02): the personal names are replaced with generic ones a first-time visitor understands ("Your code", "Your laptop"), the question shows the mention ("hi @laddu, …"), and the caption says the reply is *based on* a real one rather than verbatim.
- Absent, must not be fabricated: testimonials, logos, metrics, star counts, license, pricing tiers.

## Product Principles

1. Say what it is before being cute: self-hosted AI teammate in Slack, with its own computer, on your server.
2. Show real behaviour, never invented demos; recreations must match what laddu actually does.
3. Earn the admin's trust in the open: what it can reach, where credentials live, what the install script does.
4. The mithai are the brand's warmth, and each one should carry meaning, not decoration.
