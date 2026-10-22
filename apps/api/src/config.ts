import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk"
import type { AgentId } from "./agent/agents"

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

/** "*" for everyone in the workspace, else comma-separated Slack user IDs. */
function users(value: string): "*" | Set<string> {
	return value === "*"
		? "*"
		: new Set(value.split(",").map(id => id.trim()).filter(Boolean))
}

function agentId(value: string): AgentId {
	if (value === "codex" || value === "opencode") return value
	throw new Error(`DOT_AGENT must be "codex" or "opencode", not "${value}"`)
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

/**
 * Set by `slack-dot setup` (the instance's name). Labels this bot's containers and volumes, so
 * several bots on one machine, even in one workspace, never touch each other's. Unset: the
 * names from before instances.
 */
export const instance = optional("DOT_INSTANCE", "")

/** Settings only the bot process needs. Read lazily so `bun run login` works without Slack tokens. */
export function loadBotConfig() {
	const workdir = fromAppRoot(optional("CODEX_WORKDIR", "agent-home"))
	const ownerUserId = required("OWNER_SLACK_USER_ID")
	const allowed = optional("ALLOWED_SLACK_USERS", ownerUserId)
	/** Where the desktop viewer gateway listens; keep it local and put a tunnel or proxy in front. */
	const desktopViewer = (() => {
		const host = optional("DESKTOP_VIEWER_HOST", "127.0.0.1")
		const port = Number(optional("DESKTOP_VIEWER_PORT", "6900"))
		/** The address people open (a tunnel or HTTPS domain on a server). */
		const publicUrl = optional(
			"DESKTOP_PUBLIC_URL",
			`http://localhost:${port}`,
		).replace(/\/$/, "")
		/**
		 * A second address for the people in `tailnetUsers` (e.g. `tailscale serve` on this machine):
		 * their links point there, straight over their tailnet instead of through the tunnel.
		 */
		const tailnetUrl =
			Bun.env.DESKTOP_TAILNET_URL?.trim().replace(/\/$/, "") || undefined
		const tailnetUsers = users(optional("DESKTOP_TAILNET_USERS", ""))
		return { host, port, publicUrl, tailnetUrl, tailnetUsers }
	})()
	return {
		slackBotToken: required("SLACK_BOT_TOKEN"),
		slackAppToken: required("SLACK_APP_TOKEN"),
		/** Who runs this bot. Only the default for ALLOWED_SLACK_USERS; it gets no special treatment. */
		ownerUserId,
		/** Who can use the bot: "*" for everyone in the workspace, else comma-separated user IDs. */
		allowedUsers: users(allowed),
		/**
		 * Who can run on Codex (the owner's ChatGPT plan): "*" or comma-separated user IDs. Everyone
		 * else is on OpenCode, whatever DOT_AGENT or their pick says.
		 */
		codexUsers: users(optional("CODEX_USERS", "*")),
		/** "docker": Codex runs in a per-user container (default). "host": on this machine, sandboxed only by Codex. */
		runtime: optional("CODEX_RUNTIME", "docker") as "docker" | "host",
		/** The agent people get until they pick one on the Home tab: "codex" or "opencode". */
		agent: agentId(optional("DOT_AGENT", "codex")),
		/**
		 * The model a turn runs on. From CODEX_MODEL here; configFor() (preferences.ts) swaps in the
		 * person's pick, or OPENCODE_MODEL when their agent is OpenCode.
		 */
		model: required("CODEX_MODEL"),
		opencodeModel: optional("OPENCODE_MODEL", "opencode/big-pickle"),
		reasoningEffort: optional(
			"CODEX_REASONING_EFFORT",
			"medium",
		) as ModelReasoningEffort,
		/** Fast mode (Codex's service_tier "fast"): quicker answers that use more of the plan's limits. */
		fast: optional("CODEX_FAST", "false") === "true",
		/**
		 * Docker runtime: every container gets internet only, without access to
		 * this machine's services, its local network or other people's containers.
		 */
		isolateNetwork: optional("ISOLATE_NETWORK", "true") === "true",
		/**
		 * Docker runtime: each person's dot gets a desktop in their container (started when first
		 * used, stopped when idle) that Codex can drive, and that they can watch or take over.
		 */
		desktop:
			optional("DESKTOP", "true") === "true" &&
			optional("CODEX_RUNTIME", "docker") === "docker",
		desktopViewer,
		/** Minutes without actions or viewers before a desktop is stopped (files and logins stay). */
		desktopIdleMinutes: Number(optional("DESKTOP_IDLE_MINUTES", "10")),
		/** Host runtime only; in Docker the container is the boundary. */
		sandbox: optional("CODEX_SANDBOX", "workspace-write") as SandboxMode,
		/**
		 * Host runtime only: internet access for Codex's shell (curl etc.). Containers are always
		 * networked, since Codex reaches the model through the proxy. No hosted web search on the plan route.
		 */
		network: optional("CODEX_NETWORK", "true") === "true",
		workdir,
		/**
		 * Where the deployment's own AGENTS.local.md and skills.local/ live. Defaults to the persona
		 * folder; `slack-dot setup` points it at the instance folder, outside the installed package.
		 */
		localDir: Bun.env.CODEX_LOCAL_DIR?.trim()
			? fromAppRoot(Bun.env.CODEX_LOCAL_DIR.trim())
			: workdir,
		contextMessages: Number(optional("CONTEXT_MESSAGES", "20")),
		/** Every this many turns per person, a background Codex run updates their memory; 0 turns it off. */
		memoryReviewEvery: Number(optional("MEMORY_REVIEW_EVERY", "3")),
		/**
		 * Microsoft (Azure DevOps and Microsoft 365), per person: an Entra app registration's client
		 * ID, with public client flows on. Unset: those integrations are off. The AZURE_DEVOPS_*
		 * names are read too, from before Microsoft 365 was added.
		 */
		microsoft: (() => {
			const clientId = (
				Bun.env.MICROSOFT_CLIENT_ID || Bun.env.AZURE_DEVOPS_CLIENT_ID
			)?.trim()
			if (!clientId) return null
			const tenant =
				(
					Bun.env.MICROSOFT_TENANT || Bun.env.AZURE_DEVOPS_TENANT
				)?.trim() || "organizations"
			/** Graph permissions asked for at sign-in (space or comma separated); see microsoft.ts. */
			const graphScopes = (
				Bun.env.MICROSOFT_GRAPH_SCOPES?.trim() ||
				"User.Read User.ReadBasic.All Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All Sites.ReadWrite.All Chat.ReadWrite ChannelMessage.Send Team.ReadBasic.All Channel.ReadBasic.All Tasks.ReadWrite"
			)
				.split(/[\s,]+/)
				.filter(Boolean)
			return { clientId, tenant, graphScopes }
		})(),
		/**
		 * Sending Slack DMs as people: the Slack app's client ID and secret (Basic Information), for
		 * each person's own sign-in. Slack sends them back to /slack/oauth on DESKTOP_PUBLIC_URL,
		 * which must be listed as a Redirect URL. Unset: DMs only come from dot.
		 */
		slackSignIn: (() => {
			const clientId = Bun.env.SLACK_CLIENT_ID?.trim()
			const clientSecret = Bun.env.SLACK_CLIENT_SECRET?.trim()
			if (!clientId || !clientSecret) return null
			return {
				clientId,
				clientSecret,
				redirectUrl: `${desktopViewer.publicUrl}/slack/oauth`,
			}
		})(),
		/** Host AWS CLI profiles explicitly assigned to Slack users; no shared default credentials. */
		codeCommit: (() => {
			const raw = Bun.env.CODECOMMIT_PROFILES?.trim()
			if (!raw) return null
			const pairs = raw.split(",").map(pair => pair.trim().split("="))
			if (
				pairs.some(
					pair =>
						pair.length !== 2 ||
						!/^[UW][A-Z0-9]+$/.test(pair[0]!) ||
						!pair[1]?.trim(),
				)
			)
				throw new Error(
					"CODECOMMIT_PROFILES must map Slack user IDs to host AWS CLI profile names.",
				)
			return {
				profiles: Object.fromEntries(pairs) as Record<string, string>,
				cli: optional("AWS_CLI_PATH", "aws"),
			}
		})(),
		/** Reacting with this emoji (name without colons) to a message asks dot to handle it. */
		triggerEmoji: optional("TRIGGER_EMOJI", "robot_face"),
	}
}

export type BotConfig = ReturnType<typeof loadBotConfig>
