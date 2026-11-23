import gulabJamunImg from "../public/mascots/gulab-jamun-160.webp"
import jalebiImg from "../public/mascots/jalebi-160.webp"
import kajuKatliImg from "../public/mascots/kaju-katli-160.webp"
import ladduImg from "../public/mascots/laddu-160.webp"
import rasgullaImg from "../public/mascots/rasgulla-160.webp"

const MASCOTS = [
	{ id: "laddu", name: "laddu", src: ladduImg },
	{ id: "jalebi", name: "jalebi", src: jalebiImg },
	{ id: "kaju", name: "kaju", src: kajuKatliImg },
	{ id: "jamun", name: "jamun", src: gulabJamunImg },
	{ id: "rasgulla", name: "rasgulla", src: rasgullaImg },
]

const SCENARIOS = [
	{
		channel: "product",
		caption: "Based on a real reply",
		user: "You",
		init: "Y",
		time: "10:14 AM",
		ask: bot =>
			`hi <span class="mention">@${bot}</span>, what can you do for me?`,
		step: bot => `${bot} checked your memory · 1.2s`,
		trace: [
			["Loaded personal memory", "0.4s"],
			["Checked workspace tools", "0.8s"],
		],
		reply: "I can help you with:",
		bullets: [
			[
				"Your code:",
				"build features, fix bugs, review code, and open PRs on Azure Repos or CodeCommit.",
			],
			[
				"Files:",
				"analyse data and hand back spreadsheets, charts, documents, or slides.",
			],
			[
				"Reminders:",
				"remind you later, run recurring tasks, or DM teammates for you.",
			],
		],
		file: null,
	},
	{
		channel: "launch",
		caption: "Real file output",
		user: "Maya",
		init: "M",
		time: "2:08 PM",
		ask: bot =>
			`<span class="mention">@${bot}</span> turn this thread’s launch notes into a Q4 tracker spreadsheet`,
		step: bot => `${bot} read 14 replies &amp; built workbook · 8.6s`,
		trace: [
			["Read 14 messages in #launch", "1.1s"],
			["Generated q4-launch-tracker.xlsx", "5.9s"],
			["Uploaded attachment to Slack", "1.6s"],
		],
		reply: "Grouped every task by owner and target date from the thread:",
		bullets: [
			[
				"Blockers:",
				"3 items flagged under Billing ahead of Friday’s freeze.",
			],
			["Follow-up:", "Want a reminder in #launch tomorrow at 9 AM?"],
		],
		file: {
			name: "q4-launch-tracker.xlsx",
			meta: "48 KB · Attached in Slack",
		},
	},
	{
		channel: "eng",
		caption: "Ships pull requests",
		user: "Dev",
		init: "D",
		time: "4:41 PM",
		ask: bot =>
			`<span class="mention">@${bot}</span> fix the flaky webhook retry test and open a PR on Azure Repos`,
		step: bot => `${bot} ran tests &amp; pushed branch · 21.4s`,
		trace: [
			["Cloned repo inside @dev container", "3.2s"],
			["Ran bun test — 18 passed, 0 failed", "11.8s"],
			["Opened PR #418 on Azure Repos", "6.4s"],
		],
		reply: "Fixed the timer race in retry backoff and opened a pull request as you:",
		bullets: [
			[
				"Change:",
				"Replaced wall-clock jitter check with deterministic fake timers.",
			],
		],
		file: {
			name: "PR #418 · fix/webhook-retry-test",
			meta: "Azure Repos · Ready",
		},
	},
]

let activeMascot = MASCOTS[0]
let promptIdx = 0
let showTrace = false
let isTakenOver = false

const brandMascotEl = document.getElementById("brandMascot")
const brandNameEl = document.getElementById("brandName")
const leadMentionEl = document.getElementById("leadMention")
const slackChanEl = document.getElementById("slackChan")
const slackCaptionEl = document.getElementById("slackCaption")
const slackBodyEl = document.getElementById("slackBody")
const skinRowEl = document.getElementById("skinRow")
const takeBtn = document.getElementById("takeBtn")
const controlStateEl = document.getElementById("controlState")
const browserNoteEl = document.getElementById("browserNote")

function updateTakeoverCopy() {
	const bot = activeMascot.name
	takeBtn.setAttribute("aria-pressed", String(isTakenOver))
	takeBtn.textContent = isTakenOver
		? `Hand back to ${bot}`
		: "Take over screen"
	controlStateEl.textContent = isTakenOver ? "you driving" : `${bot} driving`
	browserNoteEl.textContent = isTakenOver
		? "Session paused for you—finish sign-in or MFA, then hand control straight back."
		: "Clicks and types through portals with no API. Watch live from Slack’s Home tab, take over anytime, and hand back."
}

function renderSlack() {
	const s = SCENARIOS[promptIdx]
	const bot = activeMascot.name
	slackChanEl.textContent = s.channel
	slackCaptionEl.textContent = s.caption

	slackBodyEl.innerHTML = `
		<div class="s-msg">
			<div class="s-av" aria-hidden="true">${s.init}</div>
			<div>
				<div class="s-head">
					<span class="s-name">${s.user}</span>
					<span class="s-time">${s.time}</span>
				</div>
				<div class="s-text">${s.ask(bot)}</div>
			</div>
		</div>
		<div class="s-msg">
			<div class="s-av bot"><img src="${activeMascot.src}" alt="${bot}" width="26" height="26" /></div>
			<div>
				<div class="s-head">
					<span class="s-name">${bot}</span>
					<span class="s-badge">Agent</span>
					<span class="s-time">${s.time}</span>
				</div>
				<div class="s-status">
					<span class="s-status-l">
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--positive);width:13px;height:13px">
							<path d="M20 6 9 17l-5-5" />
						</svg>
						<span>${s.step(bot)}</span>
					</span>
					<button type="button" class="s-step-btn" id="toggleTrace" aria-expanded="${showTrace}">
						${showTrace ? "Hide steps" : "Steps"}
					</button>
				</div>
				${
					showTrace
						? `<div class="s-trace">${s.trace
								.map(
									([label, dur]) =>
										`<div class="s-trace-row"><span>${label}</span><span>${dur}</span></div>`,
								)
								.join("")}</div>`
						: ""
				}
				<div class="s-text" style="margin-top:8px">${s.reply}</div>
				<ul class="s-list">
					${s.bullets
						.map(
							([lead, body]) =>
								`<li><strong>${lead}</strong> ${body}</li>`,
						)
						.join("")}
				</ul>
				${
					s.file
						? `<div class="s-file"><span class="s-file-name">${s.file.name}</span><span class="s-file-meta">${s.file.meta}</span></div>`
						: ""
				}
			</div>
		</div>
	`

	const toggleBtn = document.getElementById("toggleTrace")
	toggleBtn?.addEventListener("click", e => {
		e.stopPropagation()
		showTrace = !showTrace
		renderSlack()
	})
}

function renderSkins() {
	skinRowEl.innerHTML = MASCOTS.map(
		m => `
		<button
			type="button"
			class="skin-btn"
			data-skin="${m.id}"
			aria-pressed="${m.id === activeMascot.id}"
		>
			<img src="${m.src}" alt="${m.name}" width="32" height="32" />
			<span>${m.name}</span>
		</button>
	`,
	).join("")

	for (const btn of skinRowEl.querySelectorAll(".skin-btn")) {
		btn.addEventListener("click", e => {
			e.stopPropagation()
			activeMascot =
				MASCOTS.find(m => m.id === btn.dataset.skin) ?? MASCOTS[0]
			brandMascotEl.src = activeMascot.src
			brandMascotEl.alt = `${activeMascot.name} mascot`
			brandNameEl.textContent = activeMascot.name
			leadMentionEl.textContent = `@${activeMascot.name}`
			renderSkins()
			renderSlack()
			updateTakeoverCopy()
		})
	}
}

document.getElementById("cyclePrompt")?.addEventListener("click", e => {
	e.stopPropagation()
	promptIdx = (promptIdx + 1) % SCENARIOS.length
	showTrace = false
	renderSlack()
})

takeBtn?.addEventListener("click", e => {
	e.stopPropagation()
	isTakenOver = !isTakenOver
	updateTakeoverCopy()
})

// Copy buttons with feedback
for (const btn of document.querySelectorAll("[data-copy]")) {
	btn.addEventListener("click", e => {
		e.stopPropagation()
		const text = btn.dataset.copy
		if (text) navigator.clipboard?.writeText(text).catch(() => {})
		const prev = btn.textContent
		btn.textContent = "Copied"
		window.setTimeout(() => {
			btn.textContent = prev
		}, 1400)
	})
}

// Pointer spotlight on primary button
const openInstallBtn = document.getElementById("openInstall")
openInstallBtn?.addEventListener("pointermove", e => {
	const r = openInstallBtn.getBoundingClientRect()
	openInstallBtn.style.setProperty("--gx", `${e.clientX - r.left}px`)
	openInstallBtn.style.setProperty("--gy", `${e.clientY - r.top}px`)
	openInstallBtn.style.setProperty("--glow", "1")
})
openInstallBtn?.addEventListener("pointerleave", () => {
	openInstallBtn.style.setProperty("--glow", "0")
})

// Install Sheet dialog with focus restoration
const sheet = document.getElementById("installSheet")
const closeSheetBtn = document.getElementById("closeSheet")
let lastFocused = null

function openSheet() {
	lastFocused = document.activeElement
	sheet.hidden = false
	closeSheetBtn?.focus()
}

function closeSheet() {
	if (sheet.hidden) return
	sheet.hidden = true
	if (lastFocused instanceof HTMLElement) lastFocused.focus()
}

openInstallBtn?.addEventListener("click", openSheet)
for (const trigger of document.querySelectorAll("[data-open-install]")) {
	trigger.addEventListener("click", e => {
		e.stopPropagation()
		openSheet()
	})
}
closeSheetBtn?.addEventListener("click", closeSheet)
sheet?.addEventListener("click", e => {
	if (e.target === sheet) closeSheet()
})
window.addEventListener("keydown", e => {
	if (e.key === "Escape") closeSheet()
})

// Draggable + wheel-pannable spatial canvas
const stage = document.getElementById("stage")
const world = document.getElementById("world")
const tiles = new Map()
for (const el of world.querySelectorAll("[data-tile]")) {
	tiles.set(el.dataset.tile, el)
}

const WORLD_W = 1320
const WORLD_H = 796
let tx = 0
let ty = 0
let dragging = false
let startX = 0
let startY = 0
let baseX = 0
let baseY = 0

function clampPan(x, y) {
	const minX = Math.min(0, stage.clientWidth - WORLD_W)
	const minY = Math.min(0, stage.clientHeight - WORLD_H)
	return [Math.max(minX, Math.min(24, x)), Math.max(minY, Math.min(24, y))]
}

function applyPan(smooth = false) {
	world.style.transition = smooth
		? "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)"
		: "none"
	world.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
}

function setActiveDock(key) {
	for (const btn of document.querySelectorAll(".dock-btn")) {
		btn.setAttribute(
			"aria-current",
			btn.dataset.jump === key ? "true" : "false",
		)
	}
}

function focusTile(key, smooth = true) {
	const el = tiles.get(key)
	if (!el) return
	const targetX =
		key === "slack"
			? 0
			: Math.round(
					stage.clientWidth / 2 -
						(el.offsetLeft + el.offsetWidth / 2),
				)
	const targetY =
		key === "slack"
			? 0
			: Math.round(
					(stage.clientHeight - 54) / 2 -
						(el.offsetTop + el.offsetHeight / 2),
				)
	const [nx, ny] = clampPan(targetX, targetY)
	tx = nx
	ty = ny
	applyPan(smooth)
	setActiveDock(key)
}

const TEXT_SELECTABLE =
	".s-text, .s-list, .s-trace, .cmd-str, .term-log, .term-alt, .browser-state, .ledger-v, .skin-desc"

stage.addEventListener("pointerdown", e => {
	if (window.innerWidth <= 640) return
	if (e.target.closest("button, a, nav")) return
	if (e.target.closest(TEXT_SELECTABLE)) return
	dragging = true
	startX = e.clientX
	startY = e.clientY
	baseX = tx
	baseY = ty
	stage.classList.add("dragging")
	stage.setPointerCapture(e.pointerId)
})

stage.addEventListener("pointermove", e => {
	if (!dragging) return
	const [nx, ny] = clampPan(
		baseX + (e.clientX - startX),
		baseY + (e.clientY - startY),
	)
	tx = nx
	ty = ny
	applyPan(false)
})

function endDrag() {
	if (!dragging) return
	dragging = false
	stage.classList.remove("dragging")
}

stage.addEventListener("pointerup", endDrag)
stage.addEventListener("pointercancel", endDrag)

// Trackpad / mouse wheel panning on the canvas (desktop)
stage.addEventListener(
	"wheel",
	e => {
		if (window.innerWidth <= 900) return
		e.preventDefault()
		const [nx, ny] = clampPan(tx - e.deltaX, ty - e.deltaY)
		tx = nx
		ty = ny
		applyPan(false)
	},
	{ passive: false },
)

for (const btn of document.querySelectorAll(".dock-btn")) {
	btn.addEventListener("click", e => {
		e.stopPropagation()
		focusTile(btn.dataset.jump, true)
	})
}

document.getElementById("focusSlack")?.addEventListener("click", () => {
	promptIdx = (promptIdx + 1) % SCENARIOS.length
	showTrace = false
	renderSlack()
	focusTile("slack", true)
})

window.addEventListener("resize", () => {
	const [nx, ny] = clampPan(tx, ty)
	tx = nx
	ty = ny
	applyPan(false)
})

renderSlack()
renderSkins()
updateTakeoverCopy()
applyPan(false)
