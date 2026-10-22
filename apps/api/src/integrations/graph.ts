/**
 * Microsoft 365 through Microsoft Graph (Outlook, Calendar, OneDrive, SharePoint, Teams,
 * Planner), per person, through their Microsoft connection (microsoft.ts). The `ms` command in
 * their container asks the bot API to make requests as the person asking; reads and changes run
 * directly, and changes are logged.
 */
import * as microsoft from "./microsoft"

type Settings = microsoft.Settings
type Person = microsoft.Person

const GRAPH = "https://graph.microsoft.com"
const MAX_RESPONSE_BYTES = 400_000
export const MAX_FILE_BYTES = 100 * 1024 * 1024
/** Request headers `ms` may set: time zone and immutable IDs, advanced queries, Planner ETags. */
const PASSED_HEADERS = ["prefer", "consistencylevel", "if-match"]

export type GraphRequest = {
	method?: string
	/** A path under https://graph.microsoft.com/v1.0/ ("me/messages"), "beta/…", or a full Graph URL. */
	path: string
	body?: unknown
	headers?: Record<string, string>
}

type Result = { status: number; text: string }

function resolve(path: string): URL | Result {
	const url = /^https?:/i.test(path)
		? new URL(path)
		: new URL(
				/^(v1\.0|beta)\//.test(path.replace(/^\/+/, ""))
					? `${GRAPH}/${path.replace(/^\/+/, "")}`
					: `${GRAPH}/v1.0/${path.replace(/^\/+/, "")}`,
			)
	if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com")
		return {
			status: 400,
			text: `Not a Microsoft Graph address: ${url.hostname}`,
		}
	return url
}

async function token(
	settings: Settings,
	person: Person,
): Promise<string | Result> {
	try {
		return (
			(await microsoft.accessToken(settings, person, "graph")) ?? {
				status: 409,
				text: microsoft.notConnected("graph"),
			}
		)
	} catch (error) {
		if (error instanceof microsoft.ConsentError)
			return { status: 409, text: error.message }
		throw error
	}
}

const headersFrom = (given: Record<string, string> = {}) =>
	Object.fromEntries(
		Object.entries(given).filter(([name]) =>
			PASSED_HEADERS.includes(name.toLowerCase()),
		),
	)

/** Graph's error message, for people: "Access is denied…" rather than the JSON around it. */
function reason(text: string): string {
	try {
		const parsed = JSON.parse(text) as {
			error?: { code?: string; message?: string }
		}
		const { code, message } = parsed.error ?? {}
		if (code || message) return [code, message].filter(Boolean).join(": ")
	} catch {}
	return text.slice(0, 500)
}

/**
 * Any Graph request as the person. Changes (anything but GET) are logged. A 403 is retried once
 * with a fresh token: permissions added to the app since the cached one was minted apply then.
 */
export async function request(
	settings: Settings,
	person: Person,
	input: GraphRequest,
	retried = false,
): Promise<Result> {
	const accessToken = await token(settings, person)
	if (typeof accessToken !== "string") return accessToken
	const url = resolve(input.path)
	if (!(url instanceof URL)) return url
	const method = (input.method ?? "GET").toUpperCase()
	const body = input.body ?? undefined
	const response = await fetch(url, {
		method,
		headers: {
			...headersFrom(input.headers),
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
			...(body !== undefined
				? { "content-type": "application/json" }
				: {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	})
	let text = await response.text()
	if (method !== "GET")
		console.log(
			`[graph] ${person.teamId}-${person.userId}: ${method} ${url.pathname} → ${response.status}`,
		)
	if (response.status === 403 && !retried) {
		await microsoft.forgetToken(person, "graph")
		return request(settings, person, input, true)
	}
	if (!response.ok) {
		const hint =
			response.status === 403
				? ". They may not have approved this permission yet: run `ms connect` so they sign in again and approve it. If it keeps failing, the app lacks this Microsoft Graph permission (the person running laddu adds it in Entra) or they don't have access."
				: ""
		return {
			status: response.status,
			text: `Microsoft Graph refused it (HTTP ${response.status}): ${reason(text)}${hint}`,
		}
	}
	if (!text) text = `Done (HTTP ${response.status}).`
	if (text.length > MAX_RESPONSE_BYTES)
		text = `${text.slice(0, MAX_RESPONSE_BYTES)}\n…[truncated: ${text.length} bytes; use $select, $top or $filter]`
	return { status: response.status, text }
}

/** A file's bytes (e.g. drive item `/content`), as the person. */
export async function download(
	settings: Settings,
	person: Person,
	path: string,
): Promise<Response> {
	const accessToken = await token(settings, person)
	if (typeof accessToken !== "string")
		return Response.json(
			{ ok: false, text: accessToken.text },
			{ status: accessToken.status },
		)
	const url = resolve(path)
	if (!(url instanceof URL))
		return Response.json(
			{ ok: false, text: url.text },
			{ status: url.status },
		)
	// Graph answers with a redirect to a short-lived, pre-signed download URL.
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok)
		return Response.json(
			{
				ok: false,
				text: `Microsoft Graph refused it (HTTP ${response.status}): ${reason(await response.text())}`,
			},
			{ status: response.status },
		)
	const size = Number(response.headers.get("content-length") ?? 0)
	if (size > MAX_FILE_BYTES)
		return Response.json(
			{
				ok: false,
				text: `That file is ${Math.round(size / 1e6)} MB; the limit is ${MAX_FILE_BYTES / 1e6} MB.`,
			},
			{ status: 413 },
		)
	return new Response(response.body, {
		headers: {
			"content-type":
				response.headers.get("content-type") ??
				"application/octet-stream",
		},
	})
}

/** Uploads bytes to a Graph path such as `me/drive/root:/Reports/q3.xlsx:/content`, as the person. */
export async function upload(
	settings: Settings,
	person: Person,
	path: string,
	data: ArrayBuffer,
	contentType: string,
): Promise<Result> {
	if (data.byteLength > MAX_FILE_BYTES)
		return { status: 413, text: `Files up to ${MAX_FILE_BYTES / 1e6} MB.` }
	const accessToken = await token(settings, person)
	if (typeof accessToken !== "string") return accessToken
	const url = resolve(path)
	if (!(url instanceof URL)) return url
	// Small files go in one request; bigger ones through an upload session, in chunks.
	if (data.byteLength <= 4 * 1024 * 1024) {
		const response = await fetch(url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": contentType,
			},
			body: data,
		})
		const text = await response.text()
		console.log(
			`[graph] ${person.teamId}-${person.userId}: upload ${url.pathname} → ${response.status}`,
		)
		return response.ok
			? { status: 200, text }
			: {
					status: response.status,
					text: `Upload refused (HTTP ${response.status}): ${reason(text)}`,
				}
	}
	const sessionUrl = new URL(
		url.toString().replace(/:\/content$/, ":/createUploadSession"),
	)
	const created = await fetch(sessionUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			item: { "@microsoft.graph.conflictBehavior": "replace" },
		}),
	})
	if (!created.ok)
		return {
			status: created.status,
			text: `Upload refused (HTTP ${created.status}): ${reason(await created.text())}`,
		}
	const { uploadUrl } = (await created.json()) as { uploadUrl: string }
	const chunk = 5 * 320 * 1024 * 4 // 6.25 MiB, a multiple of 320 KiB as Graph requires
	let last: Response | null = null
	for (let start = 0; start < data.byteLength; start += chunk) {
		const end = Math.min(start + chunk, data.byteLength)
		// The pre-signed upload URL takes no Authorization header.
		last = await fetch(uploadUrl, {
			method: "PUT",
			headers: {
				"content-range": `bytes ${start}-${end - 1}/${data.byteLength}`,
			},
			body: data.slice(start, end),
		})
		if (!last.ok && last.status !== 202)
			return {
				status: last.status,
				text: `Upload failed at byte ${start} (HTTP ${last.status}): ${reason(await last.text())}`,
			}
	}
	console.log(
		`[graph] ${person.teamId}-${person.userId}: upload ${url.pathname} (${data.byteLength} bytes) → ${last?.status}`,
	)
	return { status: 200, text: (await last?.text()) ?? "" }
}
