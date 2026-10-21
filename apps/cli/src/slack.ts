/**
 * Creating and installing the Slack app without clicking through api.slack.com.
 *
 * Uses the same calls as the Slack CLI (github.com/slackapi/slack-cli, internal/api): a ticket
 * login (`/slackauthticket` in Slack, then the challenge code it shows), `apps.manifest.create`,
 * and `apps.developerInstall`, which returns the bot and app-level tokens in one go. Those last
 * calls aren't in Slack's public docs, so every step has a by-hand fallback (setup.ts).
 */
import { botRoot } from "./paths"
import { ask, dim, say } from "./terminal"

const API = "https://slack.com/api"
/** Sent like the Slack CLI does; the ticket calls ask which CLI version is logging in. */
const CLI_VERSION = "v4.10.0"
/**
 * Slack answers the ticket calls only for its CLI's user agent (anything else gets
 * `internal_error`), so we send that, followed by our own name.
 */
const USER_AGENT = `slack-cli/${CLI_VERSION} (os: linux) slack-dot`

export class SlackError extends Error {
	constructor(
		readonly method: string,
		readonly code: string,
		detail?: unknown,
	) {
		super(
			`Slack ${method} failed: ${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`,
		)
	}
}

type Response = { ok: boolean; error?: string; errors?: unknown } & Record<
	string,
	unknown
>

async function call<T>(
	method: string,
	options: { token?: string; json?: unknown; form?: Record<string, string> },
): Promise<T> {
	const headers: Record<string, string> = { "User-Agent": USER_AGENT }
	if (options.token) headers.Authorization = `Bearer ${options.token}`
	let body: string | URLSearchParams | undefined
	if (options.json !== undefined) {
		headers["Content-Type"] = "application/json; charset=utf-8"
		body = JSON.stringify(options.json)
	} else if (options.form) body = new URLSearchParams(options.form)
	const response = await fetch(`${API}/${method}`, {
		method: "POST",
		headers,
		body,
	})
	const result = (await response.json().catch(() => ({
		ok: false,
		error: `http_${response.status}`,
	}))) as Response
	if (!result.ok)
		throw new SlackError(
			method,
			result.error ?? "unknown_error",
			result.errors,
		)
	return result as T
}

/** A Slack CLI-style login: manages apps as this person, in this workspace. Expires in hours. */
export type CliAuth = {
	token: string
	refresh_token?: string
	exp?: number
	team_id: string
	team_domain?: string
	team_name?: string
	user_id: string
	enterprise_id?: string
}

/**
 * The person runs `/slackauthticket …` in Slack and approves; Slack then shows a challenge code
 * that they type here.
 */
export async function ticketLogin(): Promise<CliAuth> {
	while (true) {
		const { ticket } = await call<{ ticket: string }>(
			"apps.hosted.generateAuthTicket",
			{ form: { slack_cli_version: CLI_VERSION } },
		)
		say(
			"  In Slack, send this in any channel or DM (paste it as plain text):",
			"",
			`    /slackauthticket ${ticket}`,
			"",
			dim(
				"  Approve the permissions it shows; Slack then gives you a challenge code.",
			),
		)
		while (true) {
			const challenge = await ask("Challenge code", {
				check: value =>
					value ? undefined : "Paste the code Slack showed.",
			})
			try {
				const auth = await call<CliAuth & { is_ready?: boolean }>(
					"apps.hosted.exchangeAuthTicket",
					{
						form: {
							ticket,
							challenge,
							slack_cli_version: CLI_VERSION,
						},
					},
				)
				if (auth.token) return auth
				say(
					"  Slack isn't done yet; approve it there, then enter the code.",
				)
			} catch (error) {
				if (!(error instanceof SlackError)) throw error
				if (error.code === "invalid_challenge") {
					say(
						"  That code didn't match. Try again, or press Ctrl-C to stop.",
					)
					continue
				}
				// Expired or used up: start over with a new ticket.
				say(`  ${error.code}; here's a new command.`)
				break
			}
		}
	}
}

/** Swaps an expired CLI login for a fresh one; null when it can't be refreshed any more. */
export async function refreshCliAuth(auth: CliAuth): Promise<CliAuth | null> {
	if (auth.exp && auth.exp * 1000 > Date.now() + 60_000) return auth
	if (!auth.refresh_token) return null
	try {
		const fresh = await call<{
			token: string
			refresh_token: string
			exp: number
		}>("tooling.tokens.rotate", {
			form: { refresh_token: auth.refresh_token },
		})
		return { ...auth, ...fresh }
	} catch {
		return null
	}
}

export type Manifest = Record<string, any>

export type AppIdentity = {
	/** Shown in Slack: the app's and the bot user's name. */
	name: string
	/** The bot's public address (DESKTOP_PUBLIC_URL), for Slack's OAuth redirect; null: none. */
	publicUrl: string | null
}

/** The bundled manifest, named for this bot, with a slash command to match. */
export async function buildManifest(identity: AppIdentity): Promise<Manifest> {
	const manifest = Bun.YAML.parse(
		await Bun.file(`${botRoot}/slack-manifest.yaml`).text(),
	) as Manifest
	const { name } = identity
	manifest.display_information.name = name
	manifest.features.bot_user.display_name = name
	if (manifest.features.agent_view?.agent_description)
		manifest.features.agent_view.agent_description =
			manifest.features.agent_view.agent_description.replace(
				/\bdot\b/g,
				name,
			)
	const command = `/${commandName(name)}`
	for (const slash of manifest.features.slash_commands ?? []) {
		slash.command = command
		slash.description = `Ask ${name} anything; it answers in a thread here`
	}
	for (const shortcut of manifest.features.shortcuts ?? []) {
		shortcut.name = `Ask ${name}`
		shortcut.description = `Ask ${name} about this message`
	}
	if (identity.publicUrl)
		manifest.oauth_config.redirect_urls = [
			`${identity.publicUrl}/slack/oauth`,
		]
	else delete manifest.oauth_config.redirect_urls
	return manifest
}

export const commandName = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 31) || "dot"

export type AppCredentials = {
	client_id: string
	client_secret: string
	signing_secret?: string
	verification_token?: string
}

export async function createApp(token: string, manifest: Manifest) {
	return call<{ app_id: string; credentials: AppCredentials }>(
		"apps.manifest.create",
		{ token, json: { manifest } },
	)
}

export async function updateApp(
	token: string,
	appId: string,
	manifest: Manifest,
) {
	await call("apps.manifest.update", {
		token,
		json: { app_id: appId, manifest },
	})
}

export async function deleteApp(token: string, appId: string) {
	await call("apps.manifest.delete", { token, json: { app_id: appId } })
}

export type Tokens = { bot: string; app_level: string; user?: string }

/** Installs the app to the login's workspace; Slack returns the tokens directly. */
export async function installApp(
	token: string,
	appId: string,
	manifest: Manifest,
): Promise<Tokens> {
	const { api_access_tokens: tokens } = await call<{
		api_access_tokens: Partial<Tokens>
	}>("apps.developerInstall", {
		token,
		json: { app_id: appId, bot_scopes: manifest.oauth_config.scopes.bot },
	})
	if (!tokens.bot || !tokens.app_level)
		throw new SlackError("apps.developerInstall", "missing_tokens")
	return tokens as Tokens
}

/** Install requests that wait on a workspace admin (Slack calls this admin app approval). */
export const needsApproval = (error: unknown) =>
	error instanceof SlackError && error.code.startsWith("app_approval_")

/** Checks a bot token; returns who and where it is. */
export function checkBotToken(token: string) {
	return call<{
		team: string
		team_id: string
		user: string
		user_id: string
	}>("auth.test", { token })
}

/** Checks an app-level token can open Socket Mode (connections:write). */
export async function checkAppToken(token: string) {
	await call("apps.connections.open", { token })
}

/** DMs someone as the bot. */
export async function sendDm(token: string, user: string, text: string) {
	await call("chat.postMessage", { token, json: { channel: user, text } })
}

/** api.slack.com address that opens "Create app" with the manifest filled in. */
export const createAppUrl = (manifest: Manifest) =>
	`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
