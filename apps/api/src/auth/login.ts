/**
 * `bun run login` — one-time Sign in with ChatGPT (with plan usage) for the bot.
 *
 * Runs a loopback OAuth + PKCE flow on 127.0.0.1, so run it on a machine with a browser.
 * For a headless server, run it locally and copy .data/chatgpt-auth.json over SSH
 * (see docs/SETUP.md). The server keeps its own host ID and owns refreshes after that.
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

		const error = url.searchParams.get("error")
		if (error) {
			reject(
				new Error(
					`Authorization failed: ${error} ${url.searchParams.get("error_description") ?? ""}`,
				),
			)
			return new Response("Sign-in failed. You can close this tab.")
		}
		if (url.searchParams.get("state") !== state) {
			reject(new Error("State mismatch in OAuth callback"))
			return new Response("State mismatch. You can close this tab.", {
				status: 400,
			})
		}
		resolve({
			code: url.searchParams.get("code")!,
			issuedClientId: url.searchParams.get("client_id"),
		})
		return new Response(
			"Signed in. You can close this tab and go back to the terminal.",
		)
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

async function printModels(accessToken: string) {
	const response = await fetch(`${RESOURCE}/models`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) {
		console.log(
			`\nCould not list models (${response.status}). Check docs/SETUP.md for picking CODEX_MODEL.`,
		)
		return
	}
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
	const listed = entries.filter(
		model => !model.visibility || model.visibility === "list",
	)
	console.log("\nModels available on your plan (set one as CODEX_MODEL):")
	for (const model of listed)
		console.log(
			`  ${model.slug ?? model.id}${model.display_name ? `  (${model.display_name})` : ""}`,
		)
}

async function main() {
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

	console.log(
		"Opening your browser to sign in with ChatGPT. If it doesn't open, visit:\n",
	)
	console.log(`  ${authorizeUrl}\n`)
	console.log(
		"Allow ChatGPT plan usage when asked; the bot can't run without it.",
	)
	openBrowser(authorizeUrl)

	const { code, issuedClientId } = await callback
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
	console.log(`Credentials saved to ${paths.auth}`)
	if (!hasPlanUsage(credentials)) {
		throw new Error(
			"Plan usage was NOT granted, so the bot can't call models. Run `bun run login` again and allow it.",
		)
	}
	await printModels(credentials.access_token!)
}

await main()
