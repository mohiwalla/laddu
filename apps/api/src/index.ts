import { App, LogLevel } from "@slack/bolt"
import { prepareCodexHome } from "./agent/codex"
import { prepareDocker, stopOrphanedRuns } from "./agent/containers"
import { getAccessToken } from "./auth/siwc"
import { loadBotConfig } from "./config"
import {
	registerHandlers,
	resumeInterrupted,
	scheduledRunner,
} from "./slack/handlers"
import { startBotApi } from "./agent/bot-api"
import { startModelProxy } from "./agent/model-proxy"
import { startScheduler } from "./scheduler"
import { BunSocketModeReceiver } from "./slack/socket-mode"

const config = loadBotConfig()

// Docker: per-user containers from one runtime image. Host: Codex runs on this machine.
const runtime =
	config.runtime === "docker"
		? `docker (${(await prepareDocker()).tag})`
		: (await prepareCodexHome(config.workdir), "host")
// Fail fast if `bun run login` hasn't been run (or the session has ended).
await getAccessToken()
// For dot's commands that need the bot (`schedule`): next to the model proxy, where containers
// can reach it; on localhost for the host runtime.
startBotApi(
	config.runtime === "docker"
		? new URL((await startModelProxy()).baseUrl).hostname
		: "127.0.0.1",
)

// Socket Mode: Slack connects over a websocket, so no public URL is needed.
const app = new App({
	token: config.slackBotToken,
	receiver: new BunSocketModeReceiver(config.slackAppToken),
	logLevel: LogLevel.INFO,
})

const auth = await app.client.auth.test()
registerHandlers(app, config, auth.user_id!)
// A previous bot process may have left Codex runs going in containers (they hold thread locks).
if (config.runtime === "docker") await stopOrphanedRuns(auth.team_id!)

await app.start()
// Turns the previous process was in the middle of: close their replies and answer again.
await resumeInterrupted(app.client, config, auth.user_id!)
startScheduler(scheduledRunner(app.client, config))
const who =
	config.allowedUsers === "*"
		? "everyone"
		: [...config.allowedUsers].join(", ")
console.log(
	`Listening as @${auth.user} in ${auth.team}; answering ${who}; runtime: ${runtime}.`,
)
