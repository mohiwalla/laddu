# Contributing to laddu

Thanks for helping. laddu is MIT licensed and free forever. Contributions land under the same
license.

## How changes land

1. **Start from an issue.** Every feature or fix belongs to a GitHub issue on
   [mohiwalla/laddu](https://github.com/mohiwalla/laddu/issues). Search the open issues first. If
   none covers your change, open one.
2. **Work on a short-lived branch.** Keep it to one issue.
3. **Open a pull request** that says `Fixes #N` (it closes the issue) or `Part of #N` (it does part
   of it). Fill in the template: the problem, the change, its scope, and how you verified it.
4. **CI must pass.** It runs the typecheck and every app's tests on each push and PR.
5. **Merge**, then delete the branch.

Commit messages say what changed for the person using laddu, in plain words. No AI attribution
or `Co-Authored-By` trailers.

## Repository layout

A Turborepo monorepo on Bun workspaces:

- `apps/api`: the bot. Slack, the agents, containers and integrations.
- `apps/cli`: the `laddu` installer and admin CLI, published to npm as `create-laddu` with the bot
  inside. `install.sh` is its one-command bootstrap.
- `apps/web`: laddu.wtf, a static site. It also serves `install.sh`.
- `packages/typescript-config`: the shared tsconfig.

How the bot works, file by file: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How the installer
works: [docs/INSTALLER.md](docs/INSTALLER.md).

## Running it locally

You need Bun 1.4 or newer, Docker (your user in the `docker` group) and a Slack workspace where you
can create apps.

```sh
bun install                            # from the repo root
cp apps/api/.env.example apps/api/.env # then fill it in
cd apps/api && bun run dev             # starts the bot, reloading on changes
```

[docs/SETUP.md](docs/SETUP.md) walks through creating the Slack app and every optional setting.
The first start builds the `laddu-runtime` Docker image, which takes a few minutes.

For the site: `cd apps/web && bun run dev`.

## Tests and checks

```sh
bun run typecheck   # every app
bun run test        # every app's tests
```

Run tests with `bun run test`, from the root or inside an app. Don't run `bun test` from the root:
apps/api's test preload (`apps/api/test-setup.ts`) gives tests their own data directory, and the
root run skips it, so tests could write into a running bot's data.

## Formatting

Prettier: tabs, no semicolons, double quotes. Markdown and YAML use two spaces.

```sh
bun run format        # rewrite files
bun run format:check  # check without changing anything
```

## Code style

- **Bun only.** Use Bun APIs (`Bun.file`, `Bun.write`, `Bun.serve`, `Bun.spawn`, `Bun.env`,
  `Bun.$`) and web standards. Don't import `node:*` modules or use Node globals like `process` or
  `Buffer` when Bun or the web platform covers it.
- **Env files.** Always quote values: `ABC="xyz"`.
- **Generic repo.** Nothing is tied to one person, workspace or machine. Deployment settings live
  in git-ignored files: `.env`, `AGENTS.local.md`, `skills.local/`.
- **Plain words.** Anything a person sees in Slack says what happened in plain language. No raw
  commands or API names.
- **Docs follow the code.** If a change makes [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) or
  [docs/SETUP.md](docs/SETUP.md) wrong, fix them in the same PR.

Agents working in this repo also follow [AGENTS.md](AGENTS.md).
