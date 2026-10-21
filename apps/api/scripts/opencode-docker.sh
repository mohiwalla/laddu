#!/bin/sh
# Runs OpenCode as an ACP agent (`opencode acp`, JSON-RPC on stdin and stdout) inside the
# requesting user's container ($DOT_CONTAINER), with this turn's caller, bot API address, time
# zone and OpenCode config (OPENCODE_CONFIG_CONTENT). Like scripts/codex-docker.sh: the persona
# (AGENTS.md plus AGENTS.local.md) becomes OpenCode's global instructions, dot's commands go on
# PATH, built-in and team skills are linked into ~/.agents/skills (which OpenCode reads too), and
# personal skills stay in $CODEX_HOME/skills, linked in as OpenCode's own. The process is named
# opencode[turn=$DOT_TURN] so a cancelled turn can end exactly this run.
exec docker exec -i -e DOT_CALLER -e DOT_API -e DOT_TIMEZONE -e DOT_TURN -e OPENCODE_CONFIG_CONTENT "$DOT_CONTAINER" bash -c '
  config="$HOME/.config/opencode" &&
  mkdir -p "$config" "$CODEX_HOME/skills" &&
  { cat /opt/dot/persona/AGENTS.md
    notes=/opt/dot/persona-local; [ -d "$notes" ] || notes=/opt/dot/persona
    if [ -f "$notes/AGENTS.local.md" ]; then printf "\n\n"; cat "$notes/AGENTS.local.md"; fi
  } > "$config/AGENTS.md" &&
  ln -sfn "$CODEX_HOME/skills" "$config/skills" &&
  mkdir -p "$HOME/.local/bin" && ln -sfn /opt/dot/runtime/bin/* "$HOME/.local/bin/" &&
  mkdir -p "$HOME/.agents/skills" &&
  for pair in dot:/opt/dot/persona/skills team:$notes/skills.local; do
    link="$HOME/.agents/skills/${pair%%:*}" source="${pair#*:}"
    if [ -d "$source" ]; then ln -sfn "$source" "$link"; else rm -f "$link"; fi
  done &&
  cd "$HOME/workspace" &&
  PATH="$HOME/.local/bin:$PATH" OPENCODE_ENABLE_EXA=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    exec -a "opencode[turn=$DOT_TURN]" opencode acp'
