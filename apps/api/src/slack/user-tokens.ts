/**
 * Each person's own Slack sign-in, so dot can send DMs as them (`slack dm`). Slack's OAuth flow,
 * user scopes only: dot DMs a link, they allow it on slack.com, and Slack sends them back to
 * /slack/oauth on dot's web address (the gateway), where the code becomes a user token kept here,
 * on the host (never in a container). Accepted only when the account that allowed it is the person
 * who asked, in this workspace.
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate } from "../files"

type WebClient = App["client"]
export type Settings = NonNullable<BotConfig["slackSignIn"]>
type Person = { teamId: string; userId: string }

/** Opening a DM and posting in it, as them; nothing else. */
const USER_SCOPES = ["chat:write", "im:write"]
const LINK_MINUTES = 15

type Connection = { token: string; scopes: string[]; connectedAt: string }

const file = `${paths.dataDir}/slack-users.json`
let connections: Record<string, Connection> | null = null
const key = (person: Person) => `${person.teamId}-${person.userId}`

async function load(): Promise<Record<string, Connection>> {
	return (connections ??=
		(await readJson<Record<string, Connection>>(file)) ?? {})
}

const save = async () => writeJsonPrivate(file, await load())

/** Their user token, or null when they haven't connected. */
export async function userToken(person: Person): Promise<string | null> {
	return (await load())[key(person)]?.token ?? null
}

/** Drops a connection Slack no longer accepts (revoked, or the account deactivated). */
export async function forget(person: Person): Promise<void> {
	delete (await load())[key(person)]
	await save()
}

export async function status(person: Person): Promise<string> {
	const connection = (await load())[key(person)]
	return connection
		? `Connected since ${connection.connectedAt.slice(0, 10)}: DMs go out as them.`
		: "Not connected: DMs can only come from dot (`slack dm --from-dot`). `slack connect` sends them a link to connect."
}

/** Sign-in links waiting to be used, by their `state`. One per person; a newer one replaces it. */
const pending = new Map<string, { person: Person; expires: number }>()

/** DMs them a link to allow dot to post as them. Returns what to tell Codex. */
export async function connect(
	settings: Settings,
	client: WebClient,
	person: Person,
): Promise<string> {
	for (const [state, waiting] of pending)
		if (waiting.expires < Date.now() || key(waiting.person) === key(person))
			pending.delete(state)
	const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
		byte.toString(16).padStart(2, "0"),
	).join("")
	pending.set(state, {
		person,
		expires: Date.now() + LINK_MINUTES * 60_000,
	})
	const link = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
		client_id: settings.clientId,
		user_scope: USER_SCOPES.join(","),
		redirect_uri: settings.redirectUrl,
		state,
		team: person.teamId,
	})}`
	await client.chat.postMessage({
		channel: person.userId,
		text: `To let dot send Slack messages as you, <${link}|connect your Slack account> and allow it. It only lets dot open DMs and post in them, and only when you ask. The link works for ${LINK_MINUTES} minutes; if you didn't ask for this, ignore it.`,
	})
	return "Sent them a link in a DM with dot to connect their Slack account. Once they allow it, dot confirms in that DM; then ask again."
}

export async function disconnect(
	client: WebClient,
	person: Person,
): Promise<boolean> {
	const token = await userToken(person)
	if (!token) return false
	await client.auth.revoke({ token }).catch(() => {})
	await forget(person)
	return true
}

const page = (status: number, text: string) =>
	new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>dot</title><body style="font:16px system-ui;margin:3em auto;max-width:32em;padding:0 1em">${text}</body>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8" } },
	)

/** Slack's redirect back to /slack/oauth after they allow (or cancel) the sign-in. */
export async function oauthCallback(
	request: Request,
	settings: Settings,
	client: WebClient,
): Promise<Response> {
	const url = new URL(request.url)
	const state = url.searchParams.get("state") ?? ""
	const waiting = pending.get(state)
	pending.delete(state)
	if (!waiting || waiting.expires < Date.now())
		return page(
			400,
			"This link has expired or was already used. Ask dot to connect Slack again.",
		)
	const { person } = waiting
	const code = url.searchParams.get("code")
	if (!code) return page(200, "Not connected; you cancelled.")

	const response = await fetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		body: new URLSearchParams({
			client_id: settings.clientId,
			client_secret: settings.clientSecret,
			code,
			redirect_uri: settings.redirectUrl,
		}),
	})
	const result = (await response.json().catch(() => ({}))) as {
		ok?: boolean
		error?: string
		team?: { id?: string }
		authed_user?: { id?: string; access_token?: string; scope?: string }
	}
	const user = result.authed_user
	if (!result.ok || !user?.access_token) {
		console.warn("[slack sign-in] failed:", result.error)
		return page(
			502,
			`Slack didn't finish the sign-in (${result.error ?? "no token"}). Ask dot to connect again.`,
		)
	}
	if (user.id !== person.userId || result.team?.id !== person.teamId) {
		await client.auth.revoke({ token: user.access_token }).catch(() => {})
		return page(
			403,
			"You allowed it from a different Slack account than the one that asked dot, so it isn't connected.",
		)
	}
	;(await load())[key(person)] = {
		token: user.access_token,
		scopes: user.scope?.split(",") ?? [],
		connectedAt: new Date().toISOString(),
	}
	await save()
	console.info(`[slack sign-in] ${person.userId} connected`)
	await client.chat
		.postMessage({
			channel: person.userId,
			text: "Slack connected: when you ask me to DM someone, it now comes from you. Ask me to disconnect Slack to undo it.",
		})
		.catch(() => {})
	return page(
		200,
		"Connected. dot can now send Slack messages as you when you ask it to. You can close this tab.",
	)
}
