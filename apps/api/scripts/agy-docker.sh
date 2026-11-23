#!/bin/sh
# Runs Antigravity CLI (`agy`, Google's own build) with this script's arguments inside the
# requesting user's container ($LADDU_CONTAINER), with this turn's caller, bot API address and
# time zone: ACP turns, model lists, sign-in (`agy acp --login`) and logout (agy.ts). Like
# scripts/codex-docker.sh: the persona (AGENTS.md plus AGENTS.local.md) becomes Antigravity's
# global ~/.gemini/AGENTS.md, laddu's commands go on PATH, and built-in, team and personal skills
# ($CODEX_HOME/skills, which win on a name clash) are linked one by one into
# ~/.gemini/config/skills. Their keys (~/.laddu/keys) are in the environment (a GEMINI_API_KEY
# among them, if they'd rather pay per use than sign in), and their own MCP servers are linked
# from ~/.laddu/agy-mcp.json (written by `connections`) into ~/.gemini/config/mcp_config.json.
# The process is named agy[turn=$LADDU_TURN] so a cancelled turn can end exactly this run.
exec docker exec -i -e LADDU_CALLER -e LADDU_API -e LADDU_TIMEZONE -e LADDU_TURN "$LADDU_CONTAINER" bash -c '
  config="$HOME/.gemini" &&
  mkdir -p "$config/config/skills" "$config/antigravity-cli" "$CODEX_HOME/skills" "$HOME/.laddu" &&
  { cat /opt/laddu/persona/AGENTS.md
    notes=/opt/laddu/persona-local; [ -d "$notes" ] || notes=/opt/laddu/persona
    if [ -f "$notes/AGENTS.local.md" ]; then printf "\n\n"; cat "$notes/AGENTS.local.md"; fi
  } > "$config/AGENTS.md" &&
  mkdir -p "$HOME/.local/bin" && ln -sfn /opt/laddu/runtime/bin/* "$HOME/.local/bin/" &&
  export PATH="$HOME/.local/bin:$PATH" &&
  find "$config/config/skills" -mindepth 1 -maxdepth 1 -type l -delete &&
  for source in /opt/laddu/persona/skills "$notes/skills.local" "$CODEX_HOME/skills"; do
    for skill in "$source"/*/; do
      if [ -f "$skill/SKILL.md" ]; then ln -sfn "${skill%/}" "$config/config/skills/$(basename "$skill")"; fi
    done
  done &&
  for key in "$HOME"/.laddu/keys/*; do
    case "${key##*/}" in [A-Z]*) case "${key##*/}" in *[!A-Z0-9_]*) ;; *) export "${key##*/}=$(cat "$key")" ;; esac ;; esac
  done &&
  { [ -f "$HOME/.laddu/agy-mcp.json" ] || connections sync; } &&
  ln -sfn "$HOME/.laddu/agy-mcp.json" "$config/config/mcp_config.json" &&
  cd "$HOME/workspace" &&
  BROWSER=true exec -a "agy[turn=$LADDU_TURN]" agy "$@"' agy "$@"
