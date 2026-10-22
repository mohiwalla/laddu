/**
 * One Microsoft connection per person, shared by Azure DevOps (`ado`) and Microsoft 365 through
 * Microsoft Graph (`ms`: Outlook, Calendar, OneDrive, SharePoint, Teams, Planner).
 *
 * Each person signs in with Microsoft's device code flow: laddu DMs them a code for
 * microsoft.com/devicelogin, polls until they approve, and keeps the tokens here, on the host
 * (never in a container). A sign-in is only accepted when the Microsoft account's email matches
 * the person's Slack email, so nobody can link someone else's account to their own laddu by getting
 * them to enter a code. Entra refresh tokens work for every API the app has consent for, so one
 * sign-in serves both; a token per API is minted from it on demand.
 */
import type { App } from "@slack/bolt"
import { decodeJwt } from "jose"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate } from "../files"
import { userEmail } from "../slack/context"

type WebClient = App["client"]
export type Settings = NonNullable<BotConfig["microsoft"]>
export type Person = { teamId: string; userId: string }

/** The APIs laddu calls, by Entra resource. A token request names one of them. */
export const RESOURCES = {
	graph: "https://graph.microsoft.com/.default",
	devops: "499b84ac-1321-427f-aa17-267ca6975798/.default",
} as const
export type Resource = keyof typeof RESOURCES
const SIGN_IN_SCOPES = "offline_access openid profile email"
/**
 * What a sign-in asks for. `.default` alone only prompts on someone's first consent to the app, so
 * Graph permissions added later would never be offered; naming them prompts for whatever they
 * haven't approved yet. The names come from MICROSOFT_GRAPH_SCOPES, so a tenant whose policy blocks
 * some of them for regular users can leave those out. Admin-only ones (ChannelMessage.Read.All)
 * shouldn't be named: once an admin grants them, refreshes (which use `.default`) pick them up.
 */
const signInScopes = (settings: Settings, resource: Resource) =>
	resource === "graph"
		? settings.graphScopes
				.map(scope => `https://graph.microsoft.com/${scope}`)
				.join(" ")
		: RESOURCES.devops
const LABELS: Record<Resource, string> = {
	graph: "Microsoft 365 (Outlook, Calendar, OneDrive, SharePoint, Teams, Planner)",
	devops: "Azure DevOps",
}
const COMMANDS: Record<Resource, string> = { graph: "ms", devops: "ado" }

export type Account = {
	refreshToken: string
	tokens: Partial<
		Record<Resource, { accessToken: string; expiresAt: number }>
	>
	name: string
	email: string
	/** Azure DevOps organizations, found at its sign-in. */
	devops?: { organizations: string[]; defaultOrganization?: string }
}

const file = `${paths.dataDir}/microsoft.json`
/** Before Microsoft 365, connections were Azure DevOps only. */
const legacyFile = `${paths.dataDir}/azure-devops.json`
let accounts: Record<string, Account> | null = null
const key = (person: Person) => `${person.teamId}-${person.userId}`

type LegacyAccount = {
	accessToken: string
	refreshToken: string
	expiresAt: number
	name: string
	email: string
	organizations: string[]
	defaultOrganization?: string
}

async function load(): Promise<Record<string, Account>> {
	if (accounts) return accounts
	const saved = await readJson<Record<string, Account>>(file)
	if (saved) return (accounts = saved)
	const legacy = await readJson<Record<string, LegacyAccount>>(legacyFile)
	accounts = Object.fromEntries(
		Object.entries(legacy ?? {}).map(([id, old]) => [
			id,
			{
				refreshToken: old.refreshToken,
				tokens: {
					devops: {
						accessToken: old.accessToken,
						expiresAt: old.expiresAt,
					},
				},
				name: old.name,
				email: old.email,
				devops: {
					organizations: old.organizations,
					defaultOrganization: old.defaultOrganization,
				},
			},
		]),
	)
	if (legacy) {
		await writeJsonPrivate(file, accounts)
		await Bun.file(legacyFile).delete()
	}
	return accounts
}

export async function save(): Promise<void> {
	await writeJsonPrivate(file, await load())
}

export class SignInError extends Error {}
/** The app isn't consented for this API yet, for this person or the whole organization. */
export class ConsentError extends Error {}

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

async function getJson(url: string, accessToken: string) {
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
	return (await response.json()) as Record<string, unknown>
}

/** More about the account from the API just signed in to: emails, and DevOps organizations. */
async function discover(resource: Resource, accessToken: string) {
	if (resource === "graph") {
		const me = await getJson(
			"https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails",
			accessToken,
		)
		return {
			emails: [
				me.mail,
				me.userPrincipalName,
				...((me.otherMails as []) ?? []),
			]
				.filter((value): value is string => typeof value === "string")
				.map(value => value.toLowerCase()),
		}
	}
	const vssps = "https://app.vssps.visualstudio.com/_apis"
	const profile = await getJson(
		`${vssps}/profile/profiles/me?api-version=7.1`,
		accessToken,
	)
	const list = await getJson(
		`${vssps}/accounts?memberId=${profile.id}&api-version=7.1`,
		accessToken,
	)
	return {
		emails: [String(profile.emailAddress ?? "").toLowerCase()].filter(
			Boolean,
		),
		organizations: ((list.value as { accountName: string }[]) ?? [])
			.map(account => account.accountName)
			.sort(),
	}
}

/** The sign-in each person is waiting on; a newer one replaces it (its poll then stops quietly). */
const signingIn = new Map<string, string>()

/**
 * Starts a device code sign-in for one API (consenting to it if needed): DMs the code, then polls
 * in the background and DMs the outcome. Returns what to tell Codex (never the code itself).
 */
export async function connect(
	settings: Settings,
	client: WebClient,
	person: Person,
	resource: Resource,
): Promise<string> {
	const id = key(person)
	const started = await entra(settings, "devicecode", {
		scope: `${signInScopes(settings, resource)} ${SIGN_IN_SCOPES}`,
	})
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
		`${signingIn.has(id) ? "New code (the earlier one no longer works). " : ""}To connect ${LABELS[resource]}, open ${verification_uri}, enter *${user_code}* and sign in with your work account (approve the permissions if Microsoft asks). The code works for ${Math.round(expires_in / 60)} minutes. If you didn't ask for this, ignore it.`,
	)
	signingIn.set(id, device_code)
	const current = () => signingIn.get(id) === device_code
	void poll(
		settings,
		client,
		person,
		resource,
		device_code,
		interval,
		expires_in,
		current,
	)
		.then(message => (message ? dm(message) : undefined))
		.catch(error => {
			if (!current()) return
			console.warn("[microsoft] sign-in failed:", error)
			return dm(
				`Microsoft sign-in didn't finish: ${error instanceof SignInError ? error.message : "something went wrong on my side"}. Ask me to connect again to retry.`,
			)
		})
		.finally(() => {
			if (current()) signingIn.delete(id)
		})
	return `Sent them a Microsoft sign-in link and code in a DM with laddu. Once they approve it, ${LABELS[resource]} is connected and laddu confirms in that DM; then ask again.`
}

async function poll(
	settings: Settings,
	client: WebClient,
	person: Person,
	resource: Resource,
	deviceCode: string,
	interval: number,
	expiresIn: number,
	current: () => boolean,
): Promise<string | null> {
	const deadline = Date.now() + expiresIn * 1000
	let wait = interval
	while (Date.now() < deadline) {
		await Bun.sleep(wait * 1000)
		// Replaced by a newer sign-in: stop without a message (that one reports).
		if (!current()) return null
		const { ok, body } = await entra(settings, "token", {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: deviceCode,
		})
		if (ok) return finishSignIn(client, person, resource, body)
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
	resource: Resource,
	tokens: Record<string, unknown>,
): Promise<string> {
	const { name, emails } = identities(tokens)
	const accessToken = String(tokens.access_token)
	const found = await discover(resource, accessToken)
	for (const email of found.emails) emails.add(email)
	const slackEmail = await userEmail(client, person.userId)
	if (slackEmail && !emails.has(slackEmail.toLowerCase()))
		throw new SignInError(
			`that Microsoft account (${[...emails][0] ?? "unknown"}) isn't the one on your Slack profile (${slackEmail}), so I didn't connect it`,
		)
	const all = await load()
	const previous = all[key(person)]
	const account: Account = {
		// The newest refresh token covers everything consented so far, this API included.
		refreshToken: String(tokens.refresh_token),
		tokens: {
			...previous?.tokens,
			[resource]: {
				accessToken,
				expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
			},
		},
		name: name || previous?.name || "",
		email: slackEmail?.toLowerCase() || [...emails][0] || "",
		devops:
			"organizations" in found && found.organizations
				? {
						organizations: found.organizations,
						defaultOrganization:
							previous?.devops?.defaultOrganization ??
							(found.organizations.length === 1
								? found.organizations[0]
								: undefined),
					}
				: previous?.devops,
	}
	all[key(person)] = account
	await save()
	const extra =
		resource === "devops"
			? account.devops?.organizations.length
				? ` Organizations: ${account.devops.organizations.join(", ")}.`
				: " Your account isn't in any Azure DevOps organization yet."
			: ""
	return `:white_check_mark: ${LABELS[resource]} connected as ${account.name || account.email}.${extra} Ask me again in the conversation where you started.`
}

const refreshing = new Map<string, Promise<string | null>>()

/**
 * An access token for the API, minted from the person's refresh token when needed. Null when
 * they aren't connected; ConsentError when the app isn't approved for that API yet.
 */
export async function accessToken(
	settings: Settings,
	person: Person,
	resource: Resource,
): Promise<string | null> {
	const id = key(person)
	const current = (await load())[id]
	if (!current) return null
	const cached = current.tokens[resource]
	if (cached && cached.expiresAt - Date.now() > 5 * 60_000)
		return cached.accessToken
	// One refresh at a time per person: each one rotates the refresh token.
	const pendingKey = `${id}:${resource}`
	const pending = refreshing.get(pendingKey)
	if (pending) return pending
	const task = (async () => {
		await Promise.all(
			[...refreshing.entries()]
				.filter(
					([other]) =>
						other.startsWith(`${id}:`) && other !== pendingKey,
				)
				.map(([, other]) => other.catch(() => null)),
		)
		const latest = (await load())[id]
		if (!latest) return null
		const { ok, body } = await entra(settings, "token", {
			grant_type: "refresh_token",
			refresh_token: latest.refreshToken,
			scope: `${RESOURCES[resource]} offline_access`,
		})
		if (!ok) {
			const description = String(body.error_description ?? body.error)
			// AADSTS65001: no consent for this API yet (it was added after they signed in).
			if (/AADSTS65001|consent_required/i.test(description))
				throw new ConsentError(
					`laddu isn't approved for ${LABELS[resource]} on their account yet. Run \`${COMMANDS[resource]} connect\` so they can sign in and approve it (or an admin grants consent for the app in Microsoft Entra).`,
				)
			// Revoked, expired (90 days unused) or password changed: sign in again.
			if (body.error === "invalid_grant") {
				const all = await load()
				delete all[id]
				await save()
				return null
			}
			throw new Error(`Microsoft token refresh failed: ${description}`)
		}
		latest.refreshToken = String(body.refresh_token ?? latest.refreshToken)
		latest.tokens[resource] = {
			accessToken: String(body.access_token),
			expiresAt: Date.now() + Number(body.expires_in) * 1000,
		}
		await save()
		return latest.tokens[resource]!.accessToken
	})()
	refreshing.set(pendingKey, task)
	task.finally(() => refreshing.delete(pendingKey)).catch(() => {})
	return task
}

/** Drops the cached token for an API, so the next request mints one with current permissions. */
export async function forgetToken(person: Person, resource: Resource) {
	const found = (await load())[key(person)]
	if (found?.tokens[resource]) {
		delete found.tokens[resource]
		await save()
	}
}

export async function account(person: Person): Promise<Account | null> {
	return (await load())[key(person)] ?? null
}

export async function disconnect(person: Person): Promise<boolean> {
	const all = await load()
	const had = key(person) in all
	delete all[key(person)]
	await save()
	return had
}

export const notConnected = (resource: Resource) =>
	`Not connected to ${LABELS[resource]}. Run \`${COMMANDS[resource]} connect\` to send them a sign-in link.`

/** Connection status for one API, checking that a token can actually be had. */
export async function status(
	settings: Settings,
	person: Person,
	resource: Resource,
): Promise<string> {
	const found = await account(person)
	if (!found) return notConnected(resource)
	try {
		if (!(await accessToken(settings, person, resource)))
			return notConnected(resource)
	} catch (error) {
		return error instanceof ConsentError ? error.message : String(error)
	}
	return `Connected to ${LABELS[resource]} as ${found.name || found.email} (${found.email}).`
}
