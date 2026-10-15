#!/bin/sh
# Stand-in for the `codex` binary, handed to the Codex SDK as codexPathOverride.
# Runs the real codex inside the requesting user's container ($DOT_CONTAINER), forwarding
# only the model proxy key (never the ChatGPT token). Prompt on stdin, JSON events on stdout.
# Persona and config come from read-only directory mounts, linked into CODEX_HOME each run.
exec docker exec -i -e DOT_PROXY_KEY "$DOT_CONTAINER" sh -c '
  ln -sfn /opt/dot/persona/AGENTS.md "$CODEX_HOME/AGENTS.md" &&
  ln -sfn /opt/dot/runtime/config.toml "$CODEX_HOME/config.toml" &&
  exec codex "$@"' codex "$@"
