#!/bin/sh
# Stand-in for the `codex` binary (run as `codex-docker.sh app-server …` for each turn).
# Runs the real codex inside the requesting user's container ($DOT_CONTAINER), forwarding the
# model proxy key (never the ChatGPT token) and this turn's caller, bot API address and time zone. JSON-RPC on stdin and stdout.
# Persona (AGENTS.md, plus the git-ignored AGENTS.local.md if present; from /opt/dot/persona-local
# when the deployment keeps it outside the persona folder) is written into CODEX_HOME
# each run; config comes from a read-only directory mount, linked in, and
# its commands (memory, recall, schedule) into ~/.local/bin, which is on PATH in Codex's login
# shells. Built-in and team skills (agent-home/skills, skills.local) are linked into
# ~/.agents/skills, a Codex skill root; personal skills live in $CODEX_HOME/skills. The process is named codex[turn=$DOT_TURN] so a cancelled turn can end exactly this run.
exec docker exec -i -e DOT_PROXY_KEY -e DOT_CALLER -e DOT_API -e DOT_TIMEZONE -e DOT_TURN "$DOT_CONTAINER" bash -c '
  rm -f "$CODEX_HOME/AGENTS.md" &&
  { cat /opt/dot/persona/AGENTS.md
    notes=/opt/dot/persona-local; [ -d "$notes" ] || notes=/opt/dot/persona
    if [ -f "$notes/AGENTS.local.md" ]; then printf "\n\n"; cat "$notes/AGENTS.local.md"; fi
  } > "$CODEX_HOME/AGENTS.md" &&
  ln -sfn /opt/dot/runtime/config.toml "$CODEX_HOME/config.toml" &&
  mkdir -p "$HOME/.local/bin" && ln -sfn /opt/dot/runtime/bin/* "$HOME/.local/bin/" &&
  mkdir -p "$HOME/.agents/skills" &&
  for pair in dot:/opt/dot/persona/skills team:$notes/skills.local; do
    link="$HOME/.agents/skills/${pair%%:*}" source="${pair#*:}"
    if [ -d "$source" ]; then ln -sfn "$source" "$link"; else rm -f "$link"; fi
  done &&
  exec -a "codex[turn=$DOT_TURN]" codex "$@"' codex "$@"
