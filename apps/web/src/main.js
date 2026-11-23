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
		file: { name: "q4-launch-tracker.xlsx", meta: "48 KB · In Slack" },
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
		file: { name: "PR #418 · fix/webhook-retry-test", meta: "Azure Repos" },
	},
]

const CARD_IDS = [
	"slack",
	"install",
	"isolation",
	"takeover",
	"files",
	"prs",
	"models",
	"memory",
	"reminders",
	"skins",
]

const ROW_OFFSETS = [0, 3, 6, 9, 2, 5, 8, 1, 4, 7]
const INITIAL_DELAYS = [0, 45, 80, 108, 130, 148]

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
const prefersReducedMotion = () => reducedMotionQuery.matches

const state = {
	mascot: MASCOTS[0],
	promptIdx: 0,
	showTrace: false,
	takenOver: false,
	reminderPaused: false,
}

const brandAvWrap = document.getElementById("brandAvWrap")
const brandMascotEl = document.getElementById("brandMascot")
const brandNameEl = document.getElementById("brandName")
const leadMentionEl = document.getElementById("leadMention")
const stage = document.getElementById("stage")
const world = document.getElementById("world")
const dock = document.getElementById("canvasDock")
const dockIndicator = document.getElementById("dockIndicator")

function mod(n, m) {
	return ((n % m) + m) % m
}

function cardIdAt(col, row) {
	const offset = ROW_OFFSETS[mod(row, ROW_OFFSETS.length)]
	return CARD_IDS[mod(col + offset, CARD_IDS.length)]
}

function renderCardMarkup(id) {
	const bot = state.mascot.name
	const av = state.mascot.src

	switch (id) {
		case "slack": {
			const s = SCENARIOS[state.promptIdx]
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">
							<span class="hash" aria-hidden="true">#</span>
							<span>${s.channel}</span>
						</span>
						<div class="tile-actions">
							<span class="tile-note">${s.caption}</span>
							<button type="button" class="tile-pill" data-action="cycle-prompt">Next example</button>
						</div>
					</div>
					<div class="card-body" data-slack-content>
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
							<div class="s-av bot"><img src="${av}" alt="${bot}" width="28" height="28" /></div>
							<div>
								<div class="s-head">
									<span class="s-name">${bot}</span>
									<span class="s-badge">Agent</span>
									<span class="s-time">${s.time}</span>
								</div>
								<div class="s-status">
									<span class="s-status-l">
										<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--positive);width:14px;height:14px">
											<path d="M20 6 9 17l-5-5" />
										</svg>
										<span>${s.step(bot)}</span>
									</span>
									<button type="button" class="s-step-btn" data-action="toggle-trace" aria-expanded="${state.showTrace}">
										${state.showTrace ? "Hide" : "Steps"}
									</button>
								</div>
								<div class="s-trace-wrap" data-open="${state.showTrace}">
									<div class="s-trace-clip">
										<div class="s-trace">${s.trace
											.map(
												([label, dur]) =>
													`<div class="s-trace-row"><span>${label}</span><span>${dur}</span></div>`,
											)
											.join("")}</div>
									</div>
								</div>
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
					</div>
				</div>
			`
		}

		case "install":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">linux-box · systemd</span>
						<button type="button" class="tile-pill" data-action="open-install">Full guide</button>
					</div>
					<div class="card-body">
						<div class="cmd-pill">
							<code class="cmd-str"><span class="cmd-p" aria-hidden="true">$</span>curl -fsSL https://laddu.wtf/install.sh | sh</code>
							<button type="button" class="copy-mini" data-copy="curl -fsSL https://laddu.wtf/install.sh | sh">
								<span class="copy-label">Copy</span>
							</button>
						</div>
						<div class="term-log">
							<div><span class="term-ok" aria-hidden="true">✓</span>Installs Docker &amp; Bun if missing</div>
							<div><span class="term-ok" aria-hidden="true">✓</span>Creates your Slack app &amp; signs in</div>
							<div><span class="term-ok" aria-hidden="true">✓</span>Starts systemd service &amp; DMs only you first</div>
						</div>
						<div class="term-alt">
							Already have Bun &amp; Docker? Run <code>bun create laddu</code>
						</div>
					</div>
				</div>
			`

		case "isolation":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Private containers</span>
						<span class="tile-note tabular">1 per person</span>
					</div>
					<div class="card-body">
						<div class="iso-grid">
							<div class="ct-cell">
								<div class="ct-head">
									<span>@you</span>
									<span class="ct-state">isolated</span>
								</div>
								<div class="ct-meta">Desktop, browser, files</div>
								<div class="ct-meta">Own Claude / Codex login</div>
							</div>
							<div class="ct-cell">
								<div class="ct-head">
									<span>@priya</span>
									<span class="ct-state">isolated</span>
								</div>
								<div class="ct-meta">Desktop, browser, files</div>
								<div class="ct-meta">Own OpenCode / M365</div>
							</div>
						</div>
						<div class="iso-wall">
							<span>Internet-only egress</span>
							<span>Host, LAN &amp; peers blocked</span>
						</div>
					</div>
				</div>
			`

		case "takeover":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Slack Home · Live desktop</span>
						<span class="ct-state" data-user="${state.takenOver}">${state.takenOver ? "you driving" : `${bot} driving`}</span>
					</div>
					<div class="card-body">
						<div class="browser-mock" data-paused="${state.takenOver}">
							<span class="browser-beam" aria-hidden="true"></span>
							<div class="browser-url">
								<span class="url-dot" aria-hidden="true"></span>
								<span>dev.azure.com/team/pullrequest/418</span>
							</div>
							<p class="browser-state" data-takeover-note>
								${
									state.takenOver
										? "Session paused for you—finish sign-in, MFA, or review the form, then hand control straight back."
										: "Clicks and types through portals with no API. Watch live from Slack’s Home tab, take over anytime, and hand back."
								}
							</p>
						</div>
						<button type="button" class="take-toggle" data-action="toggle-takeover" aria-pressed="${state.takenOver}">
							${state.takenOver ? `Hand back to ${bot}` : "Take over screen"}
						</button>
					</div>
				</div>
			`

		case "files":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Real files in threads</span>
						<span class="tile-note">Generated in container</span>
					</div>
					<div class="card-body">
						<div class="file-grid">
							<div class="file-card">
								<span class="file-ext">XLSX</span>
								<span class="file-name">q4-launch-tracker.xlsx</span>
								<span class="file-sub">Formulas &amp; filters ready</span>
							</div>
							<div class="file-card">
								<span class="file-ext">PPTX</span>
								<span class="file-name">weekly-ops-deck.pptx</span>
								<span class="file-sub">8 slides from thread notes</span>
							</div>
							<div class="file-card">
								<span class="file-ext">PNG</span>
								<span class="file-name">latency-p95-chart.png</span>
								<span class="file-sub">Plotted from attached CSV</span>
							</div>
							<div class="file-card">
								<span class="file-ext">PDF</span>
								<span class="file-name">release-handoff.pdf</span>
								<span class="file-sub">Formatted brief for review</span>
							</div>
						</div>
					</div>
				</div>
			`

		case "prs":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Ships pull requests</span>
						<span class="tile-note">Azure Repos &amp; CodeCommit</span>
					</div>
					<div class="card-body">
						<div class="pr-box">
							<div class="pr-head">
								<span class="pr-title">fix(webhooks): eliminate retry timer race</span>
								<span class="pr-diff">
									<span class="diff-add">+42</span>
									<span class="diff-del">-19</span>
								</span>
							</div>
							<div class="pr-meta">PR #418 · Opened as @you · 18 tests passing</div>
						</div>
						<div class="term-log">
							<div><span class="term-ok" aria-hidden="true">✓</span>Cloned &amp; tested inside your container</div>
							<div><span class="term-ok" aria-hidden="true">✓</span>Pushed branch &amp; posted summary in Slack</div>
						</div>
					</div>
				</div>
			`

		case "models":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Models &amp; access</span>
						<span class="tile-note">Per-person choice</span>
					</div>
					<div class="card-body">
						<div class="ledger-list">
							<div class="ledger-row">
								<span class="ledger-k">Codex</span>
								<span class="ledger-v">Your ChatGPT plan or OpenAI key</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">Claude Code</span>
								<span class="ledger-v">Your Claude plan or Anthropic key</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">OpenCode</span>
								<span class="ledger-v">Free models out of the box</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">Azure &amp; M365</span>
								<span class="ledger-v">Acts as you—sees only what you can</span>
							</div>
						</div>
					</div>
				</div>
			`

		case "memory":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Memory &amp; how-tos</span>
						<span class="tile-note">Persists per person</span>
					</div>
					<div class="card-body">
						<div class="ledger-list">
							<div class="ledger-row">
								<span class="ledger-k">Preferences</span>
								<span class="ledger-v">Remembers who you are and how you like replies</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">Past threads</span>
								<span class="ledger-v">Searches earlier Slack conversations on demand</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">Self-written</span>
								<span class="ledger-v">Saves repeatable runbooks for your workflows</span>
							</div>
						</div>
					</div>
				</div>
			`

		case "reminders":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Reminders &amp; recurring</span>
						<button type="button" class="tile-pill" data-action="toggle-reminder">
							${state.reminderPaused ? "Resume" : "Pause"}
						</button>
					</div>
					<div class="card-body">
						<div class="ledger-list">
							<div class="ledger-row">
								<span class="ledger-k tabular">Mon 09:00</span>
								<span class="ledger-v">Post open sprint blockers in #product</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k tabular">In 20 min</span>
								<span class="ledger-v">DM @priya once the staging build clears</span>
							</div>
							<div class="ledger-row">
								<span class="ledger-k">Status</span>
								<span class="ledger-v" style="color:${state.reminderPaused ? "var(--muted)" : "var(--positive)"}">
									${state.reminderPaused ? "Paused—no messages will fire" : "Active inside your container"}
								</span>
							</div>
						</div>
					</div>
				</div>
			`

		case "skins":
			return `
				<div class="tile-inner">
					<div class="tile-bar">
						<span class="tile-title">Name &amp; look</span>
						<span class="tile-note">Same bot, your mascot</span>
					</div>
					<div class="card-body">
						<p class="skin-desc">
							Rename and dress the bot as any mithai—click one to preview it live across the page.
						</p>
						<div class="skin-row" role="group" aria-label="Choose mascot look">
							${MASCOTS.map(
								m => `
								<button
									type="button"
									class="skin-btn"
									data-skin="${m.id}"
									aria-pressed="${m.id === state.mascot.id}"
								>
									<img src="${m.src}" alt="${m.name}" width="44" height="44" />
									<span>${m.name}</span>
								</button>
							`,
							).join("")}
						</div>
						<div class="skin-foot">
							All mithai share the exact same capabilities—just your team’s favorite name and avatar.
						</div>
					</div>
				</div>
			`

		default:
			return ""
	}
}

// ==========================================
// INFINITE VIRTUALIZED CANVAS + SPRING PHYSICS
// ==========================================
const CARD_W = 516
const CARD_H = 384
const GAP = 26
const STEP_X = CARD_W + GAP
const STEP_Y = CARD_H + GAP
const ROW_STAGGER = Math.round(STEP_X * 0.36)

const activeNodes = new Map()
let isMobileStack = false
let isInitialPaint = true

let camX = -28
let camY = -28
let vx = 0
let vy = 0
let springTarget = null
let animFrame = 0
let lastTickTime = 0

function syncBrandHeader(animatePop = false) {
	brandMascotEl.src = state.mascot.src
	brandMascotEl.alt = `${state.mascot.name} mascot`
	brandNameEl.textContent = state.mascot.name
	leadMentionEl.textContent = `@${state.mascot.name}`

	if (animatePop && !prefersReducedMotion()) {
		brandAvWrap?.animate(
			[
				{ transform: "scale(0.88)" },
				{ transform: "scale(1.07)", offset: 0.55 },
				{ transform: "scale(1)" },
			],
			{ duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
		)
	}
}

function updateCardsByType(cardId, afterUpdate) {
	for (const [, entry] of activeNodes) {
		if (cardId && entry.cardId !== cardId) continue
		entry.el.innerHTML = renderCardMarkup(entry.cardId)
		afterUpdate?.(entry.el)
	}
}

function animateBlurSwap(el, directionX = 0) {
	if (!el || prefersReducedMotion()) return
	el.animate(
		[
			{
				opacity: 0.35,
				filter: "blur(2px)",
				transform: directionX
					? `translateX(${directionX}px)`
					: "scale(0.985)",
			},
			{ opacity: 1, filter: "blur(0px)", transform: "none" },
		],
		{ duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
	)
}

function renderMobileList() {
	world.innerHTML = ""
	activeNodes.clear()
	for (const id of CARD_IDS) {
		const el = document.createElement("article")
		el.className = "tile"
		el.dataset.tile = id
		el.innerHTML = renderCardMarkup(id)
		world.appendChild(el)
		activeNodes.set(id, { el, cardId: id })
	}
}

function syncVirtualCanvas() {
	if (isMobileStack) return

	const vw = stage.clientWidth
	const vh = stage.clientHeight
	const pad = 1

	const rowMin = Math.floor(camY / STEP_Y) - pad
	const rowMax = Math.floor((camY + vh) / STEP_Y) + pad
	const needed = new Set()
	let enterCount = 0

	for (let row = rowMin; row <= rowMax; row++) {
		const stagger = mod(row, 2) * ROW_STAGGER
		const colMin = Math.floor((camX - stagger) / STEP_X) - pad
		const colMax = Math.floor((camX + vw - stagger) / STEP_X) + pad

		for (let col = colMin; col <= colMax; col++) {
			const key = `${col},${row}`
			needed.add(key)

			if (!activeNodes.has(key)) {
				const cardId = cardIdAt(col, row)
				const el = document.createElement("article")
				el.className = "tile"
				el.dataset.tile = cardId
				el.dataset.cell = key
				el.style.left = `${col * STEP_X + stagger}px`
				el.style.top = `${row * STEP_Y}px`
				el.style.width = `${CARD_W}px`
				el.style.height = `${CARD_H}px`
				if (isInitialPaint) {
					const delay =
						INITIAL_DELAYS[
							Math.min(enterCount, INITIAL_DELAYS.length - 1)
						]
					el.dataset.enter = "true"
					el.style.setProperty("--enter-delay", `${delay}ms`)
					enterCount++
				}
				el.innerHTML = renderCardMarkup(cardId)
				world.appendChild(el)
				activeNodes.set(key, { el, cardId, col, row })
			}
		}
	}

	isInitialPaint = false

	for (const [key, entry] of activeNodes) {
		if (!needed.has(key)) {
			entry.el.remove()
			activeNodes.delete(key)
		}
	}

	world.style.transform = `translate3d(${-camX}px, ${-camY}px, 0)`
}

function positionDockIndicator(activeBtn) {
	if (!dockIndicator || !activeBtn || isMobileStack) return
	dockIndicator.style.width = `${activeBtn.offsetWidth}px`
	dockIndicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`
	dockIndicator.style.opacity = "1"
}

function setActiveDock(id) {
	let matched = null
	for (const btn of dock.querySelectorAll(".dock-btn")) {
		const isCurrent = btn.dataset.jump === id
		btn.setAttribute("aria-current", isCurrent ? "true" : "false")
		if (isCurrent) matched = btn
	}
	if (matched) positionDockIndicator(matched)
}

function updateActiveDockFromCenter() {
	if (isMobileStack) return
	const cx = camX + stage.clientWidth / 2
	const cy = camY + (stage.clientHeight - 48) / 2
	const row = Math.round((cy - CARD_H / 2) / STEP_Y)
	const stagger = mod(row, 2) * ROW_STAGGER
	const col = Math.round((cx - stagger - CARD_W / 2) / STEP_X)
	setActiveDock(cardIdAt(col, row))
}

// Damped spring + inertia loop (velocity-preserving on interruption)
const SPRING_K = 165
const SPRING_D = 24

function tickMotion(now) {
	animFrame = 0
	const dt = Math.min(0.032, Math.max(0.004, (now - lastTickTime) / 1000))
	lastTickTime = now

	if (springTarget) {
		const dx = springTarget.x - camX
		const dy = springTarget.y - camY
		const ax = dx * SPRING_K - vx * SPRING_D
		const ay = dy * SPRING_K - vy * SPRING_D
		vx += ax * dt
		vy += ay * dt
		camX += vx * dt
		camY += vy * dt
		syncVirtualCanvas()

		if (
			Math.abs(dx) < 0.5 &&
			Math.abs(dy) < 0.5 &&
			Math.abs(vx) < 4 &&
			Math.abs(vy) < 4
		) {
			camX = springTarget.x
			camY = springTarget.y
			vx = 0
			vy = 0
			springTarget = null
			syncVirtualCanvas()
			updateActiveDockFromCenter()
		} else {
			animFrame = requestAnimationFrame(tickMotion)
		}
		return
	}

	// Release-phase inertia glide (cancelled under reduced motion)
	if (!prefersReducedMotion() && (Math.abs(vx) > 8 || Math.abs(vy) > 8)) {
		camX += vx * dt
		camY += vy * dt
		const decay = Math.pow(0.045, dt)
		vx *= decay
		vy *= decay
		syncVirtualCanvas()
		animFrame = requestAnimationFrame(tickMotion)
	} else {
		vx = 0
		vy = 0
		updateActiveDockFromCenter()
	}
}

function ensureLoop() {
	if (!animFrame) {
		lastTickTime = performance.now()
		animFrame = requestAnimationFrame(tickMotion)
	}
}

function stopMotion() {
	springTarget = null
	vx = 0
	vy = 0
	if (animFrame) {
		cancelAnimationFrame(animFrame)
		animFrame = 0
	}
}

function jumpToCard(targetId) {
	if (isMobileStack) {
		const el = world.querySelector(`[data-tile="${targetId}"]`)
		el?.scrollIntoView({ behavior: "smooth", block: "start" })
		return
	}

	const vw = stage.clientWidth
	const vh = stage.clientHeight
	const centerWorldX = camX + vw / 2
	const centerWorldY = camY + (vh - 48) / 2
	const approxRow = Math.round((centerWorldY - CARD_H / 2) / STEP_Y)
	const approxCol = Math.round((centerWorldX - CARD_W / 2) / STEP_X)

	let bestX = camX
	let bestY = camY
	let bestDist = Infinity

	for (let r = approxRow - 5; r <= approxRow + 5; r++) {
		const stagger = mod(r, 2) * ROW_STAGGER
		for (let c = approxCol - 5; c <= approxCol + 5; c++) {
			if (cardIdAt(c, r) !== targetId) continue
			const wx = c * STEP_X + stagger + CARD_W / 2
			const wy = r * STEP_Y + CARD_H / 2
			const d = Math.hypot(wx - centerWorldX, wy - centerWorldY)
			if (d < bestDist) {
				bestDist = d
				bestX = wx - vw / 2
				bestY = wy - (vh - 48) / 2
			}
		}
	}

	setActiveDock(targetId)

	if (prefersReducedMotion()) {
		stopMotion()
		camX = bestX
		camY = bestY
		syncVirtualCanvas()
		return
	}

	// Preserve existing vx/vy so interrupting mid-flight redirects smoothly
	springTarget = { x: bestX, y: bestY }
	ensureLoop()
}

// Copy button morph with subtle 2px blur crossfade
function triggerCopyMorph(btn) {
	const text = btn.dataset.copy
	if (text) navigator.clipboard?.writeText(text).catch(() => {})
	const label = btn.querySelector(".copy-label")
	if (!label) return

	clearTimeout(btn._copyTimer1)
	clearTimeout(btn._copyTimer2)
	btn.dataset.morph = "true"

	btn._copyTimer1 = window.setTimeout(() => {
		btn.dataset.copied = "true"
		label.innerHTML = `<svg class="ico ico-xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><span>Copied</span>`
		btn.dataset.morph = "false"
	}, 90)

	btn._copyTimer2 = window.setTimeout(() => {
		btn.dataset.morph = "true"
		window.setTimeout(() => {
			btn.dataset.copied = "false"
			label.textContent = "Copy"
			btn.dataset.morph = "false"
		}, 90)
	}, 1500)
}

// Delegated interactions across all virtualized cards
world.addEventListener("click", e => {
	const copyBtn = e.target.closest("[data-copy]")
	if (copyBtn) {
		e.stopPropagation()
		triggerCopyMorph(copyBtn)
		return
	}

	const skinBtn = e.target.closest("[data-skin]")
	if (skinBtn) {
		e.stopPropagation()
		state.mascot =
			MASCOTS.find(m => m.id === skinBtn.dataset.skin) ?? MASCOTS[0]
		syncBrandHeader(true)
		updateCardsByType("skins")
		updateCardsByType("slack")
		updateCardsByType("takeover")
		return
	}

	const actionEl = e.target.closest("[data-action]")
	if (!actionEl) return
	e.stopPropagation()

	switch (actionEl.dataset.action) {
		case "cycle-prompt":
			state.promptIdx = (state.promptIdx + 1) % SCENARIOS.length
			state.showTrace = false
			updateCardsByType("slack", tileEl => {
				animateBlurSwap(
					tileEl.querySelector("[data-slack-content]"),
					10,
				)
			})
			break

		case "toggle-trace":
			state.showTrace = !state.showTrace
			for (const [, entry] of activeNodes) {
				if (entry.cardId !== "slack") continue
				const wrap = entry.el.querySelector(".s-trace-wrap")
				const btn = entry.el.querySelector(
					'[data-action="toggle-trace"]',
				)
				if (wrap) wrap.dataset.open = String(state.showTrace)
				if (btn) {
					btn.setAttribute("aria-expanded", String(state.showTrace))
					btn.textContent = state.showTrace ? "Hide" : "Steps"
				}
			}
			break

		case "toggle-takeover":
			state.takenOver = !state.takenOver
			updateCardsByType("takeover", tileEl => {
				animateBlurSwap(tileEl.querySelector("[data-takeover-note]"), 0)
			})
			break

		case "toggle-reminder":
			state.reminderPaused = !state.reminderPaused
			updateCardsByType("reminders")
			break

		case "open-install":
			openSheet()
			break
	}
})

// 1:1 Pointer drag with multi-touch protection + exponentially smoothed release velocity
const TEXT_SELECTABLE =
	".s-text, .s-list, .s-trace, .cmd-str, .term-log, .term-alt, .browser-state, .ledger-v, .skin-desc, .pr-title, .pr-meta, .file-name, .file-sub"

let dragging = false
let activePointerId = null
let lastX = 0
let lastY = 0
let lastTime = 0

stage.addEventListener("pointerdown", e => {
	if (isMobileStack || dragging) return
	if (e.target.closest("button, a, nav")) return
	if (e.target.closest(TEXT_SELECTABLE)) return
	stopMotion()
	dragging = true
	activePointerId = e.pointerId
	lastX = e.clientX
	lastY = e.clientY
	lastTime = performance.now()
	stage.classList.add("dragging")
	stage.setPointerCapture(e.pointerId)
})

stage.addEventListener("pointermove", e => {
	if (!dragging || e.pointerId !== activePointerId) return
	const now = performance.now()
	const dx = e.clientX - lastX
	const dy = e.clientY - lastY
	const dt = Math.max(0.004, (now - lastTime) / 1000)

	// 1:1 tracking (no easing/lag during track phase)
	camX -= dx
	camY -= dy

	// Smooth release velocity in px/sec (clamped for natural feel)
	const instVx = Math.max(-2800, Math.min(2800, -dx / dt))
	const instVy = Math.max(-2800, Math.min(2800, -dy / dt))
	vx = vx * 0.65 + instVx * 0.35
	vy = vy * 0.65 + instVy * 0.35

	lastX = e.clientX
	lastY = e.clientY
	lastTime = now
	syncVirtualCanvas()
})

function endDrag(e) {
	if (!dragging || (e && e.pointerId !== activePointerId)) return
	dragging = false
	activePointerId = null
	stage.classList.remove("dragging")
	// Drop stale velocity if finger paused before lifting
	if (performance.now() - lastTime > 70) {
		vx = 0
		vy = 0
	}
	ensureLoop()
}

stage.addEventListener("pointerup", endDrag)
stage.addEventListener("pointercancel", endDrag)

// Trackpad / wheel infinite panning on desktop
stage.addEventListener(
	"wheel",
	e => {
		if (isMobileStack || window.innerWidth <= 900) return
		e.preventDefault()
		stopMotion()
		camX += e.deltaX
		camY += e.deltaY
		syncVirtualCanvas()
		updateActiveDockFromCenter()
	},
	{ passive: false },
)

// Dock navigation & sidebar controls
for (const btn of dock.querySelectorAll(".dock-btn")) {
	btn.addEventListener("click", e => {
		e.stopPropagation()
		jumpToCard(btn.dataset.jump)
	})
}

document.getElementById("focusSlack")?.addEventListener("click", () => {
	state.promptIdx = (state.promptIdx + 1) % SCENARIOS.length
	state.showTrace = false
	updateCardsByType("slack", tileEl => {
		animateBlurSwap(tileEl.querySelector("[data-slack-content]"), 10)
	})
	jumpToCard("slack")
})

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

// Install Sheet dialog with interruptible enter/exit transition + focus restoration
const sheet = document.getElementById("installSheet")
const closeSheetBtn = document.getElementById("closeSheet")
let lastFocused = null

function openSheet() {
	lastFocused = document.activeElement
	sheet.dataset.open = "true"
	sheet.setAttribute("aria-hidden", "false")
	closeSheetBtn?.focus()
}

function closeSheet() {
	if (sheet.dataset.open !== "true") return
	sheet.dataset.open = "false"
	sheet.setAttribute("aria-hidden", "true")
	if (lastFocused instanceof HTMLElement) lastFocused.focus()
}

openInstallBtn?.addEventListener("click", openSheet)
closeSheetBtn?.addEventListener("click", closeSheet)
sheet?.addEventListener("click", e => {
	if (e.target === sheet) closeSheet()
})
sheet?.querySelector("[data-copy]")?.addEventListener("click", e => {
	triggerCopyMorph(e.currentTarget)
})
window.addEventListener("keydown", e => {
	if (e.key === "Escape") closeSheet()
})

function handleLayoutMode() {
	const mobile = window.innerWidth <= 640
	if (mobile !== isMobileStack || activeNodes.size === 0) {
		isMobileStack = mobile
		stopMotion()
		if (isMobileStack) {
			renderMobileList()
		} else {
			world.innerHTML = ""
			activeNodes.clear()
			syncVirtualCanvas()
			updateActiveDockFromCenter()
		}
	} else if (!isMobileStack) {
		syncVirtualCanvas()
		const currentBtn = dock.querySelector('.dock-btn[aria-current="true"]')
		if (currentBtn) positionDockIndicator(currentBtn)
	}
}

window.addEventListener("resize", handleLayoutMode)

syncBrandHeader(false)
handleLayoutMode()
