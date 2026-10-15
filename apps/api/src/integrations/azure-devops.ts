/**
 * Azure DevOps (Boards, Repos, Pipelines…), per person: reads and changes, as them.
 *
 * Each person connects their own account with Microsoft's device code sign-in: dot DMs them a
 * code for microsoft.com/devicelogin, polls until they approve, and keeps the tokens here, on the
 * host (never in a container). The `ado` command in their container asks the bot API to make
 * requests, signed with the turn's caller credential, so it can only act as the person asking.
 * A sign-in is only accepted when the Microsoft account's email matches the person's Slack email,
 * so nobody can link someone else's account to their own dot by getting them to enter a code.
 */
import type { App } from "@slack/bolt"
import { decodeJwt } from "jose"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate } from "../files"
import { userEmail } from "../slack/context"

type WebClient = App["client"]

/** Azure DevOps' resource ID in Microsoft Entra, plus a refresh token and the signed-in identity. */
const SCOPE =
	"499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile email"
const API_VERSION = "7.1"
/** Hosts the `ado` command may reach. All of them are Azure DevOps services. */
const HOSTS =
	/^(dev\.azure\.com|[a-z0-9-]+\.dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com|app\.vssps\.visualstudio\.com)$/
/** The POST endpoints that only read: work item queries, batch reads and search. */
const READ_POSTS = /\/_apis\/(wit\/(wiql|workitemsbatch)|search\/)/i
const MAX_RESPONSE_BYTES = 400_000

type Account = {
	accessToken: string
	refreshToken: string
	/** Epoch ms. */
	expiresAt: number
	name: string
	email: string
	organizations: string[]
	defaultOrganization?: string
}

type Settings = NonNullable<BotConfig["azureDevOps"]>
export type Person = { teamId: string; userId: string }

const file = `${paths.dataDir}/azure-devops.json`
let accounts: Record<string, Account> | null = null
const key = (person: Person) => `${person.teamId}-${person.userId}`

async function load(): Promise<Record<string, Account>> {
	accounts ??= (await readJson<Record<string, Account>>(file)) ?? {}
	return accounts
}

async function save(): Promise<void> {
	await writeJsonPrivate(file, await load())
}

class SignInError extends Error {}

/** POSTs a form to Entra's token or device code endpoint. */
async function entra(
	settings: Settings,
	endpoint: "token" | "devicecode",
	form: Record<string, string>,
) {
	const response = await fetch(
		`https://login.microsoftonline.com/${settings.tenant}/oauth2/v2.0/${endpoint}`,
		{
			method: "POST",
			body: new URLSearchParams({
				client_id: settings.clientId,
				...form,
			}),
		},
	)
	return {
		ok: response.ok,
		body: (await response.json()) as Record<string, unknown>,
	}
}

/** Who the tokens belong to: name, and every email-like identity Microsoft reports. */
function identities(tokens: Record<string, unknown>) {
	const claims = [tokens.id_token, tokens.access_token].flatMap(token => {
		try {
			return typeof token === "string" ? [decodeJwt(token)] : []
		} catch {
			return []
		}
	})
	const emails = new Set<string>()
	let name = ""
	for (const claim of claims) {
		name ||= String(claim.name ?? "")
		for (const field of [
			"email",
			"preferred_username",
			"upn",
			"unique_name",
		])
			if (typeof claim[field] === "string")
				emails.add((claim[field] as string).toLowerCase())
	}
	return { name, emails }
}

async function vssps(path: string, accessToken: string) {
	const response = await fetch(
		`https://app.vssps.visualstudio.com/_apis/${path}`,
		{
			headers: { authorization: `Bearer ${accessToken}` },
		},
	)
	if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
	return (await response.json()) as Record<string, unknown>
}

/** The organizations the person belongs to, plus their Azure DevOps profile email. */
async function discover(accessToken: string) {
	const profile = await vssps(
		`profile/profiles/me?api-version=${API_VERSION}`,
		accessToken,
	)
	const list = await vssps(
		`accounts?memberId=${profile.id}&api-version=${API_VERSION}`,
		accessToken,
	)
	return {
		email: String(profile.emailAddress ?? "").toLowerCase(),
		organizations: ((list.value as { accountName: string }[]) ?? [])
			.map(account => account.accountName)
			.sort(),
	}
}

const signingIn = new Set<string>()

/**
 * Starts a device code sign-in: DMs the code, then polls in the background and DMs the outcome.
 * Returns what to tell Codex (never the code itself).
 */
export async function connect(
	settings: Settings,
	client: WebClient,
	person: Person,
): Promise<string> {
	const id = key(person)
	if (signingIn.has(id))
		return "A sign-in is already waiting for them in their DMs with dot."
	const started = await entra(settings, "devicecode", { scope: SCOPE })
	if (!started.ok)
		throw new SignInError(
			`Microsoft refused to start the sign-in: ${started.body.error_description ?? started.body.error}`,
		)
	const { device_code, user_code, verification_uri, expires_in, interval } =
		started.body as {
			device_code: string
			user_code: string
			verification_uri: string
			expires_in: number
			interval: number
		}
	const dm = (text: string) =>
		client.chat.postMessage({ channel: person.userId, text })
	await dm(
		`To connect Azure DevOps, open ${verification_uri}, enter *${user_code}* and sign in with your work account. The code works for ${Math.round(expires_in / 60)} minutes. If you didn't ask for this, ignore it.`,
	)
	signingIn.add(id)
	void poll(settings, client, person, device_code, interval, expires_in)
		.then(dm)
		.catch(error => {
			console.warn("[azure-devops] sign-in failed:", error)
			return dm(
				`Azure DevOps sign-in didn't finish: ${error instanceof SignInError ? error.message : "something went wrong on my side"}. Ask me to connect again to retry.`,
			)
		})
		.finally(() => signingIn.delete(id))
	return "Sent them a Microsoft sign-in link and code in a DM with dot. Once they approve it, Azure DevOps is connected and dot confirms in that DM; then ask again."
}

async function poll(
	settings: Settings,
	client: WebClient,
	person: Person,
	deviceCode: string,
	interval: number,
	expiresIn: number,
): Promise<string> {
	const deadline = Date.now() + expiresIn * 1000
	let wait = interval
	while (Date.now() < deadline) {
		await Bun.sleep(wait * 1000)
		const { ok, body } = await entra(settings, "token", {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: deviceCode,
		})
		if (ok) return finishSignIn(client, person, body)
		if (body.error === "authorization_pending") continue
		if (body.error === "slow_down") {
			wait += 5
			continue
		}
		if (body.error === "authorization_declined")
			throw new SignInError("you declined it")
		if (body.error === "expired_token") break
		throw new SignInError(String(body.error_description ?? body.error))
	}
	throw new SignInError("the code expired")
}

async function finishSignIn(
	client: WebClient,
	person: Person,
	tokens: Record<string, unknown>,
): Promise<string> {
	const { name, emails } = identities(tokens)
	const accessToken = String(tokens.access_token)
	const found = await discover(accessToken)
	if (found.email) emails.add(found.email)
	const slackEmail = await userEmail(client, person.userId)
	if (slackEmail && !emails.has(slackEmail.toLowerCase()))
		throw new SignInError(
			`that Microsoft account (${[...emails][0] ?? "unknown"}) isn't the one on your Slack profile (${slackEmail}), so I didn't connect it`,
		)
	const all = await load()
	all[key(person)] = {
		accessToken,
		refreshToken: String(tokens.refresh_token),
		expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
		name,
		email: found.email || [...emails][0] || "",
		organizations: found.organizations,
		defaultOrganization:
			found.organizations.length === 1
				? found.organizations[0]
				: undefined,
	}
	await save()
	const orgs = found.organizations.length
		? `Organizations: ${found.organizations.join(", ")}.`
		: "Your account isn't in any Azure DevOps organization yet."
	return `:white_check_mark: Azure DevOps connected as ${name || all[key(person)]!.email}. ${orgs} Ask me in the conversation where you started.`
}

const refreshing = new Map<string, Promise<Account | null>>()

/** The person's account with a fresh access token, or null if they aren't connected. */
async function account(
	settings: Settings,
	person: Person,
): Promise<Account | null> {
	const id = key(person)
	const current = (await load())[id]
	if (!current) return null
	if (current.expiresAt - Date.now() > 5 * 60_000) return current
	const pending = refreshing.get(id)
	if (pending) return pending
	const task = (async () => {
		const { ok, body } = await entra(settings, "token", {
			grant_type: "refresh_token",
			refresh_token: current.refreshToken,
			scope: SCOPE,
		})
		const all = await load()
		if (!ok) {
			// invalid_grant: revoked, expired (90 days unused) or password changed. Sign in again.
			if (body.error === "invalid_grant") {
				delete all[id]
				await save()
				return null
			}
			throw new Error(
				`Microsoft token refresh failed: ${body.error_description ?? body.error}`,
			)
		}
		const updated: Account = {
			...current,
			accessToken: String(body.access_token),
			refreshToken: String(body.refresh_token ?? current.refreshToken),
			expiresAt: Date.now() + Number(body.expires_in) * 1000,
		}
		all[id] = updated
		await save()
		return updated
	})()
	refreshing.set(id, task)
	task.finally(() => refreshing.delete(id)).catch(() => {})
	return task
}

export async function disconnect(person: Person): Promise<boolean> {
	const all = await load()
	const had = key(person) in all
	delete all[key(person)]
	await save()
	return had
}

export async function status(settings: Settings, person: Person) {
	const found = await account(settings, person)
	if (!found)
		return "Not connected. Run `ado connect` to send them a sign-in link."
	return [
		`Connected as ${found.name || found.email} (${found.email}).`,
		`Organizations: ${found.organizations.join(", ") || "none"}.`,
		found.defaultOrganization
			? `Default organization: ${found.defaultOrganization}.`
			: "No default organization; pass --org or run `ado use <org>`.",
	].join("\n")
}

export async function useOrganization(
	settings: Settings,
	person: Person,
	organization: string,
) {
	const found = await account(settings, person)
	if (!found) return null
	const match = found.organizations.find(
		org => org.toLowerCase() === organization.toLowerCase(),
	)
	if (!match) return false
	found.defaultOrganization = match
	await save()
	return match
}

export type AdoRequest = {
	method?: string
	/** A full URL on an Azure DevOps host, or a path under https://dev.azure.com/<org>/. */
	path: string
	organization?: string
	body?: unknown
}

type Result = { status: number; text: string }
const notConnected: Result = {
	status: 409,
	text: "Not connected to Azure DevOps. Run `ado connect` to send them a sign-in link.",
}

/** The request's URL, checked to be an Azure DevOps API over https, or why it isn't. */
function resolve(found: Account, input: AdoRequest): URL | Result {
	let url: URL
	if (/^[a-z][a-z0-9+.-]*:/i.test(input.path)) url = new URL(input.path)
	else {
		const organization = input.organization ?? found.defaultOrganization
		if (!organization)
			return {
				status: 400,
				text: `Which organization? Pass --org (one of: ${found.organizations.join(", ")}).`,
			}
		url = new URL(
			`https://dev.azure.com/${encodeURIComponent(organization)}/${input.path.replace(/^\/+/, "")}`,
		)
	}
	if (url.protocol !== "https:" || !HOSTS.test(url.hostname))
		return {
			status: 400,
			text: `Not an Azure DevOps address: ${url.hostname}`,
		}
	if (!url.searchParams.has("api-version"))
		url.searchParams.set("api-version", API_VERSION)
	return url
}

/** Work item creates and updates take JSON Patch; everything else plain JSON. */
const isJsonPatch = (method: string, url: URL) =>
	(method === "PATCH" || method === "POST") &&
	/\/_apis\/wit\/workitems\/[^/]+$/i.test(url.pathname)

async function send(
	found: Account,
	method: string,
	url: URL,
	payload: unknown,
): Promise<Result> {
	// The `ado` command sends `"body": null` when there's none; a GET can't carry one.
	const body = payload ?? undefined
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${found.accessToken}`,
			accept: "application/json",
			...(body !== undefined
				? {
						"content-type": isJsonPatch(method, url)
							? "application/json-patch+json"
							: "application/json",
					}
				: {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		redirect: "manual",
	})
	// A sign-in page (a redirect, or HTML with 203) instead of JSON: the token wasn't accepted here.
	if (
		(response.status >= 300 && response.status < 400) ||
		response.headers.get("content-type")?.includes("text/html")
	)
		return {
			status: 401,
			text: `Azure DevOps didn't accept their sign-in for ${url.hostname}${url.pathname.split("/").slice(0, 2).join("/")}: they may not be a member of that organization, or it isn't connected to Microsoft Entra.`,
		}
	let text = await response.text()
	if (text.length > MAX_RESPONSE_BYTES)
		text = `${text.slice(0, MAX_RESPONSE_BYTES)}\n…[truncated: ${text.length} bytes; ask for fewer fields or use $top]`
	return { status: response.status, text }
}

/** Reads as the person: GET, or a POST to a query endpoint. Changes go through write(). */
export async function request(
	settings: Settings,
	person: Person,
	input: AdoRequest,
): Promise<Result> {
	const found = await account(settings, person)
	if (!found) return notConnected
	const method = (input.method ?? "GET").toUpperCase()
	const url = resolve(found, input)
	if (!(url instanceof URL)) return url
	if (
		method !== "GET" &&
		!(method === "POST" && READ_POSTS.test(url.pathname))
	)
		return {
			status: 403,
			text: "That changes something: use `ado update`, `ado comment`, `ado create` or `ado write`.",
		}
	return send(found, method, url, input.body)
}

// ── Changes ───────────────────────────────────────────────────────────────────────────────────

/** Makes a change as the person (POST, PATCH, PUT or DELETE) and says what happened. */
export async function write(
	settings: Settings,
	person: Person,
	input: AdoRequest & { summary?: string },
): Promise<Result> {
	const found = await account(settings, person)
	if (!found) return notConnected
	const method = (input.method ?? "PATCH").toUpperCase()
	if (!["POST", "PATCH", "PUT", "DELETE"].includes(method))
		return { status: 400, text: "Writes are POST, PATCH, PUT or DELETE." }
	const url = resolve(found, input)
	if (!(url instanceof URL)) return url
	const result = await send(found, method, url, input.body ?? undefined)
	const label = input.summary?.trim() || `${method} ${url.pathname}`
	console.log(
		`[azure-devops] ${person.teamId}-${person.userId}: ${label} → ${result.status}`,
	)
	if (result.status >= 200 && result.status < 300) {
		const link = (() => {
			try {
				return (
					JSON.parse(result.text) as {
						_links?: { html?: { href?: string } }
					}
				)._links?.html?.href
			} catch {
				return undefined
			}
		})()
		return {
			status: 200,
			text: `Done: ${label}${link ? `\nOpen: ${link}` : ""}`,
		}
	}
	const reason = (() => {
		try {
			return (JSON.parse(result.text) as { message?: string }).message
		} catch {
			return result.text.slice(0, 500)
		}
	})()
	return {
		status: result.status >= 400 ? result.status : 502,
		text: `Azure DevOps refused it (HTTP ${result.status}): ${reason?.replace(/\.+$/, "")}. Nothing changed.`,
	}
}

export { SignInError }
