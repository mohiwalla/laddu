/**
 * dot's computer, from the bot's side. The desktop itself (display, XFCE, the tools Codex drives it
 * with) is runtime/desktop, in each person's container. This file:
 *
 * - signs links that open a person's desktop in their browser, to watch it or to take control;
 * - runs the gateway those links point to: it serves KasmVNC's web viewer from that person's
 *   container with the matching login. "watch" can only look, which the VNC server itself
 *   enforces; "drive" can use the mouse and keyboard. Nothing in a container is published.
 * - stops desktops nobody has used or watched for a while (files and browser logins stay).
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { writePrivate } from "../files"
import {
	CONTAINER_HOME,
	CONTAINER_TOOLS_DIR,
	DESKTOP_VIEWER_PORT,
	ensureContainer,
} from "./containers"

type WebClient = App["client"]
export type DesktopMode = "watch" | "drive"
type Owner = { teamId: string; userId: string }
type Grant = Owner & { mode: DesktopMode }

const LINK_HOURS = 12
const COOKIE = "dot_desktop"
/** runtime/desktop in the container; a function, as containers.ts imports this module indirectly. */
const desktop = () => `${CONTAINER_TOOLS_DIR}/desktop`

// ---- links ---------------------------------------------------------------------------------

/** Kept on disk so links sent before a restart keep working until they expire. */
const keyFile = `${paths.dataDir}/desktop-link-key`
let linkKey: string | null = null

async function key(): Promise<string> {
	if (linkKey) return linkKey
	const file = Bun.file(keyFile)
	if (await file.exists()) linkKey = (await file.text()).trim()
	else {
		linkKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("")
		await writePrivate(keyFile, linkKey)
	}
	return linkKey
}

const sign = async (payload: string) =>
	new Bun.CryptoHasher("sha256", await key())
		.update(payload)
		.digest("base64url")

/** Constant-time comparison, so response timing doesn't leak how much of a signature was right. */
function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let difference = 0
	for (let i = 0; i < a.length; i++)
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return difference === 0
}

async function grantToken(grant: Grant): Promise<string> {
	const expires = Date.now() + LINK_HOURS * 3_600_000
	const payload = [grant.teamId, grant.userId, grant.mode, expires].join(".")
	return `${payload}.${await sign(payload)}`
}

async function verify(token: string | null | undefined): Promise<Grant | null> {
	const parts = token?.split(".") ?? []
	if (parts.length !== 5) return null
	const [teamId, userId, mode, expires, signature] = parts as [
		string,
		string,
		string,
		string,
		string,
	]
	if (!sameString(signature, await sign(parts.slice(0, 4).join("."))))
		return null
	if (Number(expires) < Date.now()) return null
	if (mode !== "watch" && mode !== "drive") return null
	return { teamId, userId, mode }
}

export async function desktopLinks(config: BotConfig, owner: Owner) {
	const base = config.desktopViewer.publicUrl
	return {
		watch: `${base}/open/${await grantToken({ ...owner, mode: "watch" })}`,
		drive: `${base}/open/${await grantToken({ ...owner, mode: "drive" })}`,
	}
}

/**
 * Posts the person's links where only they can see them (ephemeral), in the conversation they're
 * in. Never in the thread itself: anyone there could open them.
 */
export async function sendDesktopLinks(
	client: WebClient,
	config: BotConfig,
	target: Owner & { channel: string; threadTs?: string },
	lead = "I'm using my computer for this.",
): Promise<void> {
	const links = await desktopLinks(config, target)
	await client.chat.postEphemeral({
		channel: target.channel,
		user: target.userId,
		thread_ts: target.threadTs,
		text: `:desktop_computer: ${lead} <${links.watch}|Watch it live> · <${links.drive}|Take control> (just for you; valid ${LINK_HOURS} hours)`,
	})
}

// ---- gateway -------------------------------------------------------------------------------

type Upstream = {
	container: string
	ip: string
	logins: Record<DesktopMode, string>
}
const upstreams = new Map<string, { value: Upstream; at: number }>()
const UPSTREAM_CACHE_MS = 30_000

/** The person's container with its desktop running: its address and viewer logins. */
async function upstream(
	config: BotConfig,
	owner: Owner,
	fresh = false,
): Promise<Upstream> {
	const ownerKey = `${owner.teamId}/${owner.userId}`
	const cached = upstreams.get(ownerKey)
	if (!fresh && cached && Date.now() - cached.at < UPSTREAM_CACHE_MS)
		return cached.value
	const container = await ensureContainer(config, owner.teamId, owner.userId)
	await Bun.$`docker exec ${container} ${desktop()} start`.quiet()
	const ip = (
		await Bun.$`docker inspect --format ${"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"} ${container}`.text()
	).trim()
	const logins = JSON.parse(
		await Bun.$`docker exec ${container} cat ${`${CONTAINER_HOME}/.desktop/viewer.json`}`.text(),
	) as Record<DesktopMode, string>
	const value = { container, ip, logins }
	upstreams.set(ownerKey, { value, at: Date.now() })
	return value
}

/** Open viewer connections per container, and when the last one closed (for the idle check). */
const viewers = new Map<string, number>()
const lastViewed = new Map<string, number>()

type Socket = {
	url: string
	auth: string
	protocol?: string
	container: string
	backend?: WebSocket
	queue: (string | ArrayBuffer | Uint8Array)[]
}

const page = (status: number, text: string) =>
	new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>dot's computer</title><body style="font:16px system-ui;margin:3em auto;max-width:32em;padding:0 1em">${text}</body>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8" } },
	)

function cookie(request: Request, name: string): string | undefined {
	for (const part of request.headers.get("cookie")?.split(";") ?? []) {
		const [key, ...value] = part.trim().split("=")
		if (key === name) return value.join("=")
	}
}

export function startDesktopGateway(config: BotConfig): void {
	const { host, port, publicUrl } = config.desktopViewer
	const secure = publicUrl.startsWith("https:")

	const serve = () =>
		Bun.serve<Socket>({
			hostname: host,
			port,
			async fetch(request, server) {
				const url = new URL(request.url)
				const opened = url.pathname.match(/^\/open\/([^/]+)$/)
				if (opened) {
					const token = opened[1]!
					if (!(await verify(token)))
						return page(
							403,
							"This link has expired. Ask dot in Slack for a new one.",
						)
					// The viewer's requests (page, assets, its websocket) carry this instead of the link.
					return new Response(null, {
						status: 303,
						headers: {
							// Viewer settings: threaded decoding uses the browser's ImageDecoder, which fails
						// on some frames ("Failed to decode frame at index 0"); and scale the fixed-size
						// desktop to the window, where the default asks the desktop to resize, which it
						// refuses (coordinates must hold), and then sometimes stretches it.
						location: "/?enable_threading=false&resize=scale",
							"set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINK_HOURS * 3600}${secure ? "; Secure" : ""}`,
							"cache-control": "no-store",
						},
					})
				}

				const grant = await verify(cookie(request, COOKIE))
				if (!grant)
					return page(
						401,
						"Open your computer from the link dot sent you in Slack.",
					)

				const forward = async (target: Upstream) => {
					const auth = `Basic ${btoa(`${grant.mode}:${target.logins[grant.mode]}`)}`
					const path = `${url.pathname}${url.search}`
					if (
						request.headers.get("upgrade")?.toLowerCase() ===
						"websocket"
					) {
						// The cookie alone isn't enough for a websocket: a page on another site (or another
						// localhost port) could open one with it. Only the viewer served from here may.
						const origin = request.headers.get("origin")
						if (origin && origin !== new URL(publicUrl).origin)
							return new Response("wrong origin", { status: 403 })
						const protocol = request.headers
							.get("sec-websocket-protocol")
							?.split(",")[0]
							?.trim()
						const upgraded = server.upgrade(request, {
							data: {
								url: `ws://${target.ip}:${DESKTOP_VIEWER_PORT}${path}`,
								auth,
								protocol,
								container: target.container,
								queue: [],
							},
							headers: protocol
								? { "sec-websocket-protocol": protocol }
								: undefined,
						})
						return upgraded
							? undefined
							: new Response("upgrade failed", { status: 400 })
					}
					const headers = new Headers(request.headers)
					headers.set("authorization", auth)
					headers.set("accept-encoding", "identity")
					headers.delete("host")
					headers.delete("cookie")
					return fetch(
						`http://${target.ip}:${DESKTOP_VIEWER_PORT}${path}`,
						{
							method: request.method,
							headers,
							body: request.body,
							redirect: "manual",
						},
					)
				}

				try {
					return await forward(await upstream(config, grant))
				} catch {
					// Stopped since it was cached (idle), or the container was recreated: start it again.
					try {
						return await forward(
							await upstream(config, grant, true),
						)
					} catch (error) {
						console.warn("[desktop] viewer failed", error)
						return page(
							502,
							"Couldn't start your computer. Try again in a moment.",
						)
					}
				}
			},
			websocket: {
				open(socket) {
					const { data } = socket
					viewers.set(
						data.container,
						(viewers.get(data.container) ?? 0) + 1,
					)
					// Bun's client takes headers, which the browser's can't: the login stays on this side.
					const backend = new WebSocket(data.url, {
						// KasmVNC refuses websockets without an Origin.
						headers: {
							authorization: data.auth,
							origin: new URL(data.url.replace(/^ws/, "http"))
								.origin,
						},
						protocols: data.protocol ? [data.protocol] : [],
					} as unknown as string[])
					backend.binaryType = "arraybuffer"
					backend.onopen = () => {
						for (const message of data.queue) backend.send(message)
						data.queue = []
					}
					backend.onmessage = event =>
						socket.send(event.data as string | ArrayBuffer)
					backend.onclose = () => socket.close()
					backend.onerror = () => socket.close()
					data.backend = backend
				},
				message(socket, message) {
					const { backend, queue } = socket.data
					if (backend?.readyState === WebSocket.OPEN)
						backend.send(message)
					else queue.push(message)
				},
				close(socket) {
					const { data } = socket
					data.backend?.close()
					viewers.set(
						data.container,
						Math.max(0, (viewers.get(data.container) ?? 1) - 1),
					)
					lastViewed.set(data.container, Date.now())
				},
			},
		})
	try {
		serve()
	} catch (error) {
		// Most likely another bot process (another workspace) has the port: dot still works, but
		// its links won't open. Each workspace needs its own DESKTOP_VIEWER_PORT.
		console.warn(
			`[desktop] couldn't start the viewer gateway on ${host}:${port}; links won't open (set DESKTOP_VIEWER_PORT):`,
			error instanceof Error ? error.message : error,
		)
		return
	}
	console.log(
		`[desktop] viewer gateway on ${host}:${port} (links: ${publicUrl})`,
	)
}

// ---- idle desktops -------------------------------------------------------------------------

/** Stops desktops with no actions and no viewers for DESKTOP_IDLE_MINUTES. */
export function startDesktopReaper(config: BotConfig): void {
	const idleMs = config.desktopIdleMinutes * 60_000
	if (idleMs <= 0) return
	setInterval(async () => {
		const listing =
			await Bun.$`docker ps --filter label=dot.bot=1 --format ${"{{.Names}}"}`
				.quiet()
				.nothrow()
				.text()
		for (const name of listing.split("\n").filter(Boolean)) {
			if (viewers.get(name)) continue
			if (Date.now() - (lastViewed.get(name) ?? 0) < idleMs) continue
			const status = await Bun.$`docker exec ${name} ${desktop()} status`
				.quiet()
				.nothrow()
				.text()
			const idle = Number(status.match(/idle (\d+)s/)?.[1] ?? -1)
			if (idle * 1000 < idleMs) continue
			await Bun.$`docker exec ${name} ${desktop()} stop`.quiet().nothrow()
			console.log(
				`[desktop] stopped ${name}'s desktop (idle ${Math.round(idle / 60)} min)`,
			)
		}
	}, 60_000)
}
