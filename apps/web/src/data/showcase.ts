export interface Mascot {
	id: string
	name: string
	thumb: string
	hero: string
}

export interface SlackScenario {
	channel: string
	caption: string
	user: string
	init: string
	time: string
	askBefore: string
	askAfter: string
	stepSuffix: string
	trace: readonly [string, string][]
	reply: string
	bullets: readonly [string, string][]
	reactions: readonly { emoji: string; count: number }[]
	file: { name: string; meta: string } | null
}

export const INSTALL_COMMAND = "curl -fsSL https://laddu.wtf/install.sh | sh"

export const MASCOTS: readonly Mascot[] = [
	{
		id: "laddu",
		name: "laddu",
		thumb: "/mascots/laddu-160.webp",
		hero: "/mascots/laddu-512.webp",
	},
	{
		id: "jalebi",
		name: "jalebi",
		thumb: "/mascots/jalebi-160.webp",
		hero: "/mascots/jalebi-512.webp",
	},
	{
		id: "kaju",
		name: "kaju",
		thumb: "/mascots/kaju-katli-160.webp",
		hero: "/mascots/kaju-katli-512.webp",
	},
	{
		id: "jamun",
		name: "jamun",
		thumb: "/mascots/gulab-jamun-160.webp",
		hero: "/mascots/gulab-jamun-512.webp",
	},
	{
		id: "rasgulla",
		name: "rasgulla",
		thumb: "/mascots/rasgulla-160.webp",
		hero: "/mascots/rasgulla-512.webp",
	},
]

export const SCENARIOS: readonly SlackScenario[] = [
	{
		channel: "product",
		caption: "Based on a real reply",
		user: "You",
		init: "Y",
		time: "10:14 AM",
		askBefore: "hi ",
		askAfter: ", what can you do for me?",
		stepSuffix: "checked your memory · 1.2s",
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
		reactions: [
			{ emoji: "👀", count: 2 },
			{ emoji: "⚡", count: 3 },
		],
		file: null,
	},
	{
		channel: "launch",
		caption: "Real file output",
		user: "Maya",
		init: "M",
		time: "2:08 PM",
		askBefore: "",
		askAfter:
			" turn this thread’s launch notes into a Q4 tracker spreadsheet",
		stepSuffix: "read 14 replies & built workbook · 8.6s",
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
		reactions: [
			{ emoji: "✅", count: 4 },
			{ emoji: "🙌", count: 2 },
		],
		file: { name: "q4-launch-tracker.xlsx", meta: "48 KB · In Slack" },
	},
	{
		channel: "eng",
		caption: "Ships pull requests",
		user: "Dev",
		init: "D",
		time: "4:41 PM",
		askBefore: "",
		askAfter:
			" fix the flaky webhook retry test and open a PR on Azure Repos",
		stepSuffix: "ran tests & pushed branch · 21.4s",
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
		reactions: [
			{ emoji: "🚀", count: 3 },
			{ emoji: "💚", count: 2 },
		],
		file: { name: "PR #418 · fix/webhook-retry-test", meta: "Azure Repos" },
	},
]

export const EXTRA_HANDCRAFTED_IDS = [
	"stop",
	"dm",
	"home",
	"research",
	"audit",
	"browser",
	"writing",
	"systemd",
	"persist",
	"privacy",
	"threads",
	"private",
] as const

export type ExtraHandcraftedId = (typeof EXTRA_HANDCRAFTED_IDS)[number]

export type CardId = string

export interface MasonryItem {
	id: CardId
	x: number
	y: number
	w: number
	h: number
}

const GAP = 24

interface ColumnDef {
	w: number
	phase: number
	cards: readonly [CardId, number][]
}

// Seamless 5712x2592 repeating asymmetric masonry macro-tile (96 unique cards across 12 columns × 8 rows).
// Every column sums to 2400px of card heights + 192px (8 × 24px gutters) = 2592px, with staggered
// vertical phase offsets so seams never align into a table and repeats stay screens apart.
const COLUMNS: readonly ColumnDef[] = [
	{
		w: 520,
		phase: 0,
		cards: [
			["slack", 416],
			["systemd", 252],
			["files", 312],
			["sm-review", 280],
			["mc-spark", 300],
			["d-sql", 292],
			["p-onebox", 256],
			["wf-ado", 292],
		],
	},
	{
		w: 448,
		phase: 140,
		cards: [
			["install", 244],
			["skins", 388],
			["audit", 284],
			["browser", 316],
			["sm-ops", 308],
			["fa-xlsx", 292],
			["int-claude", 276],
			["wf-2fa", 292],
		],
	},
	{
		w: 384,
		phase: -115,
		cards: [
			["isolation", 476],
			["oss", 256],
			["dm", 268],
			["m-jalebi", 256],
			["ck-security", 296],
			["fa-pdf", 288],
			["t-volumes", 260],
			["wf-recall", 300],
		],
	},
	{
		w: 468,
		phase: 210,
		cards: [
			["models", 368],
			["research", 292],
			["prs", 288],
			["writing", 292],
			["p-noseats", 256],
			["mc-bars", 308],
			["sm-csv", 312],
			["t-logs", 284],
		],
	},
	{
		w: 420,
		phase: -70,
		cards: [
			["m365", 312],
			["takeover", 376],
			["memory", 272],
			["stop", 284],
			["int-openai", 284],
			["d-oauth", 304],
			["p-isolated", 272],
			["fa-pptx", 296],
		],
	},
	{
		w: 496,
		phase: 165,
		cards: [
			["reminders", 336],
			["persist", 300],
			["home", 316],
			["private", 284],
			["mc-firewall", 308],
			["sm-design", 304],
			["t-restart", 288],
			["m-laddu", 264],
		],
	},
	{
		w: 404,
		phase: -150,
		cards: [
			["privacy", 260],
			["sm-deck", 316],
			["wf-m365", 316],
			["mc-waterfall", 316],
			["fa-docx", 300],
			["int-antigravity", 288],
			["d-csv", 304],
			["ck-creds", 300],
		],
	},
	{
		w: 512,
		phase: 95,
		cards: [
			["threads", 272],
			["mc-stacked", 312],
			["d-docker", 312],
			["sm-triage", 304],
			["p-ownkey", 272],
			["wf-digest", 324],
			["fa-csv", 300],
			["t-install-check", 304],
		],
	},
	{
		w: 392,
		phase: -40,
		cards: [
			["sm-standup", 304],
			["int-azure", 296],
			["p-inslack", 264],
			["ck-admin", 304],
			["mc-split", 316],
			["d-ts", 316],
			["m-kaju", 276],
			["wf-runbook", 324],
		],
	},
	{
		w: 460,
		phase: 190,
		cards: [
			["sm-docker", 316],
			["mc-ring", 316],
			["fa-md", 300],
			["p-realos", 272],
			["wf-cc", 320],
			["int-opencode", 292],
			["d-retry", 312],
			["t-bun", 272],
		],
	},
	{
		w: 432,
		phase: -125,
		cards: [
			["int-stack", 304],
			["sm-pdf", 320],
			["p-nolan", 280],
			["ck-teammate", 312],
			["t-git", 288],
			["fa-svg", 308],
			["m-jamun", 280],
			["d-ci", 308],
		],
	},
	{
		w: 488,
		phase: 110,
		cards: [
			["sm-onboard", 320],
			["t-docker", 300],
			["p-reboot", 288],
			["ck-linux", 320],
			["t-firewall", 300],
			["m-rasgulla", 292],
			["t-cron", 292],
			["p-source", 288],
		],
	},
]

function buildLayout(columns: readonly ColumnDef[]): {
	macroW: number
	macroH: number
	items: MasonryItem[]
} {
	const items: MasonryItem[] = []
	let x = 0
	let macroH = 0

	for (const col of columns) {
		let y = col.phase
		for (const [id, h] of col.cards) {
			items.push({ id, x, y, w: col.w, h })
			y += h + GAP
		}
		const colH = y - col.phase
		if (macroH === 0) macroH = colH
		x += col.w + GAP
	}

	return { macroW: x, macroH, items }
}

const LAYOUT = buildLayout(COLUMNS)

export const MACRO_W = LAYOUT.macroW
export const MACRO_H = LAYOUT.macroH
export const MASONRY_LAYOUT: readonly MasonryItem[] = LAYOUT.items

export const DOCK_ITEMS: readonly { id: CardId; label: string }[] = [
	{ id: "slack", label: "Slack" },
	{ id: "install", label: "Install" },
	{ id: "takeover", label: "Desktop" },
	{ id: "isolation", label: "Isolation" },
	{ id: "models", label: "Models" },
	{ id: "prs", label: "PRs" },
	{ id: "files", label: "Files" },
	{ id: "skins", label: "Avatar" },
]
