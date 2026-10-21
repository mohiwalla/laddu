/**
 * Each instance runs as `slack-dot@<name>`, from one systemd template unit: system-wide when
 * installed as root, else this user's (with lingering, so it survives logout).
 */
import { botRoot, bun, home, isRoot } from "./paths"

const systemctl = isRoot ? ["systemctl"] : ["systemctl", "--user"]
const journal = isRoot ? ["journalctl"] : ["journalctl", "--user"]

export const unitName = (name: string) => `slack-dot@${name}.service`

const unitPath = isRoot
	? "/etc/systemd/system/slack-dot@.service"
	: `${Bun.env.HOME}/.config/systemd/user/slack-dot@.service`

/** The template unit; %i is the instance's name. */
export function unitText(): string {
	const bunDir = bun.slice(0, bun.lastIndexOf("/"))
	return `# Written by slack-dot; \`slack-dot update\` rewrites it.
[Unit]
Description=slack-dot bot (%i)
After=network-online.target${isRoot ? " docker.service" : ""}
Wants=network-online.target

[Service]
WorkingDirectory=${home}/%i
Environment=PATH=${bunDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${bun} --env-file=${home}/%i/.env run ${botRoot}/src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=${isRoot ? "multi-user.target" : "default.target"}
`
}

/** Writes the unit when it changed; true if systemd had to reload. */
export async function installUnit(): Promise<boolean> {
	const file = Bun.file(unitPath)
	const text = unitText()
	if ((await file.exists()) && (await file.text()) === text) return false
	await Bun.write(unitPath, text)
	await Bun.$`${systemctl} daemon-reload`.quiet()
	return true
}

export async function removeUnitIfUnused(remaining: string[]) {
	if (remaining.length) return
	await Bun.file(unitPath)
		.delete()
		.catch(() => {})
	await Bun.$`${systemctl} daemon-reload`.quiet().nothrow()
}

export const control = (
	action: "enable --now" | "start" | "stop" | "restart" | "disable --now",
	name: string,
) =>
	Bun.$`${systemctl} ${action.split(" ")} ${unitName(name)}`.quiet().nothrow()

export async function state(name: string): Promise<string> {
	return (
		await Bun.$`${systemctl} is-active ${unitName(name)}`
			.quiet()
			.nothrow()
			.text()
	).trim()
}

/** Follows the instance's log in the terminal (`slack-dot logs`). */
export async function followLogs(name: string, follow: boolean, lines = 100) {
	const args = [
		...journal,
		"-u",
		unitName(name),
		"-n",
		String(lines),
		"--no-pager",
		...(follow ? ["-f"] : []),
	]
	await Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] }).exited
}

/**
 * Waits for the bot to say it's connected ("Listening as …"), showing its log meanwhile. The first
 * start builds the runtime image, which takes a few minutes.
 */
export async function waitUntilListening(
	name: string,
	since: Date,
	timeoutMs = 15 * 60_000,
): Promise<{ ok: true; line: string } | { ok: false; reason: string }> {
	const stamp = since.toISOString().replace("T", " ").slice(0, 19)
	const proc = Bun.spawn(
		[
			...journal,
			"-u",
			unitName(name),
			"--since",
			`${stamp} UTC`,
			"-f",
			"-o",
			"cat",
			"--no-pager",
		],
		{ stdout: "pipe", stderr: "ignore" },
	)
	const timer = setTimeout(() => proc.kill(), timeoutMs)
	// A crash loop never prints the line; systemd's own state says so sooner.
	const watch = setInterval(async () => {
		if ((await state(name)) === "failed") proc.kill()
	}, 5000)
	let crashes = 0
	try {
		let buffer = ""
		for await (const chunk of proc.stdout.pipeThrough(
			new TextDecoderStream(),
		)) {
			buffer += chunk
			let end
			while ((end = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 1)
				if (line.startsWith("Listening as ")) return { ok: true, line }
				console.log(`    ${line}`)
				// systemd restarts a crashing bot forever; twice is enough to know.
				if (line.includes(": Failed with result") && ++crashes === 2)
					return {
						ok: false,
						reason: "it keeps crashing (log above)",
					}
			}
		}
		return {
			ok: false,
			reason:
				(await state(name)) === "failed"
					? "the service keeps failing"
					: "it didn't connect in time",
		}
	} finally {
		clearTimeout(timer)
		clearInterval(watch)
		proc.kill()
	}
}

/** Lingering keeps user services running with nobody logged in; false if it couldn't be set. */
export async function ensureLinger(): Promise<boolean> {
	if (isRoot) return true
	const user = Bun.env.USER ?? (await Bun.$`id -un`.text()).trim()
	const current =
		await Bun.$`loginctl show-user ${user} --property=Linger --value`
			.quiet()
			.nothrow()
			.text()
	if (current.trim() === "yes") return true
	return (
		(await Bun.$`loginctl enable-linger ${user}`.quiet().nothrow())
			.exitCode === 0
	)
}
