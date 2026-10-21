/**
 * `bun run login` — one-time Sign in with ChatGPT (with plan usage) for the bot.
 *
 * OAuth + PKCE with a loopback callback on 127.0.0.1. On a server without a browser, open the
 * link on any device and paste back the address the browser ends on. `slack-dot setup` uses
 * signIn() for the same flow.
 */
import { createRemoteJWKSet, jwtVerify } from "jose"
import { appName, paths } from "../config"
import {
	applyTokenResponse,
	AUTH_ISSUER,
	AUTHORIZE_URL,
	getHostId,
	hasPlanUsage,
	JWKS_URL,
	loadCredentials,
	RESOURCE,
	saveCredentials,
	SCOPES,
	TOKEN_URL,
	type Credentials,
	type TokenResponse,
} from "./siwc"

const PREFERRED_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const REGISTRATION_CLIENT_ID = "dynamic_agent_client"

/** Random hex string; hex is a valid alphabet for state, nonce and the PKCE verifier. */
const randomToken = (bytes = 32) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte =>
		byte.toString(16).padStart(2, "0"),
	).join("")

function pkce() {
	const verifier = randomToken(48) // 96 chars, within PKCE's 43–128
	const challenge = new Bun.CryptoHasher("sha256")
		.update(verifier)
		.digest("base64url")
	return { verifier, challenge }
}

function openBrowser(url: string) {
	const opener = Bun.which("xdg-open") ?? Bun.which("open")
	// No opener on a headless box; the URL is printed anyway.
	if (opener) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" })
}

type Callback = { code: string; issuedClientId: string | null }

/** The sign-in result from the callback URL, whether it reached our server or was pasted. */
function readCallback(url: URL, state: string): Callback {
	const error = url.searchParams.get("error")
	if (error)
		throw new Error(
			`Authorization failed: ${error} ${url.searchParams.get("error_description") ?? ""}`,
		)
	const code = url.searchParams.get("code")
	if (url.searchParams.get("state") !== state || !code)
		throw new Error("That isn't the address from this sign-in")
	return { code, issuedClientId: url.searchParams.get("client_id") }
}

function listen(state: string): { port: number; callback: Promise<Callback> } {
	let resolve!: (value: Callback) => void
	let reject!: (error: Error) => void
	const callback = new Promise<Callback>(
		(res, rej) => ((resolve = res), (reject = rej)),
	)

	const handler = (request: Request) => {
		const url = new URL(request.url)
		if (url.pathname !== CALLBACK_PATH)
			return new Response("Not found", { status: 404 })
		try {
			resolve(readCallback(url, state))
			return new Response(
				"Signed in. You can close this tab and go back to the terminal.",
			)
		} catch (error) {
			reject(error as Error)
			return new Response("Sign-in failed. You can close this tab.", {
				status: 400,
			})
		}
	}

	let server
	try {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: PREFERRED_PORT,
			fetch: handler,
		})
	} catch {
		// Only the port may change between sign-ins; scheme, host and path must not.
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
	}
	callback.finally(() => setTimeout(() => server.stop(), 500)).catch(() => {})
	return { port: server.port!, callback }
}

/**
 * The callback, pasted: on a server, the browser is on another device and its redirect to
 * 127.0.0.1 fails there, but the address bar still holds the code. Keeps asking until a line is
 * a valid callback address; stops when the signal aborts.
 */
async function pastedCallback(
	readLine: ReadLine,
	state: string,
	signal: AbortSignal,
): Promise<Callback> {
	while (true) {
		const line = (await readLine(signal)).trim()
		if (!line) continue
		try {
			if (!URL.canParse(line)) throw new Error("That isn't an address")
			return readCallback(new URL(line), state)
		} catch (error) {
			console.log(
				`${(error as Error).message}. Paste the full address from the browser's address bar.`,
			)
		}
	}
}

async function exchangeCode(
	clientId: string,
	code: string,
	verifier: string,
	redirectUri: string,
) {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
			resource: RESOURCE,
		}),
	})
	const body = await response.json().catch(() => ({}))
	if (!response.ok)
		throw new Error(
			`Code exchange failed (${response.status}): ${JSON.stringify(body)}`,
		)
	return body as TokenResponse
}

async function verifyIdToken(idToken: string, clientId: string, nonce: string) {
	const { payload } = await jwtVerify(
		idToken,
		createRemoteJWKSet(new URL(JWKS_URL)),
		{
			issuer: AUTH_ISSUER,
			audience: clientId,
		},
	)
	if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch")
	return {
		sub: payload.sub!,
		email: payload.email as string | undefined,
		name: payload.name as string | undefined,
	}
}

export type Model = { slug: string; name?: string }

/** Models the plan can use; empty if the list isn't available. */
export async function listModels(accessToken: string): Promise<Model[]> {
	const response = await fetch(`${RESOURCE}/models`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) return []
	const body = (await response.json()) as Record<string, unknown>
	const entries = (
		Array.isArray(body.data)
			? body.data
			: Array.isArray(body.models)
				? body.models
				: []
	) as {
		slug?: string
		id?: string
		display_name?: string
		visibility?: string
	}[]
	return entries
		.filter(model => !model.visibility || model.visibility === "list")
		.flatMap(model => {
			const slug = model.slug ?? model.id
			return slug ? [{ slug, name: model.display_name }] : []
		})
}

/** Reads one line from the terminal; a pending read ends (rejects) when the signal aborts. */
export type ReadLine = (signal: AbortSignal) => Promise<string>

/**
 * Signs in with ChatGPT and saves the credentials to DATA_DIR. The browser can be on this machine
 * (the loopback callback finishes it) or anywhere else (the person pastes the address it ends on).
 */
export async function signIn(readLine: ReadLine): Promise<Credentials> {
	const hostId = await getHostId()
	const saved = await loadCredentials()
	const firstRegistration = !saved?.client_id

	const state = randomToken()
	const nonce = randomToken()
	const { verifier, challenge } = pkce()
	const { port, callback } = listen(state)
	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

	const params = new URLSearchParams({
		client_id: saved?.client_id ?? REGISTRATION_CLIENT_ID,
		ext_agent_host_id: hostId,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES,
		resource: RESOURCE,
		state,
		nonce,
		code_challenge_method: "S256",
		code_challenge: challenge,
	})
	if (firstRegistration) params.set("agent_name_hint", appName)
	// URLSearchParams encodes spaces as "+"; the authorize endpoint expects %20.
	const authorizeUrl = `${AUTHORIZE_URL}?${params.toString().replaceAll("+", "%20")}`

	console.log("Sign in with ChatGPT. Open this in a browser on any device:\n")
	console.log(`  ${authorizeUrl}\n`)
	console.log(
		"Allow ChatGPT plan usage when asked; the bot can't run without it.",
	)
	console.log(
		`If the browser isn't on this machine, it ends on a page that won't load (127.0.0.1:${port}).\nCopy that page's full address and paste it here:`,
	)
	openBrowser(authorizeUrl)

	const pasting = new AbortController()
	const { code, issuedClientId } = await Promise.race([
		callback,
		pastedCallback(readLine, state, pasting.signal),
	]).finally(() => pasting.abort())
	const clientId = saved?.client_id ?? issuedClientId
	if (!clientId)
		throw new Error(
			"The callback did not include an issued client_id; cannot finish registration.",
		)

	// Persist the registration before the exchange so a failed exchange can be retried with it.
	let credentials: Credentials = { ...saved, client_id: clientId }
	await saveCredentials(credentials)

	const tokens = await exchangeCode(clientId, code, verifier, redirectUri)
	credentials = applyTokenResponse(credentials, tokens)
	if (tokens.id_token)
		credentials.account = await verifyIdToken(
			tokens.id_token,
			clientId,
			nonce,
		)
	await saveCredentials(credentials)

	console.log(
		`\nSigned in as ${credentials.account?.email ?? credentials.account?.sub ?? "unknown"}.`,
	)
	if (!hasPlanUsage(credentials))
		throw new Error(
			"Plan usage was NOT granted, so the bot can't call models. Sign in again and allow it.",
		)
	return credentials
}

/** Lines typed on stdin, one reader for the whole process. */
function stdinLines(): ReadLine {
	const reader = Bun.stdin
		.stream()
		.pipeThrough(new TextDecoderStream())
		.getReader()
	let buffer = ""
	return async signal => {
		while (!buffer.includes("\n")) {
			signal.throwIfAborted()
			const aborted = new Promise<never>((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			)
			const { value, done } = await Promise.race([reader.read(), aborted])
			if (done) return new Promise<never>(() => {})
			buffer += value
		}
		const line = buffer.slice(0, buffer.indexOf("\n"))
		buffer = buffer.slice(buffer.indexOf("\n") + 1)
		return line
	}
}

if (import.meta.main) {
	const credentials = await signIn(stdinLines())
	console.log(`Credentials saved to ${paths.auth}`)
	const models = await listModels(credentials.access_token!)
	if (!models.length)
		console.log(
			"\nCould not list models. Check docs/SETUP.md for picking CODEX_MODEL.",
		)
	else {
		console.log("\nModels available on your plan (set one as CODEX_MODEL):")
		for (const model of models)
			console.log(
				`  ${model.slug}${model.name ? `  (${model.name})` : ""}`,
			)
	}
	// stdin is still being read for a pasted address.
	process.exit(0)
}
