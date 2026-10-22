// Booping laddu: it squishes, says something small, and a few sprinkles fly off.
const boop = document.querySelector(".boop")
const bubble = document.querySelector(".bubble")
const stage = document.querySelector(".stage")
const calm = matchMedia("(prefers-reduced-motion: reduce)")

const lines = ["hehe", "that tickles!", "boop!", "ji?", "oh! hi :)", "*squish*", "again?", "careful, i crumble"]
const sprinkles = ["#ffa24f", "#ff8fb1", "#93c062", "#ffd27a"]
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

	for (let i = 0; i < 7; i++) {
		const crumb = document.createElement("span")
		const angle = (Math.PI * 2 * i) / 7 + Math.random() * 0.6
		const distance = 120 + Math.random() * 90
		crumb.className = "crumb"
		crumb.style.background = sprinkles[i % sprinkles.length]
		crumb.style.setProperty("--x", `${Math.cos(angle) * distance}px`)
		crumb.style.setProperty("--y", `${Math.sin(angle) * distance}px`)
		crumb.style.setProperty("--r", `${Math.random() * 540 - 270}deg`)
		stage.append(crumb)
		crumb.addEventListener("animationend", () => crumb.remove())
	}
})

for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		const text = document.getElementById(button.dataset.copy)?.textContent ?? ""
		try {
			await navigator.clipboard.writeText(text)
			button.textContent = "Copied!"
		} catch {
			button.textContent = "Select it"
		}
		setTimeout(() => (button.textContent = "Copy"), 1800)
	})
}
