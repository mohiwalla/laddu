#!/bin/sh
# laddu installer: everything from a blank Linux server to a bot answering in Slack.
#
#   curl -fsSL https://<install-host>/install.sh | sh
#   curl -fsSL https://<install-host>/install.sh | sh -s -- --name support
#
# Installs what's missing (Docker, Bun), installs the laddu CLI, then runs `laddu setup`
# with any arguments given. As root, the bot runs as a system service; as anyone else, as that
# user's service. Safe to run again: it repairs or resumes an install.
#
# LADDU_VERSION picks a version (default: latest).

set -eu

# Everything is in functions, called on the last line, so a cut-off download runs nothing.

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() {
	printf '  \033[31m✗\033[0m %s\n' "$*" >&2
	exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

as_root() {
	if [ "$(id -u)" = 0 ]; then
		"$@"
	elif has sudo; then
		sudo "$@"
	else
		die "Needs root for: $* (no sudo here). Run this as root instead."
	fi
}

packages() {
	if has apt-get; then
		as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
		as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
	elif has dnf; then
		as_root dnf install -y -q "$@"
	elif has yum; then
		as_root yum install -y -q "$@"
	elif has pacman; then
		as_root pacman -Sy --noconfirm --needed "$@" >/dev/null
	elif has zypper; then
		as_root zypper --non-interactive install "$@" >/dev/null
	else
		die "Unknown package manager; install $* yourself and run this again."
	fi
}

check_system() {
	[ "$(uname -s)" = Linux ] || die "laddu runs on Linux servers (this is $(uname -s))."
	has systemctl || die "laddu needs systemd to run the bot as a service."
	case "$(uname -m)" in
	x86_64 | amd64 | aarch64 | arm64) ;;
	*) die "Unsupported CPU: $(uname -m) (needs x86_64 or arm64)." ;;
	esac
}

install_basics() {
	missing=""
	for tool in curl unzip; do has "$tool" || missing="$missing $tool"; done
	if [ -n "$missing" ]; then
		say "Installing$missing"
		# shellcheck disable=SC2086
		packages $missing ca-certificates
	fi
}

install_docker() {
	if ! has docker; then
		say "Installing Docker"
		if has pacman; then
			packages docker
		else
			curl -fsSL https://get.docker.com | as_root sh >/dev/null
		fi
	fi
	as_root systemctl enable --now docker >/dev/null 2>&1 || true
	ok "Docker $(docker --version | sed 's/Docker version \([^,]*\).*/\1/')"

	# The bot starts a container per person, so its user needs Docker access.
	if [ "$(id -u)" != 0 ] && ! id -nG | tr ' ' '\n' | grep -qx docker; then
		as_root usermod -aG docker "$(id -un)"
		ok "Added $(id -un) to the docker group"
		ADDED_TO_DOCKER=1
		# This user's systemd manager started without the group; restart it so the bot's service
		# gets it (lingering keeps it running afterwards).
		if as_root systemctl is-active --quiet "user@$(id -u).service"; then
			as_root systemctl restart "user@$(id -u).service" || true
		fi
	fi
}

install_bun() {
	BUN="$(command -v bun || true)"
	[ -n "$BUN" ] || [ ! -x "$HOME/.bun/bin/bun" ] || BUN="$HOME/.bun/bin/bun"
	if [ -z "$BUN" ]; then
		say "Installing Bun"
		curl -fsSL https://bun.sh/install | bash >/dev/null
		BUN="$HOME/.bun/bin/bun"
	fi
	[ -x "$BUN" ] || die "Bun didn't install."
	BUN_BIN="$(dirname "$BUN")"
	PATH="$BUN_BIN:$PATH"
	export PATH
	ok "Bun $("$BUN" --version)"
}

enable_linger() {
	# A user's services stop at logout unless lingering is on.
	[ "$(id -u)" = 0 ] && return
	if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != yes ]; then
		as_root loginctl enable-linger "$(id -un)"
	fi
	ok "Bot keeps running after you log out"
	# A plain `su` session has no user bus; systemctl --user needs it.
	if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
		XDG_RUNTIME_DIR="/run/user/$(id -u)"
		export XDG_RUNTIME_DIR
	fi
}

install_cli() {
	say "Installing laddu"
	"$BUN" add -g "create-laddu@${LADDU_VERSION:-latest}" >/dev/null
	CLI="$("$BUN" pm bin -g)/laddu"
	[ -x "$CLI" ] || die "laddu didn't install."
	ok "laddu $("$CLI" version)"
}

run_setup() {
	# With `curl | sh`, stdin is this script; setup asks questions, so it reads the terminal.
	[ -r /dev/tty ] || die "No terminal to ask questions on. Run \`$CLI setup\` from an interactive shell."
	if [ -n "${ADDED_TO_DOCKER:-}" ]; then
		# The new group applies from the next login; run setup with it already.
		exec sg docker -c "$(printf '%s ' "'$CLI'" setup "$@")" </dev/tty
	fi
	exec "$CLI" setup "$@" </dev/tty
}

main() {
	check_system
	install_basics
	install_docker
	install_bun
	enable_linger
	install_cli
	run_setup "$@"
}

main "$@"
