# AGENTS.md

- Bun-only: use Bun APIs (`Bun.file`, `Bun.write`, `Bun.serve`, `Bun.spawn`, `Bun.env`, `Bun.$`, ...) and web standards; never import `node:*` modules or use Node globals (`process`, `Buffer`) when Bun or the web platform covers it.
- Env files: always quote values, `ABC="xyz"`.
- Turborepo monorepo (Bun workspaces): deployables in `apps/*`, shared code in `packages/*`. Architecture docs live in `docs/`; contributor guide in `CONTRIBUTING.md`.
- Issues first: every feature or fix belongs to a GitHub issue on `mohiwalla/laddu`. Search open issues first (`gh issue list --search`); if one covers the work, reference it and ask once whether to also do the rest it lists. If none does, create one (ask once first, unless the person asked for the work).
- Land work on a short-lived branch through a PR that says `Fixes #N` or `Part of #N`; merge once CI passes. Never commit straight to main.
- Commits: no `Co-Authored-By` trailers or other AI attribution in commit messages.
- After every merged fix, pull main where the bot runs, restart the running bot service and verify it starts successfully. This deployment uses `systemctl --user restart laddu@dot.service` (the Sifars bot; srafis is retired).
