/**
 * Azure DevOps (Boards, Repos, Pipelines…), per person: reads and changes, as them, through their
 * Microsoft connection (microsoft.ts). The `ado` command in their container asks the bot API to
 * make requests, signed with the turn's caller credential, so it can only act as the person asking.
 */
import * as microsoft from "./microsoft"

type Settings = microsoft.Settings
type Person = microsoft.Person

const API_VERSION = "7.1"
/** Hosts the `ado` command may reach. All of them are Azure DevOps services. */
const HOSTS =
	/^(dev\.azure\.com|[a-z0-9-]+\.dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com|app\.vssps\.visualstudio\.com)$/
/** The POST endpoints that only read: work item queries, batch reads and search. */
const READ_POSTS = /\/_apis\/(wit\/(wiql|workitemsbatch)|search\/)/i
const MAX_RESPONSE_BYTES = 400_000

/** What a request needs: the person's token and their organizations. */
type Session = {
	accessToken: string
	organizations: string[]
	defaultOrganization?: string
}

async function session(
	settings: Settings,
	person: Person,
): Promise<Session | null> {
	const token = await microsoft.accessToken(settings, person, "devops")
	if (!token) return null
	const found = await microsoft.account(person)
	return {
		accessToken: token,
		organizations: found?.devops?.organizations ?? [],
		defaultOrganization: found?.devops?.defaultOrganization,
	}
}

export async function status(settings: Settings, person: Person) {
	const line = await microsoft.status(settings, person, "devops")
	const found = await microsoft.account(person)
	if (!line.startsWith("Connected") || !found) return line
	const devops = found.devops
	return [
		line,
		`Organizations: ${devops?.organizations.join(", ") || "none found (run `ado connect` to look again)"}.`,
		devops?.defaultOrganization
			? `Default organization: ${devops.defaultOrganization}.`
			: "No default organization; pass --org or run `ado use <org>`.",
	].join("\n")
}

export async function useOrganization(
	settings: Settings,
	person: Person,
	organization: string,
) {
	if (!(await session(settings, person))) return null
	const found = await microsoft.account(person)
	const match = found?.devops?.organizations.find(
		org => org.toLowerCase() === organization.toLowerCase(),
	)
	if (!found?.devops || !match) return false
	found.devops.defaultOrganization = match
	await microsoft.save()
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
	text: microsoft.notConnected("devops"),
}

/** The request's URL, checked to be an Azure DevOps API over https, or why it isn't. */
function resolve(found: Session, input: AdoRequest): URL | Result {
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
	found: Session,
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
	const found = await session(settings, person)
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
	const found = await session(settings, person)
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
