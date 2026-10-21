/** Everything after setup: change settings, sign in again, check, update, run and remove. */
import { existingChatGpt, signInWithChatGpt } from "./chatgpt"
import { Instance } from "./instance"
import { bun, fromPackage, instanceNames } from "./paths"
import {
	control,
	followLogs,
	installUnit,
	removeUnitIfUnused,
	state,
	unitName,
	unitText,
} from "./service"
import { start } from "./setup"
import {
	buildManifest,
	checkAppToken,
	checkBotToken,
	deleteApp,
	refreshCliAuth,
	SlackError,
	updateApp,
} from "./slack"
import {
	ask,
	bold,
	choose,
	confirm,
	dim,
	done,
	fail,
	green,
	red,
	say,
	step,
	warn,
	yellow,
} from "./terminal"

const APP_NAME = "slack-dot"

export async function configure(instance: Instance): Promise<boolean> {
	say("", bold(`Settings for ${instance.name}`))
	const env = await instance.env()
	const action = await choose("What do you want to change?", [
		{ label: "Model, reasoning effort and fast mode", value: "model" },
		{ label: "Who can use it", value: "access" },
		{
			label: "Microsoft (Azure DevOps and Microsoft 365)",
			value: "microsoft",
		},
		{ label: "AWS CodeCommit profiles", value: "codecommit" },
		{ label: "Private instructions (AGENTS.local.md)", value: "notes" },
		{ label: "Edit the .env file", value: "env" },
		{
			label: "Name, Slack app, runtime, desktop, public address",
			value: "setup",
			hint: "runs setup again",
		},
	] as const)

	switch (action) {
		case "model": {
			const chatgpt = await existingChatGpt(instance.dataDir, APP_NAME)
			const models = chatgpt?.models ?? []
			const model = models.length
				? await choose(
						"Model",
						models.map(model => ({
							label: model.slug,
							value: model.slug,
							hint: model.name,
						})),
						Math.max(
							0,
							models.findIndex(
								model => model.slug === env.CODEX_MODEL,
							),
						),
					)
				: await ask("Model slug", { default: env.CODEX_MODEL })
			const efforts = ["low", "medium", "high", "xhigh"]
			const effort = await choose(
				"Reasoning effort",
				efforts.map(value => ({ label: value, value })),
				Math.max(
					0,
					efforts.indexOf(env.CODEX_REASONING_EFFORT ?? "medium"),
				),
			)
			const fast = await confirm(
				"Fast mode (quicker, uses more of the plan's limits)?",
				env.CODEX_FAST === "true",
			)
			await instance.setEnv({
				CODEX_MODEL: model,
				CODEX_REASONING_EFFORT: effort,
				CODEX_FAST: String(fast),
			})
			break
		}
		case "access": {
			const everyone = await choose(
				"Who can use it?",
				[
					{ label: "Just me", value: "me" },
					{ label: "Everyone in the workspace", value: "*" },
					{ label: "Specific people", value: "some" },
				],
				env.ALLOWED_SLACK_USERS === "*" ? 1 : 0,
			)
			const value =
				everyone === "me"
					? env.OWNER_SLACK_USER_ID!
					: everyone === "*"
						? "*"
						: await ask("Member IDs, comma-separated", {
								default: env.ALLOWED_SLACK_USERS,
								check: value =>
									value
										.split(",")
										.every(id =>
											/^[UW][A-Z0-9]{2,}$/.test(
												id.trim(),
											),
										)
										? undefined
										: "Member IDs look like U0123456789.",
							})
			await instance.setEnv({ ALLOWED_SLACK_USERS: value })
			break
		}
		case "microsoft": {
			say(
				dim(
					'  One Entra app registration (public client flows on); see docs/SETUP.md, "Microsoft". Blank turns it off.',
				),
			)
			const clientId = await ask("Application (client) ID", {
				default: env.MICROSOFT_CLIENT_ID,
			})
			const tenant = clientId
				? await ask("Directory (tenant) ID", {
						default: env.MICROSOFT_TENANT || "organizations",
					})
				: ""
			await instance.setEnv({
				MICROSOFT_CLIENT_ID: clientId || null,
				MICROSOFT_TENANT: tenant || null,
			})
			break
		}
		case "codecommit": {
			say(
				dim(
					"  Pairs of Slack member ID = AWS CLI profile on this machine, e.g. U0123456789=default. Blank turns it off.",
				),
			)
			const profiles = await ask("Profiles", {
				default: env.CODECOMMIT_PROFILES,
				check: value =>
					!value ||
					value
						.split(",")
						.every(pair => /^[UW][A-Z0-9]+=\S+$/.test(pair.trim()))
						? undefined
						: "Like U0123456789=default,U0987654321=teammate",
			})
			await instance.setEnv({ CODECOMMIT_PROFILES: profiles || null })
			break
		}
		case "notes":
			await edit(`${instance.dir}/AGENTS.local.md`)
			done("Saved; it applies from the next message, no restart needed.")
			return true
		case "env":
			await edit(instance.envPath)
			break
		case "setup": {
			const { setup } = await import("./setup")
			return setup(instance.name)
		}
	}
	return restart(instance)
}

async function edit(path: string) {
	const editor = Bun.env.VISUAL || Bun.env.EDITOR || Bun.which("nano") || "vi"
	await Bun.spawn([...editor.split(" "), path], {
		stdio: ["inherit", "inherit", "inherit"],
	}).exited
}

export async function restart(instance: Instance): Promise<boolean> {
	step(`Restarting ${instance.name}`)
	return start(instance)
}

/** ChatGPT sign-in again, e.g. after the bot says the session ended. */
export async function login(instance: Instance): Promise<boolean> {
	const result = await signInWithChatGpt(instance.dataDir, APP_NAME)
	done(`Signed in as ${result.email ?? "someone"}`)
	return restart(instance)
}

export async function doctor(instance: Instance): Promise<boolean> {
	say("", bold(`Checking ${instance.name}`))
	const env = await instance.env()
	let healthy = true
	const check = (ok: boolean, good: string, bad: string) => {
		if (ok) done(good)
		else {
			fail(bad)
			healthy = false
		}
	}

	const missing = [
		"SLACK_BOT_TOKEN",
		"SLACK_APP_TOKEN",
		"OWNER_SLACK_USER_ID",
		"CODEX_MODEL",
	].filter(key => !env[key])
	check(
		!missing.length,
		"Settings complete",
		`Missing ${missing.join(", ")}; run \`slack-dot setup --name ${instance.name}\``,
	)

	const unit = Bun.file(
		(await Bun.$`id -u`.text()).trim() === "0"
			? "/etc/systemd/system/slack-dot@.service"
			: `${Bun.env.HOME}/.config/systemd/user/slack-dot@.service`,
	)
	check(
		(await unit.exists()) && (await unit.text()) === unitText(),
		"Service definition current",
		"Service definition missing or out of date; `slack-dot restart` rewrites it",
	)
	const running = await state(instance.name)
	check(running === "active", `Service ${running}`, `Service ${running}`)

	if (env.CODEX_RUNTIME !== "host") {
		const docker = await Bun.$`docker info`.quiet().nothrow()
		check(
			docker.exitCode === 0,
			"Docker reachable",
			"Docker isn't reachable",
		)
	}

	if (env.SLACK_BOT_TOKEN) {
		const bot = await checkBotToken(env.SLACK_BOT_TOKEN).catch(
			(error: Error) => error,
		)
		check(
			!(bot instanceof Error),
			bot instanceof Error ? "" : `Slack bot @${bot.user} in ${bot.team}`,
			`Slack bot token: ${bot instanceof SlackError ? bot.code : (bot as Error).message}`,
		)
	}
	if (env.SLACK_APP_TOKEN) {
		const app = await checkAppToken(env.SLACK_APP_TOKEN).then(
			() => null,
			(error: Error) => error,
		)
		check(
			!app,
			"Slack Socket Mode token",
			`Slack app-level token: ${app instanceof SlackError ? app.code : app?.message}`,
		)
	}

	const chatgpt = await existingChatGpt(instance.dataDir, APP_NAME)
	check(
		!!chatgpt,
		`ChatGPT: ${chatgpt?.email ?? "signed in"}`,
		`ChatGPT sign-in missing or ended; run \`slack-dot login --name ${instance.name}\``,
	)
	if (chatgpt?.models.length && env.CODEX_MODEL)
		check(
			chatgpt.models.some(model => model.slug === env.CODEX_MODEL),
			`Model ${env.CODEX_MODEL}`,
			`Model ${env.CODEX_MODEL} isn't on your plan; \`slack-dot configure\` picks another`,
		)

	if (running !== "active") {
		say("", dim("  Last log lines:"))
		await followLogs(instance.name, false, 20)
	}
	say("")
	return healthy
}

/**
 * Upgrades the package, then (from the new code) rewrites the service, pushes each bot's Slack
 * manifest and restarts them all.
 */
export async function update(finishing: boolean): Promise<boolean> {
	if (!finishing) {
		if (fromPackage) {
			step("Updating slack-dot")
			const install = await Bun.spawn(
				[bun, "add", "-g", "slack-dot@latest"],
				{
					stdio: ["inherit", "inherit", "inherit"],
				},
			).exited
			if (install !== 0) {
				fail("Couldn't install the new version.")
				return false
			}
			// The rest runs on the new version's code.
			const cli = Bun.which("slack-dot") ?? "slack-dot"
			return (
				(await Bun.spawn([cli, "update", "--finish"], {
					stdio: ["inherit", "inherit", "inherit"],
				}).exited) === 0
			)
		}
		warn("Running from a git checkout: `git pull` updates the code.")
	}

	await installUnit()
	let ok = true
	for (const name of await instanceNames()) {
		const instance = new Instance(name)
		step(name)
		await pushManifest(instance)
		ok = (await start(instance)) && ok
	}
	return ok
}

/** New events, scopes or commands in the bundled manifest reach Slack without a reinstall. */
async function pushManifest(instance: Instance) {
	const app = await instance.slackApp()
	if (!app?.cli) {
		warn(
			"Slack app settings weren't updated (the app was made by hand). Run setup again if this version needs new Slack permissions.",
		)
		return
	}
	const cli = await refreshCliAuth(app.cli)
	if (!cli) {
		warn(
			"Slack app settings weren't updated: its Slack login expired. `slack-dot setup` signs in again.",
		)
		return
	}
	await instance.saveSlackApp({ ...app, cli })
	const env = await instance.env()
	const publicUrl = env.DESKTOP_PUBLIC_URL?.startsWith("https://")
		? env.DESKTOP_PUBLIC_URL
		: null
	try {
		await updateApp(
			cli.token,
			app.app_id,
			await buildManifest({ name: app.name, publicUrl }),
		)
		done("Slack app settings updated")
	} catch (error) {
		warn(`Slack app settings weren't updated: ${(error as Error).message}`)
	}
}

export async function list() {
	const names = await instanceNames()
	if (!names.length) {
		say("No bots set up here yet. Run `slack-dot setup`.")
		return
	}
	for (const name of names) {
		const instance = new Instance(name)
		const [status, app, env] = await Promise.all([
			state(name),
			instance.slackApp(),
			instance.env(),
		])
		const colored =
			status === "active"
				? green(status)
				: status === "failed"
					? red(status)
					: yellow(status)
		say(
			`${bold(name.padEnd(16))} ${colored.padEnd(18)} ${dim(
				[app?.name && `@${app.name}`, app?.team_domain, env.CODEX_MODEL]
					.filter(Boolean)
					.join("  "),
			)}`,
		)
	}
}

export async function power(
	action: "start" | "stop" | "restart" | "status",
	instance: Instance,
): Promise<boolean> {
	if (action === "status") {
		say(`${instance.name}: ${await state(instance.name)}`)
		return true
	}
	if (action === "stop") {
		const result = await control("stop", instance.name)
		if (result.exitCode === 0) done(`Stopped ${instance.name}`)
		return result.exitCode === 0
	}
	return start(instance)
}

export const logs = (instance: Instance, follow: boolean) =>
	followLogs(instance.name, follow)

/** Stops and removes a bot: its service, Slack app, containers and, if asked, its data. */
export async function uninstall(instance: Instance, yes: boolean) {
	const { name } = instance
	say("", bold(`Removing ${name}`))
	if (
		!yes &&
		!(await confirm(
			`Stop ${name} and remove its service, containers and Slack app?`,
			false,
		))
	)
		return false

	await control("disable --now", name)
	done(`Stopped ${unitName(name)}`)

	const containers = (
		await Bun.$`docker ps -aq --filter label=dot.instance=${name}`
			.quiet()
			.nothrow()
			.text()
	)
		.split("\n")
		.filter(Boolean)
	if (containers.length) {
		await Bun.$`docker rm -f ${containers}`.quiet().nothrow()
		done(`Removed ${containers.length} container(s)`)
	}

	const app = await instance.slackApp()
	const cli = app?.cli && (await refreshCliAuth(app.cli))
	if (app && cli) {
		try {
			await deleteApp(cli.token, app.app_id)
			done(`Deleted the Slack app (${app.app_id})`)
		} catch (error) {
			warn(`Couldn't delete the Slack app: ${(error as Error).message}`)
		}
	} else if (app)
		warn(
			`Delete the Slack app yourself: https://api.slack.com/apps/${app.app_id}/general → Delete App`,
		)

	if (
		yes ||
		(await confirm(
			`Also delete its data (${instance.dir}, people's files and memory in Docker volumes)? This can't be undone.`,
			false,
		))
	) {
		const volumes = (
			await Bun.$`docker volume ls -q --filter name=${`dot-home-${name.replace(/[^a-z0-9]/g, "")}-`}`
				.quiet()
				.nothrow()
				.text()
		)
			.split("\n")
			.filter(Boolean)
		if (volumes.length)
			await Bun.$`docker volume rm ${volumes}`.quiet().nothrow()
		await Bun.$`rm -rf ${instance.dir}`.quiet()
		done("Deleted its data")
	} else say(dim(`  Kept ${instance.dir}`))

	await removeUnitIfUnused(await instanceNames())
	return true
}
