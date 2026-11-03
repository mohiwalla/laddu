const calm = matchMedia("(prefers-reduced-motion: reduce)")

// Every loop on the page runs only while its section is on screen and the tab is visible.
// Without JS, or with reduced motion, each scene shows its finished frame.
const live = new WeakSet()
const watcher = new IntersectionObserver(
	entries => {
		for (const { target, isIntersecting } of entries) {
			target.classList.toggle("is-live", isIntersecting)
			if (isIntersecting) live.add(target)
			else live.delete(target)
		}
	},
	{ rootMargin: "80px" },
)
for (const section of document.querySelectorAll("[data-live]")) watcher.observe(section)
document.documentElement.classList.add("js")

const active = el => live.has(el.closest("[data-live]")) && !document.hidden

// Waits that stand still while the scene is paused, so a loop picks up exactly where it stopped.
const wait = async (el, ms) => {
	while (ms > 0) {
		await new Promise(resolve => setTimeout(resolve, Math.min(ms, 100)))
		if (active(el)) ms -= 100
	}
}

const typeInto = async (el, target, text, speed = [35, 75]) => {
	target.textContent = ""
	for (const char of text) {
		await wait(el, speed[0] + Math.random() * (speed[1] - speed[0]))
		target.textContent += char
	}
}

// Booping laddu: it squishes, says something small, and a few sprinkles fly off.
const boop = document.querySelector(".boop")
const bubble = document.querySelector(".bubble")
const buddy = document.querySelector(".buddy")

const lines = ["hehe", "that tickles!", "boop!", "ji?", "oh! hi :)", "*squish*", "again?", "careful, i crumble"]
const sprinkles = ["#ffa24f", "#ff8fb1", "#93c062", "#ffd27a"]
let last = -1
let hush

const say = (el, text, ms = 1600) => {
	el.textContent = text
	el.classList.add("show")
	clearTimeout(el.hush)
	el.hush = setTimeout(() => el.classList.remove("show"), ms)
}

boop?.addEventListener("click", () => {
	let next = Math.floor(Math.random() * lines.length)
	if (next === last) next = (next + 1) % lines.length
	last = next
	say(bubble, lines[next])

	if (calm.matches) return
	boop.classList.remove("squish")
	void boop.offsetWidth
	boop.classList.add("squish")
	burst(7)
})

// A few boondi sprinkles fly off laddu: when booped, and when its reply lands.
function burst(count) {
	for (let i = 0; i < count; i++) {
		const crumb = document.createElement("span")
		const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6
		const distance = 90 + Math.random() * 70
		crumb.className = "crumb"
		crumb.style.background = sprinkles[i % sprinkles.length]
		crumb.style.setProperty("--x", `${Math.cos(angle) * distance}px`)
		crumb.style.setProperty("--y", `${Math.sin(angle) * distance}px`)
		crumb.style.setProperty("--r", `${Math.random() * 540 - 270}deg`)
		buddy.append(crumb)
		crumb.addEventListener("animationend", () => crumb.remove())
	}
}

// laddu's little moves: one now and then, never the same twice in a row.
const moves = {
	hop: [
		{ transform: "translateY(0)" },
		{ transform: "translateY(-26px) scale(0.94, 1.08)", offset: 0.4 },
		{ transform: "translateY(0) scale(1.1, 0.9)", offset: 0.72 },
		{ transform: "none" },
	],
	tilt: [
		{ transform: "rotate(0)" },
		{ transform: "rotate(-14deg)", offset: 0.3 },
		{ transform: "rotate(-14deg)", offset: 0.7 },
		{ transform: "rotate(0)" },
	],
	spin: [{ transform: "rotate(0)" }, { transform: "translateY(-14px) rotate(180deg)", offset: 0.5 }, { transform: "rotate(360deg)" }],
	wiggle: [
		{ transform: "rotate(0)" },
		{ transform: "rotate(9deg)" },
		{ transform: "rotate(-8deg)" },
		{ transform: "rotate(6deg)" },
		{ transform: "rotate(0)" },
	],
	peek: [
		{ transform: "translateX(0)" },
		{ transform: "translateX(-18px) rotate(-6deg)", offset: 0.35 },
		{ transform: "translateX(-18px) rotate(-6deg)", offset: 0.65 },
		{ transform: "translateX(0)" },
	],
}
const move = (el, name, duration = 800) =>
	el.animate(moves[name], { duration, easing: "cubic-bezier(0.3, 1.4, 0.5, 1)" }).finished.catch(() => {})

if (buddy && !calm.matches) {
	;(async () => {
		await wait(buddy, 1600)
		let previous
		for (;;) {
			await wait(buddy, 2600 + Math.random() * 2800)
			const names = Object.keys(moves).filter(name => name !== previous)
			previous = names[Math.floor(Math.random() * names.length)]
			await move(buddy, previous, previous === "spin" ? 1000 : 900)
		}
	})()

	// Leans toward the pointer, on devices that have one.
	const hero = document.querySelector(".hero")
	if (matchMedia("(pointer: fine)").matches)
		hero.addEventListener("pointermove", event => {
			const box = buddy.getBoundingClientRect()
			const look = (event.clientX - (box.left + box.width / 2)) / (innerWidth / 2)
			boop.style.setProperty("--look", Math.max(-1, Math.min(1, look)).toFixed(2))
		})
}

// The Slack thread replays the real conversation, over and over. The card starts small, with just
// your message being typed, and grows as the conversation happens: sent, worked on, answered.
// The stage keeps room for the finished thread, so nothing below the hero ever moves.
const thread = document.querySelector("[data-thread]")

if (thread && !calm.matches) {
	thread
		.querySelectorAll(".reply .who, .reply .ln, .reply .react")
		.forEach((el, i) => el.style.setProperty("--i", i + 1))
	const stage = thread.closest(".stage")
	const typed = thread.querySelector(".typed")
	const step = thread.querySelector(".work-text")
	const question = thread.querySelector(".ask .grow p:last-child").textContent
	let current = ""

	// Room for the finished thread: measured with every phase class off, in one synchronous step.
	const reserve = () => {
		for (const animation of thread.getAnimations()) animation.cancel()
		thread.className = "thread"
		stage.style.minHeight = ""
		stage.style.minHeight = `${stage.offsetHeight}px`
		if (current) thread.className = `thread p-${current}`
	}
	reserve()
	addEventListener("resize", reserve)

	// Switches phase and eases the card from its old height to its new one.
	const phase = (name, duration = 550) => {
		const from = thread.offsetHeight
		current = name
		thread.className = `thread p-${name}`
		const to = thread.offsetHeight
		if (from !== to)
			thread.animate([{ height: `${from}px` }, { height: `${to}px` }], {
				duration,
				easing: "cubic-bezier(0.16, 1, 0.3, 1)",
			})
	}

	;(async () => {
		for (;;) {
			typed.textContent = ""
			phase("typing", 600)
			await wait(thread, 600)
			await typeInto(thread, typed, question)
			await wait(thread, 350)
			typed.textContent = ""
			phase("sent", 450)
			await wait(thread, 650)
			step.textContent = "Looking through your past chats"
			phase("working", 400)
			move(buddy, "tilt", 900)
			await wait(thread, 1100)
			step.classList.add("swap")
			await wait(thread, 200)
			step.textContent = "Putting it together"
			step.classList.remove("swap")
			await wait(thread, 900)
			phase("reply", 1100)
			move(buddy, "hop", 800)
			burst(9)
			await wait(thread, 8000)
			current = "out"
			thread.className = "thread p-reply p-out"
			await wait(thread, 450)
		}
	})()
}

// laddu's computer: it opens the browser, finds a file, saves it, lets you take over, then carries on.
const desk = document.querySelector("[data-scene]")

if (desk && !calm.matches) {
	const $ = selector => desk.querySelector(selector)
	const screen = $(".screen")
	const laddu = $(".laddu-cursor")
	const you = $(".you-cursor")
	const status = $(".status-text")
	const url = $(".url-text")
	const globe = $(".dock .app")
	const peek = $(".peek")

	const phase = name => (desk.dataset.phase = name)
	const tell = text => (status.textContent = text)
	const spot = (target, x = 0.5, y = 0.5) => {
		const s = screen.getBoundingClientRect()
		const r = (typeof target === "string" ? $(target) : target).getBoundingClientRect()
		return [r.left - s.left + r.width * x, r.top - s.top + r.height * y]
	}
	const goTo = (cursor, target, x, y) => {
		const [left, top] = spot(target, x, y)
		cursor.style.left = `${left}px`
		cursor.style.top = `${top}px`
	}
	const jumpTo = (cursor, target, x, y) => {
		cursor.style.transition = "opacity 0.3s"
		goTo(cursor, target, x, y)
		void cursor.offsetWidth
		cursor.style.transition = ""
	}
	const click = async (cursor, pressClass) => {
		cursor.classList.remove("click")
		void cursor.offsetWidth
		cursor.classList.add("click")
		if (pressClass) {
			desk.classList.add(pressClass)
			await wait(desk, 160)
			desk.classList.remove(pressClass)
		}
	}
	const fly = async () => {
		const [x0, y0] = spot(".dl")
		const [x1, y1] = spot(".saved .ico")
		const midX = (x0 + x1) / 2
		const midY = Math.min(y0, y1) - 50
		await $(".flying").animate(
			[
				{ opacity: 1, transform: `translate(${x0}px, ${y0}px) scale(0.6)` },
				{ opacity: 1, transform: `translate(${midX}px, ${midY}px) scale(1.3) rotate(-20deg)`, offset: 0.5 },
				{ opacity: 1, transform: `translate(${x1 - 11}px, ${y1 - 11}px) scale(1)` },
			],
			{ duration: 900, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
		).finished
	}

	;(async () => {
		await wait(desk, 400)
		for (;;) {
			phase("idle")
			tell("laddu is ready")
			url.textContent = ""
			goTo(laddu, screen, 0.55, 0.5)
			jumpTo(you, screen, 1.05, 1.05)
			await wait(desk, 1100)

			tell("Opening the browser")
			goTo(laddu, globe)
			await wait(desk, 1000)
			await click(laddu)
			globe.classList.remove("bounce")
			void globe.offsetWidth
			globe.classList.add("bounce")
			phase("launch")
			await wait(desk, 800)

			phase("type")
			tell("laddu is browsing")
			goTo(laddu, ".url", 0.3, 0.6)
			await wait(desk, 500)
			await typeInto(desk, url, "laddu.wtf", [70, 130])
			await wait(desk, 300)

			phase("load")
			tell("Reading the page")
			await wait(desk, 900)
			goTo(laddu, ".dl", 0.6, 0.6)
			await wait(desk, 1000)
			await click(laddu, "is-clicking")
			tell("Downloading report.xlsx")
			await fly()

			phase("save")
			tell("Saved to its files")
			move(peek, "hop", 800)
			await wait(desk, 1400)

			tell("You can take over anytime")
			goTo(laddu, ".takeover")
			await wait(desk, 1100)
			jumpTo(you, ".takeover", 0.4, 0.7)
			await click(laddu, "is-pressing")
			phase("take")
			tell("You’re driving")
			await wait(desk, 700)

			phase("you")
			for (const [target, x, y] of [
				[".row .card:nth-child(1)", 0.5, 0.5],
				[".row .card:nth-child(3)", 0.6, 0.4],
				[".w60", 0.8, 0.5],
			]) {
				goTo(you, target, x, y)
				await wait(desk, 850)
				await click(you)
			}
			goTo(you, ".takeover", 0.5, 0.6)
			await wait(desk, 1000)
			await click(you, "is-pressing")
			jumpTo(laddu, ".takeover", 0.5, 0.6)

			phase("back")
			tell("Back to laddu")
			goTo(you, screen, 1.05, 1.05)
			move(peek, "wiggle", 900)
			await wait(desk, 1300)

			phase("close")
			tell("All done. The file stays put")
			goTo(laddu, screen, 0.55, 0.5)
			await wait(desk, 1900)
		}
	})()
}

// The installer types itself, prints what it really prints, and laddu says hi in Slack.
const term = document.querySelector("[data-term]")

if (term && !calm.matches) {
	const wrap = term.closest(".term-wrap")
	const rows = [...term.querySelectorAll(".t-line")]
	const typed = term.querySelector(".t-typed")
	const command = rows[0].dataset.type

	;(async () => {
		for (;;) {
			wrap.classList.remove("toasted")
			wrap.classList.add("is-playing")
			term.classList.add("is-playing")
			for (const row of rows) row.classList.remove("on")
			rows[0].classList.add("on")
			await wait(term, 600)
			await typeInto(term, typed, command, [40, 90])
			await wait(term, 500)
			for (const row of rows.slice(1)) {
				row.classList.add("on")
				await wait(term, row.classList.contains("t-say") ? 650 : 380)
			}
			await wait(term, 500)
			wrap.classList.add("toasted")
			await wait(term, 5500)
		}
	})()
}

// The gang: each one has its own idle in CSS; booping makes it squish and say something.
for (const plate of document.querySelectorAll(".friend-plate")) {
	const said = plate.querySelector(".friend-bubble")
	const words = plate.dataset.says.split("|")
	let n = 0
	plate.addEventListener("click", () => {
		say(said, words[n++ % words.length], 1400)
		if (calm.matches) return
		plate.querySelector("img").animate(
			[
				{ transform: "scale(1, 1)" },
				{ transform: "scale(1.2, 0.78)", offset: 0.2 },
				{ transform: "scale(0.9, 1.12) translateY(-8%)", offset: 0.45 },
				{ transform: "scale(1.04, 0.96)", offset: 0.7 },
				{ transform: "scale(1, 1)" },
			],
			{ duration: 700, easing: "cubic-bezier(0.3, 1.2, 0.5, 1)" },
		)
	})
}

for (const button of document.querySelectorAll("[data-copy]")) {
	const label = button.querySelector("[data-label]")
	const idle = label.textContent
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(button.dataset.copy)
			label.textContent = "Copied! Paste it on your server"
		} catch {
			label.textContent = "Select the command"
		}
		setTimeout(() => (label.textContent = idle), 2600)
	})
}

// Sections marked data-pointer follow the pointer: --mx and --my run from -1 to 1 across the section.
const pointerFine = matchMedia("(pointer: fine)").matches
if (pointerFine && !calm.matches)
	for (const section of document.querySelectorAll("[data-pointer]")) {
		let frame
		section.addEventListener("pointermove", event => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const box = section.getBoundingClientRect()
				section.style.setProperty("--mx", (((event.clientX - box.left) / box.width) * 2 - 1).toFixed(3))
				section.style.setProperty("--my", (((event.clientY - box.top) / box.height) * 2 - 1).toFixed(3))
			})
		})
		section.addEventListener("pointerleave", () => {
			cancelAnimationFrame(frame)
			section.style.setProperty("--mx", "0")
			section.style.setProperty("--my", "0")
		})
	}

// The headline arrives word by word.
const headline = document.querySelector(".hero h1")
if (headline && !calm.matches) {
	const words = headline.textContent.trim().split(/\s+/)
	headline.textContent = ""
	words.forEach((word, i) => {
		const span = document.createElement("span")
		span.className = "w"
		span.style.setProperty("--w", i)
		span.textContent = word
		headline.append(span, i < words.length - 1 ? " " : "")
	})
}

// Brains: the Home tab preview. Click to pick; left alone, it keeps trying things on its own.
const picker = document.querySelector("[data-picker]")

if (picker) {
	const wrap = picker.closest(".picker-wrap")
	const model = picker.querySelector(".model")
	const speedButtons = picker.querySelectorAll("[data-speed]:not([data-picker])")
	const state = { agent: "codex", effort: 1, speed: "standard" }

	const render = () => {
		picker.dataset.agent = state.agent
		picker.dataset.effort = state.effort
		picker.dataset.speed = state.speed
		wrap.dataset.level = state.effort
		wrap.style.setProperty("--level", state.effort)
		for (const button of picker.querySelectorAll("button")) {
			const { agent, effort, speed } = button.dataset
			const on =
				(agent && agent === state.agent) ||
				(effort && Number(effort) === state.effort) ||
				(speed && speed === state.speed)
			button.setAttribute("aria-pressed", String(Boolean(on)))
		}
		// Fast is a Codex option, so it switches off with OpenCode.
		for (const button of speedButtons) button.disabled = state.agent === "opencode"
		const text = state.agent === "codex" ? "From your ChatGPT plan" : "Free models"
		if (model.textContent !== text) {
			model.textContent = text
			model.classList.remove("swap")
			void model.offsetWidth
			model.classList.add("swap")
		}
	}

	let touched = 0
	picker.addEventListener("click", event => {
		const button = event.target.closest("button")
		if (!button || button.disabled) return
		const { agent, effort, speed } = button.dataset
		if (agent) state.agent = agent
		if (effort) state.effort = Number(effort)
		if (speed) state.speed = speed
		if (state.agent === "opencode") state.speed = "standard"
		touched = Date.now()
		render()
	})
	render()

	if (!calm.matches)
		(async () => {
			const tour = [
				{ effort: 2 },
				{ effort: 3 },
				{ speed: "fast" },
				{ agent: "opencode", speed: "standard" },
				{ effort: 0 },
				{ effort: 1 },
				{ agent: "codex" },
			]
			for (let i = 0; ; i = (i + 1) % tour.length) {
				await wait(picker, 1000)
				// Someone is choosing: leave the controls to them for a moment.
				if (Date.now() - touched < 6000 || picker.matches(":hover, :focus-within")) continue
				Object.assign(state, tour[i])
				render()
			}
		})()
}

// What laddu can reach: it reaches out from its own computer. Things it can reach light up green;
// for the rest the beam stops at its wall. Hovering a thing, or a fact below, makes it try that one.
const reach = document.querySelector("[data-reach]")

if (reach && !calm.matches) {
	const box = reach.querySelector(".box")
	const svg = reach.querySelector(".beam")
	const beam = svg.querySelector(".beam-path")
	const reveal = svg.querySelector(".beam-reveal")
	const ghost = svg.querySelector(".beam-ghost")
	const head = svg.querySelector(".beam-head")
	const can = [...reach.querySelectorAll(".can .thing")]
	const cant = [...reach.querySelectorAll(".cant .thing")]
	const facts = [...document.querySelectorAll(".facts-grid [data-focus]")]
	let turn = 0
	let hovering = false

	const settle = () => {
		for (const thing of [...can, ...cant]) thing.classList.remove("hit", "bonk")
		box.classList.remove("bonk")
		box.style.setProperty("--aim", "0")
		for (const fact of facts) fact.classList.remove("is-on")
	}

	// Moves the sparkle at the front of the stream along the arc, from one fraction of it to another.
	const glide = (total, from, to, duration, mine) =>
		new Promise(resolve => {
			const start = performance.now()
			const step = now => {
				if (mine !== turn) return resolve()
				const k = Math.min(1, (now - start) / duration)
				const eased = 1 - (1 - k) ** 3
				const point = beam.getPointAtLength(total * (from + (to - from) * eased))
				head.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${k * 180})`)
				if (k < 1) requestAnimationFrame(step)
				else resolve()
			}
			requestAnimationFrame(step)
		})

	// quick: the snappier version used when someone hovers, so the answer arrives right away.
	const reachFor = async (thing, quick = false) => {
		const mine = ++turn
		settle()
		for (const fact of facts) fact.classList.toggle("is-on", fact.dataset.focus === thing.dataset.fact)
		for (const el of [svg, reveal, ghost, head]) for (const animation of el.getAnimations()) animation.cancel()

		const area = reach.getBoundingClientRect()
		const b = box.getBoundingClientRect()
		const t = thing.getBoundingClientRect()
		const cx = b.left + b.width / 2 - area.left
		const cy = b.top + b.height / 2 - area.top
		// The point of the item nearest to laddu, then the direction to it.
		const tx = Math.max(t.left, Math.min(b.left + b.width / 2, t.right)) - area.left
		const ty = Math.max(t.top, Math.min(b.top + b.height / 2, t.bottom)) - area.top
		const length = Math.hypot(tx - cx, ty - cy) || 1
		const [dx, dy] = [(tx - cx) / length, (ty - cy) / length]
		const radius = b.width / 2
		const allowed = can.includes(thing)

		// An arc rather than a straight line: the control point sits off to the side, always bowing upward.
		const [x0, y0] = [cx + dx * radius * 0.62, cy + dy * radius * 0.62]
		let [px, py] = [-dy, dx]
		if (py > 0) [px, py] = [-px, -py]
		const bow = Math.min(90, length * 0.3)
		const [qx, qy] = [(x0 + tx) / 2 + px * bow, (y0 + ty) / 2 + py * bow]
		const d = `M${x0} ${y0} Q${qx} ${qy} ${tx} ${ty}`
		for (const path of [beam, reveal, ghost]) path.setAttribute("d", d)
		beam.setAttribute("class", `beam-path${allowed ? "" : " no"}`)
		head.setAttribute("class", `beam-head${allowed ? "" : " no"}`)

		// Where the arc meets laddu's fence: the stream stops there when it isn't allowed out.
		const total = beam.getTotalLength()
		let stop = 1
		if (!allowed)
			for (let k = 0; k <= 1; k += 0.01) {
				const point = beam.getPointAtLength(total * k)
				if (Math.hypot(point.x - cx, point.y - cy) >= radius + 2) {
					stop = k
					break
				}
			}

		box.style.setProperty("--aim", dx.toFixed(2))
		svg.style.opacity = "1"
		if (!allowed) ghost.animate([{ opacity: 0 }, { opacity: 0.45 }], { duration: 300, fill: "forwards" })
		head.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: "forwards" })
		const duration = quick ? (allowed ? 360 : 260) : allowed ? 650 : 380
		reveal.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 100 - stop * 100 }], {
			duration,
			easing: "cubic-bezier(0.33, 1, 0.68, 1)",
			fill: "forwards",
		})
		await glide(total, 0, stop, duration, mine)
		if (mine !== turn) return

		thing.classList.add(allowed ? "hit" : "bonk")
		if (allowed)
			head.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: "forwards" })
		else {
			// Bonk: the fence flashes and the sparkle bounces back a little.
			box.classList.add("bonk")
			await glide(total, stop, Math.max(0, stop - 0.12), quick ? 160 : 260, mine)
			await glide(total, Math.max(0, stop - 0.12), stop - 0.03, quick ? 120 : 200, mine)
		}
		await wait(reach, quick ? 700 : 950)
		if (mine !== turn) return
		await svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished.catch(() => {})
		if (mine === turn) settle()
	}

	let lastHover = 0
	let hoverRun = 0
	const hoverStart = () => {
		hovering = true
		lastHover = Date.now()
		return ++hoverRun
	}
	const hoverEnd = () => {
		hovering = false
		lastHover = Date.now()
	}

	for (const thing of [...can, ...cant]) {
		thing.addEventListener("pointerenter", () => {
			hoverStart()
			reachFor(thing, true)
		})
		thing.addEventListener("pointerleave", hoverEnd)
	}
	for (const fact of facts) {
		fact.addEventListener("pointerenter", async () => {
			const run = hoverStart()
			for (const thing of [...can, ...cant].filter(each => each.dataset.fact === fact.dataset.focus)) {
				await reachFor(thing, true)
				if (run !== hoverRun || !hovering) break
			}
		})
		fact.addEventListener("pointerleave", hoverEnd)
	}

	// Left alone, it keeps trying: one it can reach, then one it can't.
	;(async () => {
		await wait(reach, 900)
		const order = can.flatMap((thing, i) => [thing, cant[i]]).filter(Boolean)
		for (let i = 0; ; i = (i + 1) % order.length) {
			// Waits while someone is hovering, and for a moment after, so it never cuts in.
			if (!hovering && Date.now() - lastHover > 1500) await reachFor(order[i])
			await wait(reach, 350)
		}
	})()
}

// The gang notices the pointer: each one leans toward it and perks up as it comes close,
// and a few boondi sprinkles trail behind.
const gang = document.querySelector(".gang")

if (gang && pointerFine && !calm.matches) {
	const bodies = [...gang.querySelectorAll(".friend-plate")]
	let frame
	let lastDrop = 0
	gang.addEventListener("pointermove", event => {
		cancelAnimationFrame(frame)
		frame = requestAnimationFrame(() => {
			for (const plate of bodies) {
				const box = plate.getBoundingClientRect()
				const dx = event.clientX - (box.left + box.width / 2)
				const dy = event.clientY - (box.top + box.height / 2)
				const near = Math.max(0, 1 - Math.hypot(dx, dy) / (box.width * 1.1))
				plate.style.setProperty("--lean", Math.max(-14, Math.min(14, dx / 18)).toFixed(1))
				plate.style.setProperty("--near", near.toFixed(2))
			}
		})

		if (event.timeStamp - lastDrop < 45) return
		lastDrop = event.timeStamp
		const bit = document.createElement("span")
		bit.className = "trail"
		bit.style.left = `${event.clientX}px`
		bit.style.top = `${event.clientY}px`
		bit.style.background = sprinkles[Math.floor(Math.random() * sprinkles.length)]
		bit.style.setProperty("--tx", `${Math.random() * 40 - 20}px`)
		bit.style.setProperty("--ty", `${20 + Math.random() * 30}px`)
		bit.style.setProperty("--r", `${Math.random() * 360}deg`)
		document.body.append(bit)
		bit.addEventListener("animationend", () => bit.remove())
	})
	gang.addEventListener("pointerleave", () => {
		cancelAnimationFrame(frame)
		for (const plate of bodies) {
			plate.style.setProperty("--lean", "0")
			plate.style.setProperty("--near", "0")
		}
	})
}
