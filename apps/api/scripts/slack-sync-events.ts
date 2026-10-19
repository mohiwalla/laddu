/** Sync events and optionally agent view, preserving remote OAuth URLs and deployment settings. */
const enableAgent = Bun.argv.includes("--agent-view")
const args = Bun.argv.slice(2).filter(arg => arg !== "--agent-view")
if (!args.includes("--app") || !args.includes("--team"))
	throw new Error(
		"Usage: bun run scripts/slack-sync-events.ts --app <app ID> --team <workspace> [--agent-view]",
	)
const appRoot = Bun.fileURLToPath(new URL("../", import.meta.url))
async function cli(command: string[], cwd = appRoot) {
	const child = Bun.spawn(
		["slack-cli", ...command, ...args, "--skip-update", "--no-color"],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	)
	const [out, err, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	if (exit) throw new Error(err || out || `Slack CLI exited ${exit}`)
	return out
}
const exported = await cli(["manifest", "info", "--source", "remote"])
const remote = JSON.parse(
	exported.slice(exported.indexOf("{"), exported.lastIndexOf("}") + 1),
)
const local = Bun.YAML.parse(
	await Bun.file(`${appRoot}slack-manifest.yaml`).text(),
) as {
	features: { agent_view: { agent_description: string } }
	settings: { event_subscriptions: { bot_events: string[] } }
}
const previous: string[] =
	remote.settings?.event_subscriptions?.bot_events ?? []
const events = [
	...new Set([...previous, ...local.settings.event_subscriptions.bot_events]),
	// A Stop subscription makes Slack's working indicator clickable. Keep it hidden for everyone.
].filter(event => event !== "agent_session_stopped")
const agentChanged = enableAgent && !remote.features?.agent_view
const eventsChanged =
	events.length !== previous.length ||
	events.some(event => !previous.includes(event))
if (!eventsChanged && !agentChanged) {
	console.log("Slack event subscriptions already match.")
} else {
	remote.settings.event_subscriptions.bot_events = events
	if (enableAgent) {
		remote.features ??= {}
		remote.features.agent_view ??= local.features.agent_view
		delete remote.features.assistant_view
	}
	const temporary = (await Bun.$`mktemp -d`.text()).trim()
	try {
		await Bun.write(`${temporary}/manifest.json`, JSON.stringify(remote), {
			createPath: true,
		})
		await Bun.write(
			`${temporary}/manifest.ts`,
			'console.log(await Bun.file(new URL("./manifest.json", import.meta.url)).text())\n',
		)
		await Bun.write(
			`${temporary}/hooks.ts`,
			'console.log(JSON.stringify({ hooks: { "get-manifest": "bun run manifest.ts" }, runtime: "bun" }))\n',
		)
		await Bun.write(
			`${temporary}/.slack/hooks.json`,
			JSON.stringify({ hooks: { "get-hooks": "bun run hooks.ts" } }),
			{ createPath: true },
		)
		for (const name of ["apps.json", "config.json"])
			await Bun.write(
				`${temporary}/.slack/${name}`,
				Bun.file(`${appRoot}.slack/${name}`),
			)
		console.log(
			await cli(
				["manifest", "sync", "--manifest-source", "local"],
				temporary,
			),
		)
		console.log(
			`Added Slack events: ${events.filter(event => !previous.includes(event)).join(", ")}.`,
		)
		const removed = previous.filter(event => !events.includes(event))
		if (removed.length)
			console.log(`Removed Slack events: ${removed.join(", ")}.`)
		if (enableAgent) console.log("Slack agent view enabled.")
	} finally {
		await Bun.$`rm -rf ${temporary}`.quiet()
	}
}
