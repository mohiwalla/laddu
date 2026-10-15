import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk"

/** apps/api/, as a directory URL; relative paths in env vars resolve against it. */
const appRoot = new URL("../", import.meta.url)
const fromAppRoot = (path: string) =>
	Bun.fileURLToPath(
		new URL(path.endsWith("/") ? path : `${path}/`, appRoot),
	).replace(/\/$/, "")

function required(name: string): string {
	const value = Bun.env[name]?.trim()
	if (!value)
		throw new Error(`Missing required env var ${name} (see .env.example)`)
	return value
}

function optional(name: string, fallback: string): string {
	return Bun.env[name]?.trim() || fallback
}

const dataDir = fromAppRoot(optional("DATA_DIR", ".data"))

/** Settings needed by every entrypoint, including `bun run login`. */
export const paths = {
	dataDir,
	auth: `${dataDir}/chatgpt-auth.json`,
	hostId: `${dataDir}/chatgpt-host.json`,
	sessions: `${dataDir}/sessions.json`,
	/** The bot's own Codex home, isolated from your personal ~/.codex. */
	codexHome: `${dataDir}/codex-home`,
}

export const appName = optional("APP_NAME", "slack-codex-bot")

/** Settings only the bot process needs. Read lazily so `bun run login` works without Slack tokens. */
export function loadBotConfig() {
	const ownerUserId = required("OWNER_SLACK_USER_ID")
	const allowed = optional("ALLOWED_SLACK_USERS", ownerUserId)
	return {
		slackBotToken: required("SLACK_BOT_TOKEN"),
		slackAppToken: required("SLACK_APP_TOKEN"),
		ownerUserId,
		/** Who can use the bot: "*" for everyone in the workspace, else comma-separated user IDs. */
		allowedUsers:
			allowed === "*"
				? ("*" as const)
				: new Set(allowed.split(",").map(id => id.trim())),
		/** "docker": Codex runs in a per-user container (default). "host": on this machine, sandboxed only by Codex. */
		runtime: optional("CODEX_RUNTIME", "docker") as "docker" | "host",
		model: required("CODEX_MODEL"),
		reasoningEffort: optional(
			"CODEX_REASONING_EFFORT",
			"medium",
		) as ModelReasoningEffort,
		/** Host runtime only; in Docker the container is the boundary. */
		sandbox: optional("CODEX_SANDBOX", "workspace-write") as SandboxMode,
		/**
		 * Host runtime only: internet access for Codex's shell (curl etc.). Containers are always
		 * networked, since Codex reaches the model through the proxy. No hosted web search on the plan route.
		 */
		network: optional("CODEX_NETWORK", "true") === "true",
		workdir: fromAppRoot(optional("CODEX_WORKDIR", "agent-home")),
		contextMessages: Number(optional("CONTEXT_MESSAGES", "20")),
		/** Every this many turns per person, a background Codex run updates their memory; 0 turns it off. */
		memoryReviewEvery: Number(optional("MEMORY_REVIEW_EVERY", "3")),
	}
}

export type BotConfig = ReturnType<typeof loadBotConfig>
