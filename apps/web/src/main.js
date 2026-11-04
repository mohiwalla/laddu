import { TextMorph } from "torph"

const calm = matchMedia("(prefers-reduced-motion: reduce)")
const sleep = ms => new Promise(resolve => setTimeout(resolve, calm.matches ? 0 : ms))

/** Text that morphs between values, in the page's one easing curve. */
function morph(element, text = element.textContent.trim()) {
	const instance = new TextMorph({ element, duration: 360, ease: "cubic-bezier(0.22, 1, 0.36, 1)" })
	instance.update(text)
	return instance
}

/** Runs `start` once, the first time `element` scrolls into view. */
function onFirstView(element, start) {
	const observer = new IntersectionObserver(entries => {
		if (!entries.some(entry => entry.isIntersecting)) return
		observer.disconnect()
		start()
	}, { threshold: 0.4 })
	observer.observe(element)
}

// Images stay put: no ghost copies when someone drags one.
document.addEventListener("dragstart", event => {
	if (event.target instanceof HTMLImageElement) event.preventDefault()
})

// Booping laddu: it squishes and says something small.
const boop = document.querySelector(".boop")
const bubble = document.querySelector(".bubble")
const lines = ["hehe", "that tickles", "boop", "ji?", "oh, hi :)", "*squish*", "again?", "careful, i crumble"]
let last = -1
let hush

boop?.addEventListener("click", () => {
	let next = Math.floor(Math.random() * lines.length)
	if (next === last) next = (next + 1) % lines.length
	last = next

	bubble.textContent = lines[next]
	bubble.classList.add("show")
	clearTimeout(hush)
	hush = setTimeout(() => bubble.classList.remove("show"), 1600)

	if (calm.matches) return
	boop.classList.remove("squish")
	void boop.offsetWidth
	boop.classList.add("squish")
})

// Copy the install command; the icon turns into a check and the label morphs.
for (const button of document.querySelectorAll("[data-copy]")) {
	const label = morph(button.querySelector(".copy-label"))
	let reset
	button.addEventListener("click", async () => {
		const text = document.getElementById(button.dataset.copy)?.textContent.trim() ?? ""
		let copied = true
		try {
			await navigator.clipboard.writeText(text)
		} catch {
			copied = false
		}
		button.dataset.state = copied ? "done" : "failed"
		label.update(copied ? "Copied" : "Select it")
		clearTimeout(reset)
		reset = setTimeout(() => {
			delete button.dataset.state
			label.update("Copy")
		}, 1800)
	})
}

// The Slack channel: pick a request and laddu works through it, step by step.
const slack = document.querySelector(".slack")
if (slack) {
	const msgs = slack.querySelector(".msgs")
	const draft = slack.querySelector(".draft")
	const placeholder = draft.innerHTML
	const askButtons = [...slack.querySelectorAll(".ask:not(.ask-reset)")]
	const reset = slack.querySelector(".ask-reset")
	const initial = msgs.innerHTML
	// The bundler rewrites asset paths in the HTML only, so borrow the avatar from the page.
	const laddu = msgs.querySelector("img.av").src
	let minute = 4
	let busy = false

	const file = (icon, name, meta) =>
		`<div class="attach"><svg class="ic-lg"><use href="#${icon}" /></svg><div><p class="fname">${name}</p><p class="fmeta">${meta}</p></div></div>`

	const asks = {
		slide: {
			text: "turn the open items into a slide for standup",
			steps: [
				["Reading the thread", "Read the thread"],
				["Checking 4.2 on Azure Boards", "Checked 4.2 on Azure Boards"],
				["Making the slide", "Made the slide"],
			],
			answer: `<p>One slide for standup: the Thursday plan up top, then the 3 open items with their owners.</p>${file("i-slides", "release-4.2-standup.pptx", "PowerPoint · 1 slide · 212 KB")}`,
		},
		assign: {
			text: "assign #4820 to me",
			steps: [
				["Finding #4820 on Azure Boards", "Found #4820 on Azure Boards"],
				["Assigning it to you", "Assigned it to you"],
			],
			answer: "<p>Done. <b>#4820 CSV export drops the last row</b> is yours now, assigned as you on Azure Boards.</p>",
			after: () => {
				const owner = document.getElementById("owner-4820")
				if (owner) morph(owner).update("You")
			},
		},
		remind: {
			text: "remind us Thursday at 9 to cut 4.2",
			steps: [["Scheduling the reminder", "Scheduled the reminder"]],
			answer: "<p>Set. Thursday at 9:00 I’ll post here to cut 4.2, with whatever is still open on Boards by then.</p>",
		},
	}

	const scrollDown = () => msgs.scrollTo({ top: msgs.scrollHeight, behavior: calm.matches ? "auto" : "smooth" })

	function post(html) {
		const message = document.createElement("div")
		message.className = "msg enter"
		message.innerHTML = html
		msgs.append(message)
		scrollDown()
		return message
	}

	async function run(key) {
		const ask = asks[key]
		busy = true
		for (const button of askButtons) button.disabled = true

		// Type the request into the composer, then send it.
		draft.textContent = ""
		const typed = document.createElement("span")
		typed.innerHTML = '<span class="mention">@laddu</span> '
		draft.append(typed)
		const words = document.createTextNode("")
		draft.append(words)
		for (const char of ask.text) {
			words.data += char
			await sleep(22)
		}
		await sleep(240)
		draft.innerHTML = placeholder
		const time = `11:${String(minute++).padStart(2, "0")}`
		post(
			`<span class="av" aria-hidden="true"><svg class="ic"><use href="#i-user" /></svg></span><div class="body"><p class="who">You <time>${time}</time></p><p><span class="mention">@laddu</span> ${ask.text}</p></div>`,
		)

		await sleep(500)
		const reply = post(
			`<img class="av" src="${laddu}" width="160" height="160" alt="" /><div class="body"><p class="who">laddu <span class="app">App</span> <time>${time}</time></p><ul class="steps"></ul></div>`,
		)
		const steps = reply.querySelector(".steps")
		for (const [doing, done] of ask.steps) {
			const step = document.createElement("li")
			step.className = "doing"
			step.innerHTML = '<svg class="ic"><use href="#i-spin" /></svg><span></span>'
			steps.append(step)
			const label = morph(step.querySelector("span"), doing)
			scrollDown()
			await sleep(900)
			step.className = ""
			step.querySelector("use").setAttribute("href", "#i-check")
			label.update(done)
			await sleep(260)
		}
		const answer = document.createElement("div")
		answer.className = "answer enter"
		answer.innerHTML = ask.answer
		reply.querySelector(".body").append(answer)
		scrollDown()
		ask.after?.()

		slack.querySelector(`[data-ask="${key}"]`).hidden = true
		reset.hidden = false
		for (const button of askButtons) button.disabled = false
		busy = false
	}

	for (const button of askButtons) button.addEventListener("click", () => busy || run(button.dataset.ask))
	reset.addEventListener("click", () => {
		if (busy) return
		msgs.innerHTML = initial
		msgs.scrollTo({ top: 0 })
		minute = 4
		for (const button of askButtons) button.hidden = false
		reset.hidden = true
	})
}

// laddu's computer: it fills the form on its own; take over to type yourself, then hand it back.
const desk = document.querySelector(".desk")
if (desk) {
	const form = desk.querySelector(".form")
	const fields = [...form.querySelectorAll("[data-fill]")]
	const status = morph(desk.querySelector(".desk-status"))
	const take = desk.querySelector(".take")
	const takeLabel = morph(take.querySelector(".take-label"))
	const submit = form.querySelector(".submit")
	const submitLabel = morph(submit.querySelector(".submit-label"))
	const again = form.querySelector(".again")
	let mode = "laddu"
	let run = 0

	const setMode = next => {
		mode = next
		desk.dataset.mode = next
		const yours = next === "you"
		for (const field of fields) {
			if (field.tagName === "SELECT") field.disabled = !yours
			else field.readOnly = !yours
		}
		takeLabel.update(yours ? "Hand back" : "Take over")
		take.hidden = next === "sent"
	}

	async function drive() {
		const id = ++run
		setMode("laddu")
		status.update("laddu is filling in a form")
		for (const field of fields) {
			const target = field.dataset.fill
			if (field.tagName === "SELECT") {
				if (field.value) continue
				field.classList.add("active")
				await sleep(500)
				if (id !== run) return
				field.value = target
				field.classList.remove("active")
				continue
			}
			// Leave what you typed; only finish what laddu started or hasn't reached.
			if (!target.startsWith(field.value)) continue
			field.classList.add("active")
			while (field.value !== target) {
				await sleep(45 + Math.random() * 50)
				if (id !== run) return field.classList.remove("active")
				field.value = target.slice(0, field.value.length + 1)
			}
			field.classList.remove("active")
			await sleep(200)
		}
		if (id !== run) return
		status.update("Done. Check it and submit")
		setMode("you")
		takeLabel.update("Take over")
		take.hidden = true
	}

	function clear() {
		for (const field of fields) field.value = ""
	}

	take.addEventListener("click", () => {
		if (mode === "laddu") {
			run++
			for (const field of fields) field.classList.remove("active")
			setMode("you")
			status.update("You’re in control")
			form.querySelector(".field input")?.focus()
		} else {
			drive()
		}
	})

	form.addEventListener("submit", event => {
		event.preventDefault()
		if (mode === "sent") return
		run++
		setMode("sent")
		for (const field of fields) {
			field.classList.remove("active")
			if (field.tagName === "SELECT") field.disabled = true
			else field.readOnly = true
		}
		submit.disabled = true
		submit.dataset.state = "done"
		submitLabel.update("Submitted")
		status.update("Claim submitted")
		again.hidden = false
	})

	again.addEventListener("click", () => {
		again.hidden = true
		submit.disabled = false
		delete submit.dataset.state
		submitLabel.update("Submit claim")
		take.hidden = false
		clear()
		drive()
	})

	// Without JS the form shows filled in; with it, laddu fills it in when you get there.
	clear()
	onFirstView(desk, drive)
}

// The Home tab settings: name, face and brain, with a preview of how the thread sees it.
const home = document.querySelector(".home")
if (home) {
	const name = home.querySelector("#laddu-name")
	const callName = morph(document.querySelector(".call-name"))
	const previewName = morph(home.querySelector(".preview-name"))
	const previewFace = home.querySelector(".preview-face")
	const previewBrain = morph(home.querySelector(".preview-brain"))
	const model = home.querySelector("[name=model]")
	const effort = home.querySelector("[name=effort]")
	const upload = home.querySelector(".upload")
	const uploadRadio = home.querySelector("[name=face][value=upload]")
	const presets = [...home.querySelectorAll("[name=face]")].map(radio => radio.value).filter(value => value !== "upload")

	const brains = {
		codex: { label: "Codex", models: ["gpt-6.1-sol"], efforts: ["low", "medium", "high", "xhigh"] },
		opencode: { label: "OpenCode", models: ["big-pickle"], efforts: ["low", "medium", "high"] },
	}

	const fill = (select, values, keep) => {
		select.replaceChildren(...values.map(value => new Option(value, value)))
		select.value = values.includes(keep) ? keep : values[Math.min(1, values.length - 1)]
	}

	const shownName = () => name.value.trim().replace(/\s+/g, " ") || "laddu"

	function render() {
		callName.update(shownName())
		previewName.update(shownName())
		const face = home.querySelector("[name=face]:checked")
		previewFace.src = face.closest(".face").querySelector(".tile img").src
		const agent = home.querySelector("[name=agent]:checked").value
		previewBrain.update(`${brains[agent].label} · ${model.value} · ${effort.value} effort`)
	}

	function setAgent() {
		const brain = brains[home.querySelector("[name=agent]:checked").value]
		fill(model, brain.models, model.value)
		fill(effort, brain.efforts, effort.value || "medium")
	}

	home.addEventListener("change", event => {
		const target = event.target
		if (target.name === "face" && target.value !== "upload") {
			// Picking a face renames it too, unless you've typed a name of your own.
			const current = name.value.trim().toLowerCase()
			if (!current || presets.some(preset => preset.toLowerCase() === current)) name.value = target.value
		}
		if (target.name === "agent") setAgent()
		render()
	})
	name.addEventListener("input", render)
	home.addEventListener("submit", event => event.preventDefault())

	upload.addEventListener("change", () => {
		const picked = upload.files?.[0]
		if (!picked) return
		const tile = upload.closest(".face")
		const image = tile.querySelector(".tile img")
		if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src)
		image.src = URL.createObjectURL(picked)
		image.hidden = false
		tile.classList.add("has-image")
		uploadRadio.disabled = false
		uploadRadio.checked = true
		render()
	})

	setAgent()
	render()
}
