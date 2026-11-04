import { App, LogLevel } from "@slack/bolt"
import { picturesWork, servePicturesAt } from "./appearance"
import {
	bridgeGateway,
	nameContainersWith,
	prepareDocker,
	stopOrphanedRuns,
} from "./agent/containers"
import { startDesktopGateway, startDesktopReaper } from "./agent/desktop"
import { loadBotConfig } from "./config"
import { recognizeOwnMessages, userFirstName } from "./slack/context"
import {
	registerHandlers,
	resumeInterrupted,
	scheduledRunner,
} from "./slack/handlers"
import { startBotApi } from "./agent/bot-api"
import { startScheduler } from "./scheduler"
import { BunSocketModeReceiver } from "./slack/socket-mode"
import { oauthCallback } from "./slack/user-tokens"
import { SlackAutomations } from "./slack/automations"
import { SlackForms } from "./slack/forms"
import { setSystemName } from "./slack/system"

const config = loadBotConfig()

// Per-user containers from one runtime image.
const runtime = `docker (${await prepareDocker(config)})`
// Socket Mode: Slack connects over a websocket, so no public URL is needed.
const app = new App({
	token: config.slackBotToken,
	receiver: new BunSocketModeReceiver(config.slackAppToken),
	logLevel: LogLevel.INFO,
})

const auth = await app.client.auth.test()
setSystemName(auth.user ?? "")
const slack = {
	automations: new SlackAutomations(app.client, auth.user_id!, {
		allowed: user =>
			config.allowedUsers === "*" || config.allowedUsers.has(user),
		task: scheduledRunner(app.client, config).run,
	}),
	forms: new SlackForms(app.client),
}
// For laddu's commands that need the bot (`schedule`, `ado`): on the Docker bridge, where
// containers can reach it.
startBotApi(await bridgeGateway(), { config, client: app.client, slack })
// Container names carry the person's first name, for whoever looks at `docker ps`.
nameContainersWith(userId => userFirstName(app.client, userId))
const { slackSignIn } = config
servePicturesAt(config.desktopViewer.publicUrl)
if (config.desktop || slackSignIn || picturesWork()) {
	// laddu's Home tab in the Slack app, for the gateway's pages to send people back to.
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
recognizeOwnMessages(auth.bot_id!, auth.user_id!)
registerHandlers(app, config, auth.user_id!, slack)
// A previous bot process may have left Codex runs going in containers (they hold thread locks).
await stopOrphanedRuns(auth.team_id!)

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
