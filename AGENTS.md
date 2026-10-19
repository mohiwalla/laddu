# AGENTS.md

- Bun-only: use Bun APIs (`Bun.file`, `Bun.write`, `Bun.serve`, `Bun.spawn`, `Bun.env`, `Bun.$`, ...) and web standards; never import `node:*` modules or use Node globals (`process`, `Buffer`) when Bun or the web platform covers it.
- Env files: always quote values, `ABC="xyz"`.
- Turborepo monorepo (Bun workspaces): deployables in `apps/*`, shared code in `packages/*`. Architecture docs live in `docs/`.
- Commits: no `Co-Authored-By` trailers or other AI attribution in commit messages.
- After every fix, restart the running bot service automatically and verify it starts successfully. This deployment uses `systemctl --user restart dot-srafis.service`.
