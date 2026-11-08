#!/bin/sh
# Runs Claude Code (`claude`, Anthropic's own build) with this script's arguments inside the
# requesting user's container ($LADDU_CONTAINER), with this turn's caller, bot API address and time
# zone: headless turns, `auth` and model lists (claude.ts). Like scripts/codex-docker.sh: the persona
# (AGENTS.md plus AGENTS.local.md) becomes Claude Code's user CLAUDE.md, laddu's commands go on
# PATH, and built-in, team and personal skills ($CODEX_HOME/skills, which win on a name clash) are
# linked one by one into ~/.claude/skills. Their keys (~/.laddu/keys) are in the environment (an
# ANTHROPIC_API_KEY among them, if they'd rather pay per use than sign in), and their own MCP servers
# are in ~/.laddu/claude-mcp.json (from `connections`, keys as ${NAME}). Links Claude Code opens open
# full screen in Chromium on their laddu computer ($LADDU_BROWSER instead, if set: claude.ts signs in
# with "true", so no browser opens and Claude Code prints its link). Claude Code's own memory is off;
# laddu has its own. The process is named claude[turn=$LADDU_TURN] so a cancelled turn can end exactly
# this run.
exec docker exec -i -e LADDU_CALLER -e LADDU_API -e LADDU_TIMEZONE -e LADDU_TURN -e LADDU_BROWSER "$LADDU_CONTAINER" bash -c '
  config="$HOME/.claude" &&
  mkdir -p "$config/skills" "$CODEX_HOME/skills" "$HOME/.laddu" &&
  { cat /opt/laddu/persona/AGENTS.md
    notes=/opt/laddu/persona-local; [ -d "$notes" ] || notes=/opt/laddu/persona
    if [ -f "$notes/AGENTS.local.md" ]; then printf "\n\n"; cat "$notes/AGENTS.local.md"; fi
  } > "$config/CLAUDE.md" &&
  mkdir -p "$HOME/.local/bin" && ln -sfn /opt/laddu/runtime/bin/* "$HOME/.local/bin/" &&
  export PATH="$HOME/.local/bin:$PATH" &&
  find "$config/skills" -mindepth 1 -maxdepth 1 -type l -delete &&
  for source in /opt/laddu/persona/skills "$notes/skills.local" "$CODEX_HOME/skills"; do
    for skill in "$source"/*/; do
      if [ -f "$skill/SKILL.md" ]; then ln -sfn "${skill%/}" "$config/skills/$(basename "$skill")"; fi
    done
  done &&
  for key in "$HOME"/.laddu/keys/*; do
    case "${key##*/}" in [A-Z]*) case "${key##*/}" in *[!A-Z0-9_]*) ;; *) export "${key##*/}=$(cat "$key")" ;; esac ;; esac
  done &&
  { [ -f "$HOME/.laddu/claude-mcp.json" ] || connections sync; } &&
  printf "#!/bin/sh\nsetsid desktop exec chromium --app=\"\$1\" >/dev/null 2>&1 &\n(sleep 3; desktop exec wmctrl -r Claude -b add,fullscreen) >/dev/null 2>&1 &\n" > "$HOME/.laddu/browser" &&
  chmod +x "$HOME/.laddu/browser" &&
  cd "$HOME/workspace" &&
  BROWSER="${LADDU_BROWSER:-$HOME/.laddu/browser}" CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 DISABLE_AUTOUPDATER=1 \
    exec -a "claude[turn=$LADDU_TURN]" claude "$@"' claude "$@"
