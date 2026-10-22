/**
 * `laddu setup`: from a machine with Bun and Docker to a bot answering in Slack. Safe to run
 * again; every step keeps what already works.
 */
import { existingChatGpt, signInWithChatGpt } from "./chatgpt"
import { Instance, type SlackApp } from "./instance"
import { instanceNames, isRoot } from "./paths"
import {
	control,
	ensureLinger,
	installUnit,
	state,
	waitUntilListening,
} from "./service"
import {
	buildManifest,
	checkAppToken,
	checkBotToken,
	commandName,
	createApp,
	createAppUrl,
	installApp,
	needsApproval,
	refreshCliAuth,
	sendDm,
	SlackError,
	ticketLogin,
	updateApp,
	type Manifest,
	type Tokens,
} from "./slack"
import {
	ask,
	bold,
	choose,
	confirm,
	dim,
	done,
	fail,
	say,
	step,
	warn,
} from "./terminal"

/** The ChatGPT consent screen shows this name at the first sign-in. */
const APP_NAME = "laddu"
const MEMBER_ID = /^[UW][A-Z0-9]{2,}$/

export async function setup(name: string): Promise<boolean> {
	const instance = new Instance(name)
	const rerun = await instance.exists()
	say(
		"",
		bold(`Setting up ${name}`) +
			dim(
				` in ${instance.dir}${rerun ? " (again; keeps what works)" : ""}`,
			),
	)

	const docker = await preflight()
	await instance.create()
	const env = await instance.env()
	const saved = await instance.slackApp()

	step("Basics")
	const botName = await ask("The bot's name in Slack", {
		default: saved?.name ?? "laddu",
		check: value =>
			value.length <= 35 && /\S/.test(value)
				? undefined
				: "Up to 35 characters.",
	})
	const runtime = docker
		? await choose(
				"Where does it run what people ask it to?",
				[
					{
						label: "Docker",
						value: "docker" as const,
						hint: "a container per person; safe to share with your team",
					},
					{
						label: "This machine",
						value: "host" as const,
						hint: "Codex's sandbox only; for just yourself",
					},
				],
				env.CODEX_RUNTIME === "host" ? 1 : 0,
			)
		: "host"
	const desktop =
		runtime === "docker" &&
		(await confirm(
			"Give it a computer (a desktop it can drive and people can watch)?",
			env.DESKTOP !== "false",
		))
	say(
		dim(
			"  A public HTTPS address for this machine lets people watch that desktop and lets the bot\n  DM as them. Point it (a reverse proxy or tunnel) at the port below. Leave it blank to skip.",
		),
	)
	const port = env.DESKTOP_VIEWER_PORT ?? String(await freePort())
	const publicUrl =
		(
			await ask(`Public address (proxied to 127.0.0.1:${port})`, {
				default: env.DESKTOP_PUBLIC_URL?.startsWith("https://")
					? env.DESKTOP_PUBLIC_URL
					: undefined,
				check: value =>
					!value || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(value)
						? undefined
						: "An address like https://laddu.example.com",
			})
		).replace(/\/$/, "") || null

	step("Slack")
	const manifest = await buildManifest({ name: botName, publicUrl })
	const slack = await connectSlack(instance, env, saved, manifest)
	const owner = slack.owner
	const access = await choose(
		"Who can use it?",
		[
			{ label: "Just me", value: "me" as const },
			{ label: "Everyone in the workspace", value: "all" as const },
			{ label: "Specific people", value: "some" as const },
		],
		env.ALLOWED_SLACK_USERS === "*"
			? 1
			: env.ALLOWED_SLACK_USERS && env.ALLOWED_SLACK_USERS !== owner
				? 2
				: 0,
	)
	const allowed =
		access === "all"
			? "*"
			: access === "some"
				? await ask("Member IDs, comma-separated (yours is added)", {
						default: env.ALLOWED_SLACK_USERS,
						check: value =>
							value
								.split(",")
								.every(id => MEMBER_ID.test(id.trim()))
								? undefined
								: "Member IDs look like U0123456789 (Slack profile > ⋮ > Copy member ID).",
					}).then(value =>
						[
							...new Set([
								owner,
								...value.split(",").map(id => id.trim()),
							]),
						].join(","),
					)
				: owner

	step("Model")
	const chatgpt = await connectChatGpt(instance)
	const model = chatgpt.models.length
		? await choose(
				"Which model?",
				chatgpt.models.map(model => ({
					label: model.slug,
					value: model.slug,
					hint: model.name,
				})),
				Math.max(
					0,
					chatgpt.models.findIndex(
						model => model.slug === env.CODEX_MODEL,
					),
				),
			)
		: await ask("Model slug (couldn't list your plan's models)", {
				default: env.CODEX_MODEL,
				check: value => (value ? undefined : "A model is required."),
			})

	await instance.setEnv({
		LADDU_INSTANCE: name,
		DATA_DIR: instance.dataDir,
		CODEX_LOCAL_DIR: instance.dir,
		APP_NAME,
		SLACK_BOT_TOKEN: slack.tokens.bot,
		SLACK_APP_TOKEN: slack.tokens.app_level,
		SLACK_USER_TOKEN: slack.tokens.user ?? env.SLACK_USER_TOKEN ?? null,
		// People connect their Slack accounts through the public address, with the app's OAuth client.
		SLACK_CLIENT_ID: (publicUrl && slack.credentials?.client_id) || null,
		SLACK_CLIENT_SECRET:
			(publicUrl && slack.credentials?.client_secret) || null,
		OWNER_SLACK_USER_ID: owner,
		ALLOWED_SLACK_USERS: allowed,
		CODEX_MODEL: model,
		CODEX_RUNTIME: runtime,
		DESKTOP: String(desktop),
		DESKTOP_VIEWER_PORT: port,
		DESKTOP_PUBLIC_URL: publicUrl,
	})
	done(`Settings saved to ${instance.envPath}`)

	step("Service")
	const started = await start(instance)
	if (started)
		await sendDm(
			slack.tokens.bot,
			owner,
			`Hi! I'm ${botName}, up and running on ${(await Bun.$`hostname`.text()).trim()}. DM me, mention me in a channel (invite me first with \`/invite @${botName}\`), or use \`/${commandName(botName)}\`.`,
		).catch(() => {})

	say(
		"",
		started
			? bold(`${botName} is running. It just sent you a DM in Slack.`)
			: bold("Setup is saved, but the bot didn't start."),
		"",
		`  Invite it to channels:   /invite @${botName}`,
		`  Change settings:         laddu configure${name === "laddu" ? "" : ` --name ${name}`}`,
		`  See what it's doing:     laddu logs -f${name === "laddu" ? "" : ` --name ${name}`}`,
		`  Private instructions:    ${instance.dir}/AGENTS.local.md`,
		...(publicUrl
			? [`  Web pages:               ${publicUrl} → 127.0.0.1:${port}`]
			: []),
		"",
	)
	return started
}

/** Checks the machine; returns whether Docker is usable. */
async function preflight(): Promise<boolean> {
	step("This machine")
	done(`Bun ${Bun.version}`)
	if (!(await Bun.$`systemctl --version`.quiet().nothrow()).exitCode)
		done("systemd")
	else
		throw new Error(
			"laddu runs the bot as a systemd service, and this machine has no systemd.",
		)
	if (!isRoot) {
		if (await ensureLinger())
			done("Runs without anyone logged in (lingering)")
		else
			warn(
				`Couldn't enable lingering; the bot stops when you log out. Fix: sudo loginctl enable-linger ${Bun.env.USER}`,
			)
	}
	const info = await Bun.$`docker info --format ${"{{.ServerVersion}}"}`
		.quiet()
		.nothrow()
	if (info.exitCode === 0) {
		done(`Docker ${info.text().trim()}`)
		return true
	}
	const denied = info.stderr.toString().includes("permission denied")
	warn(
		denied
			? "Docker is installed, but you can't use it yet. Log out and back in (you were just added to the docker group), then run setup again."
			: "Docker isn't available, so the bot can only run things on this machine directly (for just yourself).",
	)
	if (denied && !(await confirm("Continue without Docker?", false)))
		throw new Error(
			"Stopped; run `laddu setup` again after logging back in.",
		)
	return false
}

/** A viewer port no other bot here uses, from 6900 up. */
async function freePort(): Promise<number> {
	const taken = new Set<string>()
	for (const other of await instanceNames()) {
		const port = (await new Instance(other).env()).DESKTOP_VIEWER_PORT
		if (port) taken.add(port)
	}
	for (let port = 6900; port < 7000; port++) {
		if (taken.has(String(port))) continue
		try {
			Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: () => new Response(),
			}).stop(true)
			return port
		} catch {}
	}
	throw new Error("No free port between 6900 and 6999.")
}

type SlackSetup = {
	tokens: Tokens
	owner: string
	credentials?: SlackApp["credentials"]
}

/**
 * Creates (or updates) the app and installs it: one `/slackauthticket` in Slack. Falls back to
 * creating and installing it by hand on api.slack.com when Slack won't let us.
 */
async function connectSlack(
	instance: Instance,
	env: Record<string, string>,
	saved: SlackApp | null,
	manifest: Manifest,
): Promise<SlackSetup> {
	// Re-run: keep a working install unless asked otherwise.
	if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN && env.OWNER_SLACK_USER_ID) {
		const bot = await checkBotToken(env.SLACK_BOT_TOKEN).catch(() => null)
		if (
			bot &&
			(await checkAppToken(env.SLACK_APP_TOKEN).then(
				() => true,
				() => false,
			))
		) {
			done(`Connected as @${bot.user} in ${bot.team}`)
			const renamed =
				saved && saved.name !== manifest.display_information.name
			if (!renamed && !(await confirm("Reinstall the Slack app?", false)))
				return {
					tokens: {
						bot: env.SLACK_BOT_TOKEN,
						app_level: env.SLACK_APP_TOKEN,
						user: env.SLACK_USER_TOKEN,
					},
					owner: env.OWNER_SLACK_USER_ID,
					credentials: saved?.credentials,
				}
		}
	}

	let appId = saved?.app_id
	try {
		const cli =
			(saved?.cli && (await refreshCliAuth(saved.cli))) ||
			(await ticketLogin())
		done(`Signed in to ${cli.team_name ?? cli.team_domain ?? cli.team_id}`)
		const sameTeam = saved?.team_id === cli.team_id
		let credentials = sameTeam ? saved?.credentials : undefined
		if (appId && sameTeam) {
			await updateApp(cli.token, appId, manifest)
			done(`Updated the app (${appId})`)
		} else {
			const created = await createApp(cli.token, manifest)
			appId = created.app_id
			credentials = created.credentials
			done(`Created the app (${appId})`)
		}
		const record: SlackApp = {
			app_id: appId,
			team_id: cli.team_id,
			team_domain: cli.team_domain,
			name: manifest.display_information.name,
			credentials,
			cli,
		}
		await instance.saveSlackApp(record)
		const tokens = await installApp(cli.token, appId, manifest)
		done("Installed it to the workspace")
		return { tokens, owner: cli.user_id, credentials }
	} catch (error) {
		// Slack said no; anything else (no terminal, no network) isn't fixed by doing it by hand.
		if (!(error instanceof SlackError)) throw error
		if (needsApproval(error))
			warn(
				`Your workspace needs an admin to approve new apps. Request it at https://api.slack.com/apps/${appId}/install-on-team, then finish here once it's approved.`,
			)
		else
			warn(
				`Couldn't do it automatically (${error.code}). Let's do it by hand.`,
			)
	}
	return connectSlackByHand(instance, saved, manifest, appId)
}

async function connectSlackByHand(
	instance: Instance,
	saved: SlackApp | null,
	manifest: Manifest,
	appId: string | undefined,
): Promise<SlackSetup> {
	if (!appId) {
		say(
			"",
			"  1. Open this link, pick your workspace and click Create:",
			"",
			`     ${createAppUrl(manifest)}`,
			"",
		)
		appId = await ask("The App ID it shows (Basic Information)", {
			check: value =>
				/^A[A-Z0-9]+$/.test(value) ? undefined : "Like A0123456789.",
		})
	}
	const app = `https://api.slack.com/apps/${appId}`
	say(
		"",
		`  2. Install it: ${app}/install-on-team → Install. Copy the Bot User OAuth Token.`,
	)
	const bot = await askToken("Bot token (xoxb-…)", "xoxb-", async token => {
		await checkBotToken(token)
	})
	say(
		"",
		`  3. ${app}/general → App-Level Tokens → Generate, with the connections:write scope.`,
	)
	const appLevel = await askToken(
		"App-level token (xapp-…)",
		"xapp-",
		checkAppToken,
	)
	const identity = await checkBotToken(bot)
	say(
		"",
		dim("  Your member ID: in Slack, your profile → ⋮ → Copy member ID."),
	)
	const owner = await ask("Your member ID", {
		check: value =>
			MEMBER_ID.test(value) ? undefined : "Like U0123456789.",
	})
	await instance.saveSlackApp({
		...saved,
		app_id: appId,
		team_id: identity.team_id,
		name: manifest.display_information.name,
	})
	return {
		tokens: { bot, app_level: appLevel },
		owner,
		credentials: saved?.credentials,
	}
}

async function askToken(
	question: string,
	prefix: string,
	check: (token: string) => Promise<unknown>,
): Promise<string> {
	while (true) {
		const token = await ask(question, {
			check: value =>
				value.startsWith(prefix)
					? undefined
					: `It starts with ${prefix}`,
		})
		try {
			await check(token)
			return token
		} catch (error) {
			fail(
				`Slack didn't accept it (${error instanceof SlackError ? error.code : (error as Error).message}).`,
			)
		}
	}
}

async function connectChatGpt(instance: Instance) {
	const current = await existingChatGpt(instance.dataDir, APP_NAME)
	if (current) {
		done(`Signed in to ChatGPT as ${current.email ?? "someone"}`)
		if (!(await confirm("Sign in with a different account?", false)))
			return current
	}
	const result = await signInWithChatGpt(instance.dataDir, APP_NAME)
	done(`Signed in to ChatGPT as ${result.email ?? "someone"}`)
	return result
}

/** Installs the service and (re)starts it; true once the bot says it's listening. */
export async function start(instance: Instance): Promise<boolean> {
	await installUnit()
	const since = new Date()
	const running = (await state(instance.name)) === "active"
	const result = await control(
		running ? "restart" : "enable --now",
		instance.name,
	)
	if (result.exitCode !== 0) {
		fail(`systemd couldn't start it: ${result.stderr.toString().trim()}`)
		return false
	}
	if (running) await control("enable --now", instance.name)
	say(
		dim(
			"  Starting (the first start builds the runtime image, a few minutes)…",
		),
	)
	const outcome = await waitUntilListening(instance.name, since)
	if (outcome.ok) done(outcome.line)
	else
		fail(
			`It's not up: ${outcome.reason}. See \`laddu logs --name ${instance.name}\`.`,
		)
	return outcome.ok
}
