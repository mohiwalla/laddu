import { App, LogLevel } from "@slack/bolt"
import { prepareCodexHome } from "./agent/codex"
import {
	nameContainersWith,
	prepareDocker,
	stopOrphanedRuns,
} from "./agent/containers"
import { startDesktopGateway, startDesktopReaper } from "./agent/desktop"
import { getAccessToken } from "./auth/siwc"
import { loadBotConfig } from "./config"
import { userFirstName } from "./slack/context"
import {
	registerHandlers,
	resumeInterrupted,
	scheduledRunner,
} from "./slack/handlers"
import { startBotApi } from "./agent/bot-api"
import { startModelProxy } from "./agent/model-proxy"
import { startScheduler } from "./scheduler"
import { BunSocketModeReceiver } from "./slack/socket-mode"
import { oauthCallback } from "./slack/user-tokens"
import { SlackAutomations } from "./slack/automations"
import { SlackForms } from "./slack/forms"

const config = loadBotConfig()

// Docker: per-user containers from one runtime image. Host: Codex runs on this machine.
const runtime =
	config.runtime === "docker"
		? `docker (${(await prepareDocker(config)).tag})`
		: (await prepareCodexHome(config.workdir, config.localDir), "host")
// Fail fast if `bun run login` hasn't been run (or the session has ended).
await getAccessToken()
// Socket Mode: Slack connects over a websocket, so no public URL is needed.
const app = new App({
	token: config.slackBotToken,
	receiver: new BunSocketModeReceiver(config.slackAppToken),
	logLevel: LogLevel.INFO,
})

const auth = await app.client.auth.test()
const slack = {
	automations: new SlackAutomations(app.client, auth.user_id!, {
		allowed: user =>
			config.allowedUsers === "*" || config.allowedUsers.has(user),
		task: scheduledRunner(app.client, config).run,
	}),
	forms: new SlackForms(app.client),
}
// For dot's commands that need the bot (`schedule`, `ado`): next to the model proxy, where
// containers can reach it; on localhost for the host runtime.
startBotApi(
	config.runtime === "docker"
		? new URL((await startModelProxy()).baseUrl).hostname
		: "127.0.0.1",
	{ config, client: app.client, slack },
)
// Container names carry the person's first name, for whoever looks at `docker ps`.
nameContainersWith(userId => userFirstName(app.client, userId))
const { slackSignIn } = config
if (config.desktop || slackSignIn) {
	// dot's Home tab in the Slack app, for the gateway's pages to send people back to.
	const appId = await app.client.bots
		.info({ bot: auth.bot_id! })
		.then(info => info.bot?.app_id)
		.catch(() => undefined)
	startDesktopGateway(
		config,
		slackSignIn
			? request => oauthCallback(request, slackSignIn, app.client)
			: undefined,
		appId
			? `slack://app?team=${auth.team_id}&id=${appId}&tab=home`
			: undefined,
		auth.team_id,
	)
}
if (config.desktop) startDesktopReaper(config)
registerHandlers(app, config, auth.user_id!, slack)
// A previous bot process may have left Codex runs going in containers (they hold thread locks).
if (config.runtime === "docker") await stopOrphanedRuns(auth.team_id!)

await app.start()
// Turns the previous process was in the middle of: close their replies and answer again.
await resumeInterrupted(app.client, config, auth.user_id!)
startScheduler(scheduledRunner(app.client, config))
await slack.automations.start()
const who =
	config.allowedUsers === "*"
		? "everyone"
		: [...config.allowedUsers].join(", ")
console.log(
	`Listening as @${auth.user} in ${auth.team}; answering ${who}; runtime: ${runtime}.`,
)
