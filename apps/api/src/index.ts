import { App, LogLevel } from "@slack/bolt";
import { prepareCodexHome } from "./agent/codex";
import { getAccessToken } from "./auth/siwc";
import { loadBotConfig } from "./config";
import { registerHandlers } from "./slack/handlers";
import { BunSocketModeReceiver } from "./slack/socket-mode";

const config = loadBotConfig();

await prepareCodexHome();
// Fail fast if `bun run login` hasn't been run (or the session has ended).
await getAccessToken();

// Socket Mode: Slack connects over a websocket, so no public URL is needed.
const app = new App({
  token: config.slackBotToken,
  receiver: new BunSocketModeReceiver(config.slackAppToken),
  logLevel: LogLevel.INFO,
});

const auth = await app.client.auth.test();
registerHandlers(app, config, auth.user_id!);

await app.start();
console.log(`Listening as @${auth.user} in ${auth.team}; answering only ${config.ownerUserId}.`);
