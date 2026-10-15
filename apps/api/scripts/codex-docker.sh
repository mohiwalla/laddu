#!/bin/sh
# Stand-in for the `codex` binary, handed to the Codex SDK as codexPathOverride.
# Runs the real codex inside the requesting user's container ($DOT_CONTAINER), forwarding the
# model proxy key (never the ChatGPT token) and this turn's caller, bot API address and time zone. Prompt on stdin, JSON events on stdout.
# Persona and config come from read-only directory mounts, linked into CODEX_HOME each run, and
# its commands (memory, recall, schedule) into ~/.local/bin, which is on PATH in Codex's login
# shells. The process is named codex[turn=$DOT_TURN] so Stop can end exactly this run.
exec docker exec -i -e DOT_PROXY_KEY -e DOT_CALLER -e DOT_API -e DOT_TIMEZONE -e DOT_TURN "$DOT_CONTAINER" bash -c '
  ln -sfn /opt/dot/persona/AGENTS.md "$CODEX_HOME/AGENTS.md" &&
  ln -sfn /opt/dot/runtime/config.toml "$CODEX_HOME/config.toml" &&
  mkdir -p "$HOME/.local/bin" && ln -sfn /opt/dot/runtime/bin/* "$HOME/.local/bin/" &&
  exec -a "codex[turn=$DOT_TURN]" codex "$@"' codex "$@"
