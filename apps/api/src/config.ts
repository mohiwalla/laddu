import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";

/** apps/api/, as a directory URL; relative paths in env vars resolve against it. */
const appRoot = new URL("../", import.meta.url);
const fromAppRoot = (path: string) => Bun.fileURLToPath(new URL(path.endsWith("/") ? path : `${path}/`, appRoot)).replace(/\/$/, "");

function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function optional(name: string, fallback: string): string {
  return Bun.env[name]?.trim() || fallback;
}

const dataDir = fromAppRoot(optional("DATA_DIR", ".data"));

/** Settings needed by every entrypoint, including `bun run login`. */
export const paths = {
  dataDir,
  auth: `${dataDir}/chatgpt-auth.json`,
  hostId: `${dataDir}/chatgpt-host.json`,
  sessions: `${dataDir}/sessions.json`,
  /** The bot's own Codex home, isolated from your personal ~/.codex. */
  codexHome: `${dataDir}/codex-home`,
};

export const appName = optional("APP_NAME", "slack-codex-bot");

/** Settings only the bot process needs. Read lazily so `bun run login` works without Slack tokens. */
export function loadBotConfig() {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    ownerUserId: required("OWNER_SLACK_USER_ID"),
    model: required("CODEX_MODEL"),
    reasoningEffort: optional("CODEX_REASONING_EFFORT", "medium") as ModelReasoningEffort,
    sandbox: optional("CODEX_SANDBOX", "workspace-write") as SandboxMode,
    workdir: fromAppRoot(optional("CODEX_WORKDIR", "agent-home")),
    contextMessages: Number(optional("CONTEXT_MESSAGES", "20")),
  };
}

export type BotConfig = ReturnType<typeof loadBotConfig>;
