/**
 * dot's computer, from the bot's side. The desktop itself (display, XFCE, the tools Codex drives it
 * with) is runtime/desktop, in each person's container. This file:
 *
 * - signs links that open a person's desktop in their browser (one link, sent only to them);
 * - runs the gateway those links point to: it serves KasmVNC's web viewer from that person's
 *   container, logged in on this side (the login never reaches the browser). The page is
 *   view-only until the person takes control, by interacting with the screen or Take over, and
 *   dot's actions wait until they return it (VIEWER_CONTROL, runtime/desktop `control`).
 *   Nothing in a container is published.
 * - stops desktops nobody has used or watched for a while (files and browser logins stay).
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate, writePrivate } from "../files"
import {
	CONTAINER_HOME,
	CONTAINER_TOOLS_DIR,
	DESKTOP_VIEWER_PORT,
	ensureContainer,
} from "./containers"

type WebClient = App["client"]
/** The VNC server's two logins (runtime/desktop): look only, or also mouse and keyboard. */
type DesktopMode = "watch" | "drive"
type Owner = { teamId: string; userId: string }

const LINK_HOURS = 12
const COOKIE = "dot_desktop"

/**
 * Changes to KasmVNC's viewer page (GPL/MPL; its files are left as they are, the page is restyled
 * as it's served):
 * - Size. The viewer sizes the desktop to the box it's drawn in, which fills the window, and asks
 *   the desktop to match; the desktop keeps its fixed size (coordinates must hold), and the viewer
 *   then sometimes stretches it over the window. A box capped at the desktop's own size
 *   (runtime/desktop's screen), centred, shows it at actual size; the viewer measures the box, so
 *   clicks still map.
 * - Branding. Its title, tab icon, loading screen, splash image, side toolbar and toasts
 *   are replaced or hidden: people are looking at dot's computer, not at a VNC product.
 * - Take control / Hand back to dot (VIEWER_CONTROL), like OpenAI's dots.
 */
const VIEWER_STYLE = [
	// The desktop: rounded, in a slim dark bezel that always has its exact shape (16:10, never
	// larger than actual size), floating on a dim spotlight. Room underneath for the pill.
	":root{--dot-w:min(1280px,calc(100vw - 48px),calc((100vh - 150px) * 1.6))}",
	"body{background:radial-gradient(ellipse 70% 60% at 50% 45%,#2e2e31 0%,#1d1d1f 70%,#161618 100%)!important;font-family:Inter,system-ui,sans-serif}",
	"#noVNC_container{box-sizing:content-box;position:fixed;inset:auto;left:50%;top:calc(50% - 22px);transform:translate(-50%,-50%);z-index:1;width:var(--dot-w);height:calc(var(--dot-w) / 1.6);max-width:none;max-height:none;margin:0;padding:8px;border-radius:15px;background:#111113;border:1px solid rgba(255,255,255,.07);box-shadow:0 30px 80px -20px rgba(0,0,0,.75),0 12px 30px -10px rgba(0,0,0,.5);overflow:visible!important}",
	"#noVNC_container>div:not([id^=dot_]){border-radius:10px;overflow:hidden!important;background:transparent!important}",
	"#noVNC_container canvas{border-radius:10px}",
	// While the person has control: a solid coral outline around the bezel, faded in.
	"#noVNC_container::before{content:'';position:absolute;inset:-4px;border-radius:19px;border:4px solid #ff5a2a;box-shadow:0 0 36px rgba(255,90,42,.28);opacity:0;transition:opacity .3s ease;pointer-events:none}",
	":root.dot_in_control #noVNC_container::before{opacity:1}",
	// The person's own cursor, always: the desktop has none of its own (runtime/desktop), and the
	// viewer would otherwise hide theirs over the screen or draw a stand-in that follows it. dot's
	// is drawn where dot's pointer really is (#dot_cursor). Nothing they do reaches the desktop
	// until they take control.
	"#noVNC_container canvas{cursor:default!important}",
	"canvas[style*='65535']{display:none!important}",
	// dot's cursor: always the same coral arrow with its name, gliding between positions, a ripple
	// on each click and "typing…" while it types. Hidden while the person has control.
	"#dot_cursor{position:absolute;left:0;top:0;z-index:3;pointer-events:none;opacity:0;transition:transform .55s cubic-bezier(.22,.9,.3,1),opacity .25s ease;will-change:transform}",
	"#dot_cursor.seen{opacity:1}",
	":root.dot_in_control #dot_cursor{opacity:0!important}",
	"#dot_cursor svg{display:block;margin:-2px 0 0 -2px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:transform .12s ease}",
	"#dot_cursor.press svg{transform:scale(.8)}",
	"#dot_cursor b{position:absolute;left:15px;top:17px;padding:2px 7px 3px;border-radius:6px;background:#ff5a2a;color:#fff;font:600 11px/1.3 Inter,system-ui,sans-serif;letter-spacing:normal;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35)}",
	"#dot_cursor.typing b::after{content:' · typing…';font-weight:500}",
	"#dot_cursor i{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;border:2px solid #ff5a2a;animation:dot_ripple .6s ease-out forwards}",
	"@keyframes dot_ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.5);opacity:0}}",
	// The pill, floating under the screen: dot's face and state, and the action.
	"#dot_control{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:16px;z-index:2;display:flex;align-items:center;gap:11px;padding:6px 6px 6px 7px;border-radius:999px;background:rgba(24,24,27,.8);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);border:1px solid rgba(255,255,255,.09);box-shadow:0 12px 32px rgba(0,0,0,.5);color:#f4f4f5;font:500 13.5px/1.25 Inter,system-ui,sans-serif;letter-spacing:-.005em;white-space:nowrap;transition:border-color .35s}",
	":root.dot_in_control #dot_control{border-color:rgba(255,122,89,.5)}",
	"#dot_control>*{animation:dot_in .32s cubic-bezier(.2,.8,.2,1) both}",
	"@keyframes dot_in{from{opacity:0;transform:translateY(4px)}}",
	".dot_face{width:30px;height:30px;border-radius:50%;object-fit:cover;flex:none}",
	".dot_face.small{width:15px;height:15px;vertical-align:-3px;margin-right:4px}",
	".dot_you{width:30px;height:30px;border-radius:50%;flex:none;display:grid;place-items:center;background:linear-gradient(135deg,#ff6a3d,#ff3d6e)}",
	".dot_text{display:flex;flex-direction:column;gap:1px;padding-right:2px}",
	".dot_text b{font-weight:650;margin-right:.3em}",
	".dot_sub{font-size:11.5px;font-weight:450;color:#a1a1aa}",
	".dot_live{display:inline-block;width:6px;height:6px;margin-left:7px;border-radius:50%;background:#ff5a2a;vertical-align:2px;box-shadow:0 0 0 0 rgba(255,90,42,.6);animation:dot_ping 1.8s ease-out infinite}",
	"@keyframes dot_ping{70%,100%{box-shadow:0 0 0 7px rgba(255,90,42,0)}}",
	"#dot_control button{border:0;border-radius:999px;padding:9px 15px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;background:#fafafa;color:#111;transition:transform .15s ease,filter .2s}",
	"#dot_control button:hover{transform:translateY(-1px);filter:brightness(1.06)}",
	"#dot_control button.give{background:linear-gradient(135deg,#ff6a3d,#ff3d6e);color:#fff}",
	// Hovering the screen while dot has control: how to take over.
	"#dot_hint{position:absolute;top:20px;left:50%;transform:translate(-50%,-6px);z-index:2;padding:7px 12px;border-radius:999px;background:rgba(17,17,19,.74);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);color:#f4f4f5;font:500 12.5px Inter,system-ui,sans-serif;letter-spacing:normal;opacity:0;transition:opacity .25s ease,transform .25s ease;pointer-events:none}",
	":root.noVNC_connected:not(.dot_in_control) #noVNC_container:hover #dot_hint{opacity:1;transform:translate(-50%,0);transition-delay:.35s}",
	":root:not(.noVNC_connected) #dot_control{display:none}",
	"@media (prefers-reduced-motion:reduce){.dot_live,#dot_control>*,#dot_cursor i{animation:none}#dot_cursor{transition:opacity .25s ease}}",
	// The loading screen (KasmVNC's logo on white): dot bobbing on dark instead, and our words while
	// connecting; other states ("Disconnected"…) keep the viewer's text.
	"#noVNC_transition{z-index:10;background:#292929!important;color:#e6e6e6!important;flex-direction:column;align-items:center;justify-content:center;gap:28px;font-family:Inter,system-ui,sans-serif}",
	"#noVNC_transition::before{content:'';width:128px;height:128px;background:url(/_dot/dot-256.png) center/contain no-repeat;animation:dot_bob 1.6s ease-in-out infinite}",
	"@keyframes dot_bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}",
	"#noVNC_transition .noVNC_spinner{display:none}",
	"#noVNC_transition_text{margin:0!important;font-size:1.15rem!important}",
	".noVNC_loading #noVNC_transition_text,:root.noVNC_connecting #noVNC_transition_text{font-size:0!important;letter-spacing:0!important;display:block!important;text-align:center}",
	".noVNC_loading #noVNC_transition_text::before,:root.noVNC_connecting #noVNC_transition_text::before{content:'dot';font-size:1.15rem;font-weight:700;letter-spacing:.8px}",
	".noVNC_loading #noVNC_transition_text::after,:root.noVNC_connecting #noVNC_transition_text::after{content:'’s computer is loading…';font-size:1.15rem;letter-spacing:.8px}",
	// The side toolbar (keys, clipboard, settings, disconnect…) and its logo, the toast naming the
	// stream mode on connect ("JPEG/WEBP (Images)") and routine status banners ("Connected
	// (encrypted) to x11"): nobody needs them here. Warnings and errors still show.
	"#noVNC_control_bar_anchor,#noVNC_control_bar_hint,.noVNC_logo,#noVNC_notification_overlay,#noVNC_status.noVNC_status_normal{display:none!important}",
].join("")
const VIEWER_ICON = "/_dot/dot-64.png"
const VIEWER_FONT =
	'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap">'

/** dot's picture for the viewer (tab icon, loading screen), served without a link: nothing private. */
const ASSETS = Bun.fileURLToPath(new URL("../../assets/", import.meta.url))
const ASSET_NAMES = new Set(["dot-64.png", "dot-256.png", "home-banner.png"])

/** The viewer retitles the tab once connected ("x11 - KasmVNC"); this puts it back. */
const VIEWER_TITLE = `<script>new MutationObserver(() => { if (document.title !== "dot's computer") document.title = "dot's computer" }).observe(document.querySelector("title"), { childList: true, characterData: true, subtree: true })</script>`

/**
 * Taking control, on the same connection: the page starts view-only (the viewer's own setting, so
 * nothing it sends reaches the desktop) and turns that off the moment the person clicks on the
 * screen or presses Take over; clicking outside the screen, leaving the tab or window, or Give back
 * turns it back on. While they have control the page tells the bot
 * every 10 s (/_dot/control), and dot's actions wait (runtime/desktop `control`).
 */
const VIEWER_CONTROL = `<script>addEventListener("DOMContentLoaded", () => {
	const root = document.documentElement
	const box = document.getElementById("noVNC_container")
	const viewOnly = document.getElementById("noVNC_setting_view_only")
	const make = (id, html = "") => Object.assign(document.createElement("div"), { id, innerHTML: html })
	const bar = make("dot_control")
	box.append(bar, make("dot_hint", "Click to take over"))
	const face = small => '<img class="dot_face' + (small ? " small" : "") + '" src="/_dot/dot-64.png" alt="">'
	const pointer = '<span class="dot_you"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M5 3l14 7.5-6.2 1.6L10 18.5z"/></svg></span>'
	let mine = false
	let beat = 0
	const tell = on => fetch("/_dot/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }), keepalive: true }).catch(() => {})
	const render = () => {
		root.classList.toggle("dot_in_control", mine)
		bar.innerHTML = mine
			? pointer + '<span class="dot_text"><span><b>You’re</b>in control</span><span class="dot_sub">' + face(true) + "dot is waiting</span></span>" + '<button class="give">Give back</button>'
			: face() + '<span class="dot_text"><span><b>dot</b>is in control<i class="dot_live"></i></span><span class="dot_sub">You’re watching live</span></span>' + "<button>Take over</button>"
	}
	const set = on => {
		if (on === mine) return
		mine = on
		viewOnly.checked = !on
		viewOnly.dispatchEvent(new Event("change"))
		clearInterval(beat)
		if (on) beat = setInterval(() => tell(true), 10000)
		tell(on)
		render()
	}
	// The screen itself, not its bezel or the pill.
	const onScreen = target => box.contains(target) && !bar.contains(target) && target !== box
	// Only a click on the screen takes control (capture phase, before the viewer's own handlers, so
	// that click also lands); clicking anywhere else gives it back.
	addEventListener("pointerdown", event => {
		if (bar.contains(event.target)) return
		set(onScreen(event.target))
	}, true)
	bar.addEventListener("click", event => { if (event.target.closest("button")) set(!mine) })
	addEventListener("blur", () => set(false))
	addEventListener("pagehide", () => set(false))
	document.addEventListener("visibilitychange", () => { if (document.hidden) set(false) })
	render()

	// dot's cursor, from the desktop's events (/_dot/events): where its pointer is, and what it does.
	const cursor = make("dot_cursor", '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2l6.6 17.2 2.7-7.3 7.4-2.7z" fill="#ff5a2a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><b>dot</b>')
	box.append(cursor)
	let at = null
	let typing = 0
	const screen = () => [...box.querySelectorAll("canvas")].find(canvas => canvas.width > 100)
	const place = () => {
		const canvas = screen()
		if (!at) return
		// The first position can come before the screen is drawn.
		if (!canvas || !canvas.getBoundingClientRect().width) return void setTimeout(place, 200)
		const r = canvas.getBoundingClientRect()
		const b = box.getBoundingClientRect()
		const scale = r.width / canvas.width
		cursor.style.transform = "translate(" + (r.left - b.left - box.clientLeft + at.x * scale) + "px," + (r.top - b.top - box.clientTop + at.y * scale) + "px)"
		cursor.classList.add("seen")
	}
	const events = new EventSource("/_dot/events")
	events.onmessage = message => {
		const event = JSON.parse(message.data)
		if (event.x !== undefined) {
			at = { x: event.x, y: event.y }
			place()
		}
		if (event.t === "click") {
			cursor.classList.add("press")
			setTimeout(() => cursor.classList.remove("press"), 140)
			cursor.append(document.createElement("i"))
			setTimeout(() => cursor.querySelector("i")?.remove(), 650)
		}
		if (event.t === "type") {
			cursor.classList.add("typing")
			clearTimeout(typing)
			typing = setTimeout(() => cursor.classList.remove("typing"), 1400)
		}
	}
	addEventListener("resize", place)
	new ResizeObserver(place).observe(box)
})</script>`

function viewerPage(html: string): string {
	return html
		.replace(/<title>[^<]*<\/title>/, "<title>dot's computer</title>")
		.replace(/<link[^>]*kasm_logo[^>]*>/g, "")
		.replace(
			"</head>",
			`<link rel="icon" href="${VIEWER_ICON}">${VIEWER_FONT}<style>${VIEWER_STYLE}</style>${VIEWER_TITLE}${VIEWER_CONTROL}</head>`,
		)
}

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

async function grantToken(owner: Owner): Promise<string> {
	const expires = Date.now() + LINK_HOURS * 3_600_000
	const payload = [owner.teamId, owner.userId, expires].join(".")
	return `${payload}.${await sign(payload)}`
}

async function verify(token: string | null | undefined): Promise<Owner | null> {
	const parts = token?.split(".") ?? []
	if (parts.length !== 4) return null
	const [teamId, userId, expires, signature] = parts as [
		string,
		string,
		string,
		string,
	]
	if (!sameString(signature, await sign(parts.slice(0, 3).join("."))))
		return null
	if (Number(expires) < Date.now()) return null
	return { teamId, userId }
}

export async function desktopLink(
	config: BotConfig,
	owner: Owner,
): Promise<string> {
	return `${config.desktopViewer.publicUrl}/open/${await grantToken(owner)}`
}

// ---- where people find their link ---------------------------------------------------------

/**
 * dot's Home tab in Slack (private to each person) is where the link lives: redrawn with a fresh
 * one every time they open it, and whenever dot uses the computer for them. Threads only get a
 * note the first time someone's dot uses its computer, so links don't pile up in every thread.
 */
/** Whether their computer is on, without creating a container for someone who never used dot. */
async function computerStatus(owner: Owner): Promise<string> {
	const container = (
		await Bun.$`docker ps --filter label=dot.bot=1 --filter ${`label=dot.team=${owner.teamId}`} --filter ${`label=dot.user=${owner.userId}`} --format ${"{{.Names}}"}`
			.quiet()
			.nothrow()
			.text()
	).trim()
	if (!container)
		return ":white_circle:  Not set up yet: it starts the first time I need it"
	const status = await Bun.$`docker exec ${container} ${desktop()} status`
		.quiet()
		.nothrow()
		.text()
	const idle = Number(status.match(/idle (\d+)s/)?.[1] ?? -1)
	if (!status.startsWith("running"))
		return ":zzz:  Asleep: it wakes up when I need it"
	if (idle < 0 || idle < 60)
		return ":large_green_circle:  On, in use right now"
	const minutes = Math.round(idle / 60)
	return `:large_green_circle:  On, last used ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago`
}

export async function publishHome(
	client: WebClient,
	config: BotConfig,
	owner: Owner,
): Promise<void> {
	if (!config.desktop) {
		await client.views.publish({
			user_id: owner.userId,
			view: {
				type: "home",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "Ask me anything in a DM, or tag me in a channel.",
						},
					},
				],
			},
		})
		return
	}
	const [link, status] = await Promise.all([
		desktopLink(config, owner),
		computerStatus(owner),
	])
	// Slack fetches images itself, so only with a public address: a banner with the title larger
	// than any Slack text (assets/home-banner.png; bump ?v when it changes, Slack caches it).
	const banner = config.desktopViewer.publicUrl.startsWith("https:")
		? `${config.desktopViewer.publicUrl}/_dot/home-banner.png?v=1`
		: null
	// Three levels: large headings, bold step titles with a number emoji, small grey details.
	const step = (number: number, title: string, detail: string) => [
		{
			type: "section" as const,
			text: {
				type: "mrkdwn" as const,
				text: `${[":one:", ":two:", ":three:"][number - 1]}  *${title}*`,
			},
		},
		{
			type: "context" as const,
			elements: [{ type: "mrkdwn" as const, text: detail }],
		},
	]
	await client.views.publish({
		user_id: owner.userId,
		view: {
			type: "home",
			blocks: [
				banner
					? {
							type: "image",
							image_url: banner,
							alt_text:
								"dot's computer: your own desktop, where I work for you",
						}
					: {
							type: "header",
							text: {
								type: "plain_text",
								text: "dot's computer",
							},
						},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `I browse, fill in forms and use apps here for you, and you can watch or step in at any time.\n\n${status}`,
					},
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "open_computer",
							text: {
								type: "plain_text",
								text: ":desktop_computer:  Open dot's computer",
								emoji: true,
							},
							url: link,
						},
					],
				},
				{ type: "divider" },
				{
					type: "header",
					text: { type: "plain_text", text: "How it works" },
				},
				...step(
					1,
					"Watch",
					"Open your computer and see what I'm doing, live.",
				),
				...step(
					2,
					"Take over",
					"Click the screen. I pause until you're done.",
				),
				...step(
					3,
					"Give back",
					"Click outside the screen, or press *Give back*.",
				),
				{ type: "divider" },
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: ":lock:  Only you can open it",
						},
						{
							type: "mrkdwn",
							text: `:zzz:  Sleeps after ${config.desktopIdleMinutes} min unused; files and logins stay`,
						},
					],
				},
			],
		},
	})
}

/** People who've had the note about their computer: `{ "team/user": ISO date }`. */
const introducedFile = `${paths.dataDir}/desktop-introduced.json`

/**
 * dot started using its computer for someone: their Home tab gets a fresh link, and the very
 * first time, the thread gets a note (only they see it) saying where to find it.
 */
export async function computerInUse(
	client: WebClient,
	config: BotConfig,
	target: Owner & { channel: string; threadTs?: string },
): Promise<void> {
	await publishHome(client, config, target).catch(error =>
		console.warn("[desktop] couldn't update the Home tab", error),
	)
	const key = `${target.teamId}/${target.userId}`
	const introduced =
		(await readJson<Record<string, string>>(introducedFile)) ?? {}
	if (introduced[key]) return
	await sendDesktopLink(
		client,
		config,
		target,
		"I have my own computer and I'm using it for this.",
		"Watch me or take over anytime from my *Home* tab (open my profile → Home); it always has a fresh link.",
	)
	await writeJsonPrivate(introducedFile, {
		...introduced,
		[key]: new Date().toISOString(),
	})
}

/**
 * Posts the person's link where only they can see it (ephemeral), in the conversation they're in.
 * Never in the thread itself: anyone there could open it.
 */
export async function sendDesktopLink(
	client: WebClient,
	config: BotConfig,
	target: Owner & { channel: string; threadTs?: string },
	lead = "Here's my computer.",
	after = `Take over from there when you need to (just for you; valid ${LINK_HOURS} hours, and my *Home* tab always has a fresh link).`,
): Promise<void> {
	const link = await desktopLink(config, target)
	await client.chat.postEphemeral({
		channel: target.channel,
		user: target.userId,
		thread_ts: target.threadTs,
		text: `:desktop_computer: ${lead} <${link}|Watch it live>. ${after}`,
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

/**
 * The page reports when the person takes or returns control, and every 10 s while they have it;
 * runtime/desktop treats 30 s without word as returned, so a closed tab or a bot restart can't
 * leave dot waiting. dot's actions wait meanwhile.
 */
const tellControl = (container: string, on: boolean) =>
	Bun.$`docker exec ${container} ${desktop()} control ${on ? "on" : "off"}`
		.quiet()
		.nothrow()

/**
 * dot's pointer and actions for the page's dot cursor (VIEWER_CONTROL), as server-sent events:
 * one `desktop events` process per container, shared by everyone watching it, and stopped when
 * the last page goes.
 */
type Feed = {
	process: ReturnType<typeof Bun.spawn>
	pages: Set<ReadableStreamDefaultController<Uint8Array>>
	/** The latest position, for pages that join later (it's only sent when it changes). */
	at?: Uint8Array
}
const feeds = new Map<string, Feed>()
const encoder = new TextEncoder()

function follow(
	container: string,
	page: ReadableStreamDefaultController<Uint8Array>,
): void {
	let feed = feeds.get(container)
	if (!feed) {
		const process = Bun.spawn(
			["docker", "exec", container, desktop(), "events"],
			{ stdout: "pipe", stderr: "ignore" },
		)
		const started: Feed = { process, pages: new Set() }
		feeds.set(container, started)
		void (async () => {
			let rest = ""
			for await (const chunk of process.stdout as ReadableStream<Uint8Array>) {
				rest += new TextDecoder().decode(chunk)
				const lines = rest.split("\n")
				rest = lines.pop() ?? ""
				for (const line of lines)
					if (line.startsWith('{"t": "at"'))
						started.at = encoder.encode(`data: ${line}\n\n`)
				const message = encoder.encode(
					lines.map(line => `data: ${line}\n\n`).join(""),
				)
				for (const each of started.pages) each.enqueue(message)
			}
			if (feeds.get(container) === started) feeds.delete(container)
		})()
		feed = started
	}
	feed.pages.add(page)
	if (feed.at) page.enqueue(feed.at)
}

function unfollow(
	container: string,
	page: ReadableStreamDefaultController<Uint8Array>,
): void {
	const feed = feeds.get(container)
	if (!feed) return
	feed.pages.delete(page)
	if (feed.pages.size) return
	feeds.delete(container)
	feed.process.kill()
}

function eventStream(container: string): Response {
	let page: ReadableStreamDefaultController<Uint8Array>
	let ping: ReturnType<typeof setInterval>
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			page = controller
			follow(container, page)
			// Keeps proxies and tunnels from closing a quiet stream.
			ping = setInterval(
				() => controller.enqueue(encoder.encode(": ping\n\n")),
				15_000,
			)
		},
		cancel() {
			clearInterval(ping)
			unfollow(container, page)
		},
	})
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			"x-accel-buffering": "no",
		},
	})
}

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

/**
 * dot's web address: the desktop viewer, and `slackOAuth` (Slack's redirect back after someone
 * connects their Slack account) at /slack/oauth. Started for either.
 */
export function startDesktopGateway(
	config: BotConfig,
	slackOAuth?: (request: Request) => Promise<Response>,
): void {
	const { host, port, publicUrl } = config.desktopViewer
	const secure = publicUrl.startsWith("https:")

	const serve = () =>
		Bun.serve<Socket>({
			hostname: host,
			port,
			// The events stream stays open as long as the page does.
			idleTimeout: 0,
			async fetch(request, server) {
				const url = new URL(request.url)
				if (url.pathname === "/slack/oauth" && slackOAuth)
					return slackOAuth(request)
				if (!config.desktop)
					return new Response("not found", { status: 404 })
				const asset = url.pathname.match(/^\/_dot\/([^/]+)$/)?.[1]
				if (asset && ASSET_NAMES.has(asset))
					return new Response(Bun.file(`${ASSETS}${asset}`), {
						headers: { "cache-control": "public, max-age=86400" },
					})
				const opened = url.pathname.match(/^\/open\/([^/]+)$/)
				if (opened) {
					const token = opened[1]!
					if (!(await verify(token)))
						return page(
							403,
							"This link has expired. Open dot’s Home tab in Slack for a fresh one.",
						)
					// The viewer's requests (page, assets, its websocket) carry this instead of the link.
					return new Response(null, {
						status: 303,
						headers: {
							// Threaded decoding uses the browser's ImageDecoder, which fails on some frames
							// ("Failed to decode frame at index 0"); the plain image path doesn't. View-only
							// until the person takes control (VIEWER_CONTROL). Scaled down to fit the frame on
							// small screens; viewerPage() caps it at actual size.
							location:
								"/?enable_threading=false&view_only=true&resize=scale",
							"set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINK_HOURS * 3600}${secure ? "; Secure" : ""}`,
							"cache-control": "no-store",
						},
					})
				}

				const grant = await verify(cookie(request, COOKIE))
				if (!grant)
					return page(
						401,
						"Open dot’s computer from dot’s Home tab in Slack.",
					)

				const websocket =
					request.headers.get("upgrade")?.toLowerCase() ===
					"websocket"
				// The cookie alone isn't enough for a websocket or a control change: a page on another
				// site (or another localhost port) could send one with it. Only the viewer served here may.
				const origin = request.headers.get("origin")
				if (
					(websocket || request.method === "POST") &&
					origin !== new URL(publicUrl).origin
				)
					return new Response("wrong origin", { status: 403 })

				if (
					url.pathname === "/_dot/control" &&
					request.method === "POST"
				) {
					const { on } = (await request.json().catch(() => ({}))) as {
						on?: boolean
					}
					const target = await upstream(config, grant).catch(
						() => null,
					)
					if (!target) return new Response(null, { status: 502 })
					await tellControl(target.container, on === true)
					return new Response(null, { status: 204 })
				}

				if (url.pathname === "/_dot/events") {
					const target = await upstream(config, grant).catch(
						() => null,
					)
					if (!target) return new Response(null, { status: 502 })
					return eventStream(target.container)
				}

				const forward = async (target: Upstream) => {
					// One login, which can use the mouse and keyboard: the link is only ever the person's
					// own, and the page keeps the viewer view-only until they take control.
					const auth = `Basic ${btoa(`drive:${target.logins.drive}`)}`
					const path = `${url.pathname}${url.search}`
					if (websocket) {
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
					const response = await fetch(
						`http://${target.ip}:${DESKTOP_VIEWER_PORT}${path}`,
						{
							method: request.method,
							headers,
							body: request.body,
							redirect: "manual",
						},
					)
					if (
						!response.headers
							.get("content-type")
							?.startsWith("text/html")
					)
						return response
					const html = viewerPage(await response.text())
					const sent = new Headers(response.headers)
					sent.delete("content-length")
					return new Response(html, {
						status: response.status,
						headers: sent,
					})
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
					// Nobody watching any more: nobody can be in control either.
					if (!viewers.get(data.container))
						void tellControl(data.container, false)
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
