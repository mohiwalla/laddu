/**
 * dot's computer, from the bot's side. The desktop itself (display, XFCE, the tools Codex drives it
 * with) is runtime/desktop, in each person's container. This file:
 *
 * - signs links that open a person's desktop in their browser (one link, sent only to them);
 * - runs the gateway those links point to: it serves KasmVNC's web viewer from that person's
 *   container, logged in on this side (the login never reaches the browser). The page is
 *   view-only until the person takes control by clicking on the screen, and
 *   dot's actions wait until they return it (VIEWER_CONTROL, runtime/desktop `control`).
 *   Nothing in a container is published.
 * - stops desktops nobody has used or watched for a while (files and browser logins stay).
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate, writePrivate } from "../files"
import { refreshHome } from "../slack/home"
import {
	CONTAINER_HOME,
	CONTAINER_TOOLS_DIR,
	DESKTOP_VIEWER_PORT,
	ensureContainer,
	ownContainers,
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
 * - Size. The desktop fills the window, at the window's own size: the viewer asks the desktop to
 *   match it (VIEWER_CONTROL), and runtime/desktop keeps dot's coordinates right. Nothing else is
 *   drawn on it.
 * - Branding. Its title, tab icon, loading screen, splash image, side toolbar, banners and toasts
 *   are replaced or hidden: people are looking at dot's computer, not at a VNC product. When the
 *   connection ends, the page says so and offers to reconnect (VIEWER_CONTROL).
 * - Settings (VIEWER_SETTINGS) and taking control (VIEWER_CONTROL).
 */
/**
 * The page shown instead of the desktop when it can't be (these pages, and the viewer's own when
 * the connection ends): dot, then what happened and what to do, like dot's Home tab banner, on
 * the banner's flat #282828.
 */
const NOTE_STYLE = [
	".dot_screen{position:fixed;inset:0;display:grid;place-items:center;padding:32px;background:#282828;color:#a3a3a0;font:16px/1.5 Inter,system-ui,sans-serif;letter-spacing:normal;-webkit-font-smoothing:antialiased}",
	".dot_note{display:flex;align-items:center;gap:36px;max-width:720px}",
	".dot_note img{flex:none;width:152px;height:auto}",
	".dot_note h1{margin:0 0 8px;color:#f2f2f0;font-size:30px;font-weight:600;line-height:1.15;letter-spacing:-.02em}",
	".dot_note p{margin:0;max-width:30em}",
	".dot_button{display:inline-block;margin-top:24px;padding:10px 18px;border:0;border-radius:8px;background:#f2f2f0;color:#1f1f1f;font:600 15px/1.2 Inter,system-ui,sans-serif;text-decoration:none;cursor:pointer}",
	".dot_button:hover{background:#fff}",
	".dot_button:focus-visible{outline:2px solid #f2f2f0;outline-offset:3px}",
	".dot_note details{margin-top:20px;color:#76766f;font-size:14px}",
	".dot_note summary{width:max-content;cursor:pointer}",
	".dot_note summary:hover{color:#a3a3a0}",
	".dot_note details p{margin-top:6px;color:#a3a3a0;overflow-wrap:anywhere;white-space:pre-line}",
	"@media (max-width:560px){.dot_note{flex-direction:column;align-items:flex-start;gap:20px}.dot_note img{width:104px}.dot_note h1{font-size:25px}}",
].join("")
const VIEWER_STYLE = [
	NOTE_STYLE,
	// The desktop: the whole window, on dot's charcoal where its shape doesn't fill it.
	"html,body{background:#282828!important;font-family:Inter,system-ui,sans-serif}",
	"#noVNC_container{position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;background:#282828!important;overflow:hidden!important}",
	"#noVNC_container>div:not([id^=dot_]){background:transparent!important}",
	// The person's own cursor, always: the desktop has none of its own (runtime/desktop), and the
	// viewer would otherwise hide theirs over the screen or draw a stand-in that follows it. dot's
	// is drawn where dot's pointer really is (#dot_cursor). Nothing they do reaches the desktop
	// until they take control.
	"#noVNC_container canvas{cursor:default!important}",
	"canvas[style*='65535']{display:none!important}",
	// dot's cursor: Codex's arrow, moved by VIEWER_CONTROL (springs, not transitions), with a ripple
	// on each click. Hidden while the person has control, and whenever there's no desktop to draw it on.
	"#dot_cursor{position:absolute;left:0;top:0;z-index:3;pointer-events:none;opacity:0;transition:opacity .25s ease;will-change:transform}",
	// Turned and squashed about the tip, which is #dot_cursor's corner: the tip stays on dot's point.
	".dot_body{transform-origin:0 0;will-change:transform}",
	"#dot_cursor.appear .dot_body{animation:dot_appear .35s cubic-bezier(.2,.8,.3,1)}",
	"@keyframes dot_appear{from{scale:.4;filter:blur(5px)}}",
	"#dot_cursor.seen{opacity:1}",
	":root.dot_in_control #dot_cursor,:root:not(.noVNC_connected) #dot_cursor{opacity:0!important}",
	"#dot_cursor svg{display:block;margin:-4.15px 0 0 -4.15px;filter:drop-shadow(0 2px 6px rgba(15,40,90,.35));transition:transform .12s ease}",
	"#dot_cursor.press svg{transform:scale(.8)}",
	// When it first shows, a wiggle about its middle (VIEWER_CONTROL), so it's easy to find.
	"#dot_cursor svg{transform-origin:50% 50%}",
	"#dot_cursor.wiggle svg{animation:dot_wiggle .6s ease-in-out}",
	"@keyframes dot_wiggle{0%,100%{rotate:0deg}30%{rotate:-14deg}70%{rotate:14deg}}",
	"#dot_cursor i{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.9);animation:dot_ripple .6s ease-out forwards}",
	"@keyframes dot_ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.5);opacity:0}}",
	"@media (prefers-reduced-motion:reduce){#dot_cursor i,#dot_cursor.wiggle svg,#dot_cursor.appear .dot_body{animation:none}}",
	// Disconnected: what happened, over everything.
	"#dot_lost{display:none;z-index:20}",
	":root.noVNC_disconnected #dot_lost,:root.dot_failed #dot_lost{display:grid}",
	// The loading screen (KasmVNC's logo on white): dot bobbing on its charcoal instead, and our words.
	"#noVNC_transition{z-index:10;background:#282828!important;color:#a3a3a0!important;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Inter,system-ui,sans-serif}",
	"#noVNC_transition::before{content:'';width:152px;height:152px;background:url(/_dot/dot-mark.webp?v=2) center/contain no-repeat;animation:dot_bob 1.6s ease-in-out infinite}",
	"@media (prefers-reduced-motion:reduce){#noVNC_transition::before{animation:none}}",
	"@keyframes dot_bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}",
	"#noVNC_transition .noVNC_spinner{display:none}",
	"#noVNC_transition_text{margin:0!important;font-size:16px!important;letter-spacing:normal!important}",
	".noVNC_loading #noVNC_transition_text,:root.noVNC_connecting #noVNC_transition_text{font-size:0!important;display:block!important;text-align:center}",
	".noVNC_loading #noVNC_transition_text::after,:root.noVNC_connecting #noVNC_transition_text::after{content:'Starting dot’s computer…';font-size:16px}",
	// The side toolbar (keys, clipboard, settings, disconnect…) and its logo, the connect dialog,
	// the toast naming the stream mode on connect ("JPEG/WEBP (Images)") and the status banner
	// ("Connected (encrypted) to x11", errors): nobody needs them here. Errors go on the card.
	"#noVNC_control_bar_anchor,#noVNC_control_bar_hint,.noVNC_logo,#noVNC_notification_overlay,#noVNC_connect_dlg,#noVNC_status{display:none!important}",
].join("")
const VIEWER_ICON = "/_dot/dot-mark-64.png?v=2"
const VIEWER_FONT =
	'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap">'

/** dot's picture for the viewer (tab icon, loading screen), served without a link: nothing private. */
const ASSETS = Bun.fileURLToPath(new URL("../../assets/", import.meta.url))
const ASSET_NAMES = new Set([
	"dot-mark.webp",
	"dot-mark-64.png",
	"home-banner.png",
])

/** The viewer retitles the tab once connected ("x11 - KasmVNC"); this puts it back. */
const VIEWER_TITLE = `<script>new MutationObserver(() => { if (document.title !== "dot's computer") document.title = "dot's computer" }).observe(document.querySelector("title"), { childList: true, characterData: true, subtree: true })</script>`

/**
 * The viewer's settings, which it reads from the address (?view_only=…) or else from its saved
 * settings: saved here on every load, before it starts, so the address stays bare.
 * - enable_threading=false: threaded decoding uses the browser's ImageDecoder, which fails on some
 *   frames ("Failed to decode frame at index 0"); the plain image path doesn't.
 * - view_only=true: until the person takes control (VIEWER_CONTROL, which also saves it).
 * - resize=remote: the desktop asked to match the window (VIEWER_CONTROL), and scaled to it until
 *   it does.
 * Addresses with settings in them (links from before) are tidied too.
 */
/**
 * The viewer's uncaught errors, before it sees them (this runs first; it's a deferred module). It
 * shows each in a full-page dialog, and one without a message (a promise rejected with nothing)
 * crashes that and replaces the page with a line of text on white. Most are harmless (its clipboard
 * sync fails when the clipboard changes while it's read), so they go to the console, and are kept
 * for the page to show if the viewer never connects (VIEWER_CONTROL). Losing the connection is
 * shown by the page either way.
 */
const VIEWER_ERRORS = `<script>window.dotErrors = []
for (const type of ["error", "unhandledrejection"])
	addEventListener(type, event => {
		event.stopImmediatePropagation()
		event.preventDefault()
		const error = type === "error" ? event.error ?? event.message : event.reason
		const text = error instanceof Error ? error.name + ": " + error.message : String(error)
		if (dotErrors.length < 5) dotErrors.push(text)
		console.warn("[dot] viewer error:", error)
	})</script>`

const VIEWER_SETTINGS = `<script>try { for (const [name, value] of Object.entries({ enable_threading: "false", view_only: "true", resize: "remote" })) localStorage.setItem(name, value) } catch {}
if (location.search) history.replaceState(null, "", location.pathname)</script>`

/**
 * Taking control, on the same connection: the page starts view-only (the viewer's own setting, so
 * nothing it sends reaches the desktop) and turns that off the moment the person clicks on the
 * screen; clicking outside it (the bars around it), or leaving the tab or window, turns it back on.
 * While they have control the page tells the bot every 10 s (/_dot/control), and dot's actions
 * wait (runtime/desktop `control`).
 *
 * The viewer only asks the desktop to match its window when it isn't view-only, so while the
 * person watches, the page lifts view-only for a moment after connecting and after each resize of
 * the window, and drops their input meanwhile.
 */
const VIEWER_CONTROL = `<script>addEventListener("DOMContentLoaded", () => {
	const root = document.documentElement
	const box = document.getElementById("noVNC_container")
	const viewOnly = document.getElementById("noVNC_setting_view_only")
	const make = (id, html = "") => Object.assign(document.createElement("div"), { id, innerHTML: html })
	let mine = false
	let beat = 0
	const tell = on => fetch("/_dot/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }), keepalive: true }).catch(() => {})
	const looking = on => {
		viewOnly.checked = on
		viewOnly.dispatchEvent(new Event("change"))
	}
	const set = on => {
		if (on === mine) return
		mine = on
		root.classList.toggle("dot_in_control", on)
		looking(!on)
		clearInterval(beat)
		if (on) beat = setInterval(() => tell(true), 10000)
		tell(on)
	}
	// Only a click on the screen takes control (capture phase, before the viewer's own handlers, so
	// that click also lands); clicking anywhere else gives it back.
	addEventListener("pointerdown", event => set(root.classList.contains("noVNC_connected") && event.target instanceof HTMLCanvasElement && box.contains(event.target)), true)
	// Sizing the desktop to the window. The viewer asks 500 ms after a resize of the window (its own
	// or the one dispatched here), if it isn't view-only by then.
	let fitting = 0
	const fit = () => {
		if (mine || !root.classList.contains("noVNC_connected")) return
		looking(false)
		dispatchEvent(new Event("resize"))
		clearTimeout(fitting)
		fitting = setTimeout(() => {
			fitting = 0
			if (!mine) looking(true)
		}, 800)
	}
	addEventListener("resize", event => { if (event.isTrusted) fit() })
	// Meanwhile nothing the person does reaches the desktop, unless it's the click taking control
	// (handled above, first).
	for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "wheel", "contextmenu", "touchstart", "touchmove", "touchend", "keydown", "keyup", "keypress"])
		addEventListener(type, event => {
			if (fitting && !mine) {
				event.stopImmediatePropagation()
				if (event.cancelable && type !== "pointermove" && type !== "mousemove") event.preventDefault()
			}
		}, { capture: true, passive: false })
	addEventListener("blur", () => set(false))
	addEventListener("pagehide", () => set(false))
	document.addEventListener("visibilitychange", () => { if (document.hidden) set(false) })

	// Disconnected: what happened, and Reconnect (a fresh page: if the link has run out meanwhile,
	// that's the page saying so). The viewer's own error, if any, is its status banner's text.
	// Never connected, with errors (VIEWER_ERRORS): the viewer broke, and the same, to reload.
	const lost = make("dot_lost", '<div class="dot_note" role="alert"><img src="/_dot/dot-mark.webp?v=2" alt=""><div><h1></h1><p></p><button class="dot_button" type="button">Reconnect</button><details hidden><summary>Error details</summary><p></p></details></div></div>')
	lost.className = "dot_screen"
	document.body.append(lost)
	lost.querySelector("button").addEventListener("click", () => location.reload())
	const tellLost = (title, text, error, action = "Reconnect") => {
		lost.querySelector("h1").textContent = title
		lost.querySelector("p").textContent = text
		lost.querySelector("button").textContent = action
		lost.querySelector("details p").textContent = error
		lost.querySelector("details").hidden = !error
	}
	let connected = false
	setTimeout(() => {
		if (connected || root.classList.contains("noVNC_disconnected") || !dotErrors.length) return
		tellLost("Couldn’t open dot’s computer", "Something went wrong while loading it. Reload to try again.", dotErrors.join("\\n"), "Reload")
		root.classList.add("dot_failed")
	}, 20000)
	new MutationObserver(() => {
		// Once connected, the desktop takes the window's size (once the viewer knows it can ask).
		if (root.classList.contains("noVNC_connected") && !connected) setTimeout(fit, 1000)
		if (root.classList.contains("noVNC_connected")) connected = true
		if (!root.classList.contains("noVNC_disconnected")) return
		set(false)
		const status = document.getElementById("noVNC_status")
		const error = status.classList.contains("noVNC_status_error") ? status.textContent.trim() : ""
		const [title, text] = !error
			? ["Disconnected", "The connection to dot’s computer closed. Reconnect to keep watching."]
			: connected
				? ["Connection lost", "dot’s computer stopped responding. Reconnect to pick up where you left off."]
				: ["Couldn’t reach dot’s computer", "It may still be starting up. Wait a few seconds, then reconnect."]
		tellLost(title, text, error)
	}).observe(root, { attributes: true, attributeFilter: ["class"] })

	// dot's cursor, from the desktop's events (/_dot/events): where its pointer is, and its clicks.
	// Codex's computer-use cursor: its arrow (the ChatGPT app's cursor icon), glassy pale blue in a white rim.
	// #dot_cursor sits on the tip; .dot_body turns and squashes about the tip; the svg presses and wiggles.
	const cursor = make("dot_cursor", '<div class="dot_body"><svg width="27" height="27" viewBox="0 0 24 24"><path d="M3.10042 6.29005C2.40168 4.30935 4.30916 2.40186 6.28987 3.1006L18.8719 7.54103C20.9168 8.263 21.1141 11.0361 19.2801 12.0693L19.0965 12.1641L14.535 14.293C14.4552 14.3302 14.3867 14.3878 14.3367 14.459L14.2928 14.5352L12.1639 19.0967C11.2172 21.1253 8.2861 20.9829 7.54084 18.8721L3.10042 6.29005Z" fill="#c4d8fb" fill-opacity=".72"/><path d="M3.10042 6.29005C2.40168 4.30935 4.30916 2.40186 6.28987 3.1006L18.8719 7.54103C20.9168 8.263 21.1141 11.0361 19.2801 12.0693L19.0965 12.1641L14.535 14.293C14.4552 14.3302 14.3867 14.3878 14.3367 14.459L14.2928 14.5352L12.1639 19.0967C11.2172 21.1253 8.2861 20.9829 7.54084 18.8721L3.10042 6.29005ZM5.62483 4.98732C5.22864 4.84749 4.8473 5.22882 4.98713 5.62501L9.42756 18.2061C9.57668 18.6281 10.162 18.6566 10.3514 18.251L12.4803 13.6895L12.5819 13.4942C12.8374 13.0525 13.2237 12.6977 13.6893 12.4805L18.2508 10.3516C18.6564 10.1622 18.6279 9.57686 18.2059 9.42775L5.62483 4.98732Z" fill="#fff" fill-rule="evenodd"/></svg></div>')
	box.append(cursor)
	const body = cursor.querySelector(".dot_body")
	let at = null
	const screen = () => [...box.querySelectorAll("canvas")].find(canvas => canvas.width > 100)
	// Where the desktop's point is on the page, relative to the box.
	const onPage = point => {
		const canvas = screen()
		if (!canvas || !canvas.getBoundingClientRect().width) return null
		const r = canvas.getBoundingClientRect()
		const b = box.getBoundingClientRect()
		const scale = r.width / canvas.width
		return { x: r.left - b.left - box.clientLeft + point.x * scale, y: r.top - b.top - box.clientTop + point.y * scale }
	}
	const place = () => {
		if (!at) return
		const to = onPage(at)
		// The first position can come before the screen is drawn.
		if (!to) return void setTimeout(place, 200)
		if (!pos) {
			// Its first appearance: there already, growing in, then a wiggle so it's easy to find.
			pos = to
			render()
			cursor.classList.add("seen", "appear")
			setTimeout(wiggle, 350)
			return
		}
		go(to)
	}
	const wiggle = () => {
		cursor.classList.remove("wiggle")
		void cursor.offsetWidth // restarts the animation
		cursor.classList.add("wiggle")
	}
	cursor.addEventListener("animationend", event => {
		if (event.animationName === "dot_wiggle") cursor.classList.remove("wiggle")
		if (event.animationName === "dot_appear") cursor.classList.remove("appear")
	})

	// Moving, like Codex's cursor (its motion, rebuilt): no CSS transition, springs stepped each frame.
	// - Short hops: straight there, the arrow keeping its resting angle but leaning toward where it's
	//   going and narrowing a little across the way, most mid-way and none on arrival.
	// - Longer moves: along a curve that leaves and arrives heading the way the arrow points at rest
	//   (up-left), the smoothest of a few that stay on screen, the arrow following the curve. So all
	//   its turning happens on the way, and it lands at rest.
	// A new move mid-way starts from wherever it is, turned however it is.
	const still = matchMedia("(prefers-reduced-motion: reduce)")
	const REST = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 } // the tip's heading at rest
	const REST_ANGLE = -135
	const HOP = 180 // px: up to this, a hop
	const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
	const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k })
	const length = v => Math.hypot(v.x, v.y)
	const unit = v => { const l = length(v); return l < 0.001 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l } }
	const wrap = angle => ((angle % 360) + 540) % 360 - 180
	// A damped spring: response is roughly its period in seconds; damping 1 doesn't overshoot.
	const spring = (value, target, response, damping) => ({ value, target, velocity: 0, response, damping })
	const step = (s, dt) => {
		const k = (2 * Math.PI / s.response) ** 2
		const c = 2 * s.damping * Math.sqrt(k)
		for (let left = dt; left > 0; left -= 1 / 240) {
			const h = Math.min(1 / 240, left)
			s.velocity += (k * (s.target - s.value) - c * s.velocity) * h
			s.value += s.velocity * h
		}
	}
	const resting = s => Math.abs(s.target - s.value) < 0.002 && Math.abs(s.velocity) < 0.02
	const cubic = (a, b, c, d, t) => {
		const u = 1 - t
		return {
			point: { x: a.x * u * u * u + 3 * b.x * u * u * t + 3 * c.x * u * t * t + d.x * t * t * t, y: a.y * u * u * u + 3 * b.y * u * u * t + 3 * c.y * u * t * t + d.y * t * t * t },
			tangent: { x: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x), y: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y) },
		}
	}
	const along = (path, p) => {
		const i = Math.min(path.length - 1, Math.floor(p * path.length))
		const [a, b, c, d] = path[i]
		return cubic(a, b, c, d, p * path.length - i)
	}
	// Candidate curves from a to b: one plain, and some with a bend to either side; the one with the
	// least turning (and length) that stays on screen wins.
	const plan = (a, b) => {
		const w = box.clientWidth, h = box.clientHeight
		const inside = p => ({ x: clamp(p.x, 12, w - 12), y: clamp(p.y, 12, h - 12) })
		const d = length({ x: b.x - a.x, y: b.y - a.y })
		const dir = unit({ x: b.x - a.x, y: b.y - a.y })
		const out = inside(add(a, REST, clamp(d * 0.4, 40, 500)))
		const into = inside(add(b, REST, -clamp(d * 0.15, 40, 500)))
		const side = { x: -dir.y, y: dir.x }
		const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
		const bend = clamp(d * 0.28, 50, 520), handle = clamp(d * 0.4, 40, 440)
		const paths = [[[a, out, into, b]]]
		for (const sign of [1, -1])
			for (const scale of [0.55, 0.8, 1.05]) {
				const m = add(middle, side, sign * bend * scale)
				paths.push([[a, out, add(m, dir, -handle), m], [m, add(m, dir, handle), into, b]])
			}
		let best = null
		for (const path of paths) {
			let travelled = 0, energy = 0, worst = 0, total = 0, offscreen = false
			let last = a, heading = null
			for (let i = 1; i <= 48; i++) {
				const point = along(path, i / 48).point
				if (point.x < 0 || point.y < 0 || point.x > w || point.y > h) offscreen = true
				const move = { x: point.x - last.x, y: point.y - last.y }
				travelled += length(move)
				if (length(move) > 0.01) {
					const angle = Math.atan2(move.y, move.x)
					if (heading !== null) {
						const change = Math.abs(((angle - heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
						energy += change * change
						worst = Math.max(worst, change)
						total += change
					}
					heading = angle
				}
				last = point
			}
			const cost = travelled + Math.max(0, travelled / d - 1) * 320 + energy * 140 + worst * 180 + total * 18 + (path.length > 1 ? 45 : 0) + (offscreen ? 1e6 : 0)
			if (!best || cost < best.cost) best = { path, cost, travelled, total }
		}
		// Longer and twistier takes a little longer; heading back the other way, longer still.
		const backward = clamp((-(dir.x * REST.x + dir.y * REST.y) - 0.08) / 0.92, 0, 1)
		const response = clamp((0.42 + clamp((best.travelled - 180) / 760, 0, 1) * 0.22 + clamp(best.total / (Math.PI * 1.4), 0, 1) * 0.12 + backward * 0.28) * 0.7, 0.18, 0.9)
		return { path: best.path, progress: spring(0, 1, response, 0.9) }
	}
	let pos = null // where the tip is, on the page
	let motion = null
	let speed = 0
	const turn = spring(0, 0, 0.12, 0.9) // the arrow's angle from rest, degrees
	let lean = 0, squash = 1, axis = 0
	const go = to => {
		const d = length({ x: to.x - pos.x, y: to.y - pos.y })
		if (still.matches || d < 2) {
			motion = null
			pos = to
			render()
			return
		}
		if (d <= HOP) {
			const dir = unit({ x: to.x - pos.x, y: to.y - pos.y })
			// Toward the way it's going: sideways most, then up (the arrow already points up-left).
			motion = { hop: true, from: pos, to, axis: Math.atan2(dir.y, dir.x) * 180 / Math.PI, lean: clamp(dir.x * 0.75 - dir.y * 0.62, -1, 1) * 60, progress: spring(0, 1, 0.19, 0.94) }
		} else motion = { hop: false, to, ...plan(pos, to) }
		run()
	}
	const render = () => {
		cursor.style.transform = "translate(" + pos.x.toFixed(2) + "px," + pos.y.toFixed(2) + "px)"
		body.style.transform = "rotate(" + axis.toFixed(2) + "deg) scale(1," + squash.toFixed(3) + ") rotate(" + (-axis).toFixed(2) + "deg) rotate(" + (turn.value + lean).toFixed(2) + "deg)"
	}
	let frame = 0, then = 0
	const run = () => { if (!frame) { then = performance.now(); frame = requestAnimationFrame(tick) } }
	const tick = now => {
		frame = 0
		const dt = clamp((now - then) / 1000, 1 / 240, 1 / 20)
		then = now
		lean = 0
		squash = 1
		if (motion) {
			step(motion.progress, dt)
			const p = clamp(motion.progress.value, 0, 1)
			const before = pos
			if (motion.hop) {
				pos = { x: motion.from.x + (motion.to.x - motion.from.x) * p, y: motion.from.y + (motion.to.y - motion.from.y) * p }
				const swell = Math.sin(p * Math.PI)
				lean = motion.lean * swell
				squash = 1 - 0.15 * swell
				axis = motion.axis
				turn.target = turn.value + wrap(-turn.value)
			} else {
				const { point, tangent } = along(motion.path, p)
				pos = point
				const heading = length(tangent) < 0.001 ? REST_ANGLE : Math.atan2(tangent.y, tangent.x) * 180 / Math.PI
				turn.target = turn.value + wrap(heading - REST_ANGLE - turn.value)
				speed = length({ x: pos.x - before.x, y: pos.y - before.y }) / dt
				squash = clamp(1 - speed / 5500, 0.7, 1)
				axis = heading
			}
			if (p >= 0.999 && resting(motion.progress)) {
				pos = motion.to
				motion = null
				turn.target = turn.value + wrap(-turn.value)
			}
		}
		step(turn, dt)
		render()
		if (motion || !resting(turn)) frame = requestAnimationFrame(tick)
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
	}
	// The page or the desktop changed size: straight to where the point now is.
	const refit = () => {
		if (!at || !pos) return
		const to = onPage(at)
		if (!to) return
		motion = null
		pos = to
		render()
	}
	addEventListener("resize", refit)
	new ResizeObserver(refit).observe(box)
})</script>`

function viewerPage(html: string): string {
	return html
		.replace(/<title>[^<]*<\/title>/, "<title>dot's computer</title>")
		.replace(/<link[^>]*kasm_logo[^>]*>/g, "")
		.replace(
			"</head>",
			`<link rel="icon" href="${VIEWER_ICON}">${VIEWER_FONT}<style>${VIEWER_STYLE}</style>${VIEWER_ERRORS}${VIEWER_SETTINGS}${VIEWER_TITLE}${VIEWER_CONTROL}</head>`,
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
 * dot's Home tab in Slack (private to each person, slack/home.ts) is where the link lives: redrawn
 * with a fresh one every time they open it, and whenever dot uses the computer for them. Threads
 * only get a note the first time someone's dot uses its computer, so links don't pile up.
 */

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
	await refreshHome(client, target).catch(error =>
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

/** A page instead of the desktop: dot, what happened, and what to do (`action`, a link). */
const page = (
	status: number,
	title: string,
	text: string,
	action?: { href: string; label: string },
) =>
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dot's computer</title><link rel="icon" href="${VIEWER_ICON}">${VIEWER_FONT}<style>body{margin:0}${NOTE_STYLE}</style><main class="dot_screen"><div class="dot_note"><img src="/_dot/dot-mark.webp?v=2" alt=""><div><h1>${title}</h1><p>${text}</p>${action ? `<a class="dot_button" href="${action.href}">${action.label}</a>` : ""}</div></div></main></html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	)

function cookie(request: Request, name: string): string | undefined {
	for (const part of request.headers.get("cookie")?.split(";") ?? []) {
		const [key, ...value] = part.trim().split("=")
		if (key === name) return value.join("=")
	}
}

/**
 * dot's web address: the desktop viewer, and `slackOAuth` (Slack's redirect back after someone
 * connects their Slack account) at /slack/oauth. Started for either. `slackHome` opens dot's Home
 * tab in Slack, where people get a fresh link.
 */
export function startDesktopGateway(
	config: BotConfig,
	slackOAuth?: (request: Request) => Promise<Response>,
	slackHome?: string,
): void {
	const { host, port, publicUrl } = config.desktopViewer
	const secure = publicUrl.startsWith("https:")
	const toSlack = slackHome
		? { href: slackHome, label: "Open dot in Slack" }
		: undefined

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
							"This link has expired",
							`Links last ${LINK_HOURS} hours. dot’s Home tab in Slack always has a fresh one.`,
							toSlack,
						)
					// The viewer's requests (page, assets, its websocket) carry this instead of the link.
					return new Response(null, {
						status: 303,
						headers: {
							// The viewer's settings are saved by the page itself (VIEWER_SETTINGS).
							location: "/",
							"set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINK_HOURS * 3600}${secure ? "; Secure" : ""}`,
							"cache-control": "no-store",
						},
					})
				}

				const grant = await verify(cookie(request, COOKIE))
				if (!grant)
					return page(
						401,
						"Open your computer from Slack",
						"It opens from dot’s Home tab in Slack, where only you can see the link.",
						toSlack,
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
							"Couldn’t start dot’s computer",
							"It didn’t start in time. Wait a moment, then try again.",
							{ href: "", label: "Try again" },
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
			await Bun.$`docker ps ${ownContainers} --format ${"{{.Names}}"}`
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
