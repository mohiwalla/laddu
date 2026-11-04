/**
 * laddu's Home tab: each person's own page, split into tabs (Slack allows apps no tabs of their
 * own, so these are buttons that switch what the page shows). Overview: what laddu is working on,
 * scheduled tasks and automations. Skills: the how-to guides laddu keeps for them. Memory: what
 * laddu remembers. Settings: agent and model, name and picture, connected accounts (ChatGPT, Slack, Microsoft),
 * and everything else it can use for them (keys, MCP servers, accounts on its computer). Redrawn
 * whenever they open it and after every change made here; only they can see it, and every control
 * acts only on their own things.
 */
import type { App, types } from "@slack/bolt"
import type { BotConfig } from "../config"
import { codexAccount, signIn, signOut } from "../agent/account"
import { AGENTS, isAgent } from "../agent/agents"
import {
	appearance,
	cleanName,
	MAX_NAME,
	MAX_PICTURE_BYTES,
	nameProblem,
	pictureUrl,
	picturesWork,
	PRESETS,
	savePicture,
	setAppearance,
	type Appearance,
} from "../appearance"
import type { ModelOption } from "../agent/turn"
import { desktopLink } from "../agent/desktop"
import { runTool } from "../agent/tools"
import * as microsoft from "../integrations/microsoft"
import {
	agentFor,
	effective,
	preferences,
	setPreferences,
} from "../preferences"
import { listJobs, nextRun, removeJob, type Job } from "../scheduler"
import type { AgentSessions } from "./agent-sessions"
import type { SlackAutomations } from "./automations"
import { userFirstName } from "./context"
import { noticeClicked, systemName } from "./system"
import * as slackSignIn from "./user-tokens"
import { keyView, readKeyForm, saveKey } from "./keys"

type WebClient = App["client"]
type Block = types.KnownBlock
type Person = { teamId: string; userId: string }

type Deps = {
	config: BotConfig
	agentSessions: AgentSessions
	automations?: SlackAutomations
	isAllowed: (userId: string) => boolean
}

let deps: Deps | null = null

/** A line shown once at the top, after something done here (e.g. "check your DMs"). */
const notices = new Map<string, string>()

const TABS = {
	overview: "Overview",
	skills: "Skills",
	memory: "Memory",
	settings: "Settings",
} as const
type Tab = keyof typeof TABS
const isTab = (value: string): value is Tab => value in TABS
/** The tab each person last opened; the page comes back to it. */
const tabs = new Map<string, Tab>()
const personKey = (person: Person) => `${person.teamId}-${person.userId}`

// ---- building blocks ----------------------------------------------------------------------

const plain = (text: string) => ({
	type: "plain_text" as const,
	text,
	emoji: true,
})
const md = (text: string) => ({ type: "mrkdwn" as const, text })
const escape = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
const header = (text: string): Block => ({ type: "header", text: plain(text) })
const context = (...texts: string[]): Block => ({
	type: "context",
	elements: texts.map(md),
})
const divider: Block = { type: "divider" }

function row(text: string, accessory?: unknown): Block {
	return {
		type: "section",
		text: md(text),
		...(accessory ? { accessory } : {}),
	} as Block
}

function button(
	text: string,
	actionId: string,
	value: string,
	extra: {
		style?: "primary" | "danger"
		confirm?: { title: string; text: string; yes: string }
		url?: string
	} = {},
) {
	return {
		type: "button" as const,
		action_id: actionId,
		text: plain(text),
		value,
		...(extra.style ? { style: extra.style } : {}),
		...(extra.url ? { url: extra.url } : {}),
		...(extra.confirm
			? {
					confirm: {
						title: plain(extra.confirm.title),
						text: md(extra.confirm.text),
						confirm: plain(extra.confirm.yes),
						deny: plain("Cancel"),
						...(extra.style === "danger"
							? { style: "danger" as const }
							: {}),
					},
				}
			: {}),
	}
}

function select(
	actionId: string,
	choices: { text: string; value: string }[],
	selected: string,
) {
	const options = choices.map(choice => ({
		text: plain(choice.text),
		value: choice.value,
	}))
	const initial = options.find(option => option.value === selected)
	return {
		type: "static_select" as const,
		action_id: actionId,
		options,
		...(initial ? { initial_option: initial } : {}),
	}
}

/** Slack shows it in the reader's own time zone and format. */
const slackTime = (date: Date) =>
	`<!date^${Math.floor(date.getTime() / 1000)}^{date_short_pretty} at {time}|${date.toISOString().slice(0, 16).replace("T", " ")} UTC>`

function ago(ms: number): string {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 1) return "just started"
	if (minutes < 60) return `${minutes} min`
	const hours = Math.floor(minutes / 60)
	return `${hours} h ${minutes % 60} min`
}

const EFFORTS: Record<string, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
}

// ---- sections -------------------------------------------------------------------------------
// Each section is a large header and compact rows: a short bold label on the left, its control
// on the right, and a grey hint underneath only where it helps. Dividers separate sections.

/** ChatGPT plans as people know them (Codex's planType). */
const PLANS: Record<string, string> = {
	free: "Free",
	go: "Go",
	plus: "Plus",
	pro: "Pro",
	team: "Business",
	business: "Business",
	enterprise: "Enterprise",
	edu: "Edu",
}

const ON = ":large_green_circle:"
const OFF = ":white_circle:"
const hint = (text: string) => context(text)

async function agentSection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const picked = await preferences(person)
	const agent = agentFor(config, picked)
	const models = await AGENTS[agent].listModels(config, person)
	const chosen = effective(config, agent, picked, models)
	const option: ModelOption | undefined = chosen.option
	const blocks: Block[] = [
		header(":brain:  Agent"),
		row(
			"*Agent*",
			select(
				"home_agent",
				Object.entries(AGENTS).map(([id, about]) => ({
					text: about.name,
					value: id,
				})),
				agent,
			),
		),
		// Slack trims a trailing line break; the zero-width space keeps an empty line under it.
		hint(
			`${AGENTS[agent].plan}${agent === "opencode" ? ". No sign-in; they may keep what they're sent" : ""}.\n\u200b`,
		),
	]
	if (!models.length)
		return [
			...blocks,
			row(`*Model*\n\`${escape(chosen.model)}\``),
			hint(":warning:  Couldn't load the model list right now."),
		]
	blocks.push(
		row(
			"*Model*",
			select(
				"home_model",
				models.map(model => ({ text: model.name, value: model.id })),
				chosen.model,
			),
		),
	)
	if (option?.description) blocks.push(hint(escape(option.description)))
	const efforts = option?.efforts ?? []
	if (efforts.length) {
		blocks.push(
			row(
				"*Reasoning*",
				select(
					"home_effort",
					efforts.map(effort => ({
						text: EFFORTS[effort.id] ?? effort.id,
						value: effort.id,
					})),
					chosen.effort,
				),
			),
		)
		const about = efforts.find(effort => effort.id === chosen.effort)
		if (about?.description) blocks.push(hint(escape(about.description)))
	}
	if (option?.fast)
		blocks.push(
			row(
				"*Speed*",
				select(
					"home_speed",
					[
						{ text: "Standard", value: "standard" },
						{ text: ":zap:  Fast", value: "fast" },
					],
					chosen.fast ? "fast" : "standard",
				),
			),
			hint(
				chosen.fast
					? "About twice as fast; uses more of the plan."
					: "Normal speed and plan usage.",
			),
		)
	blocks.push(
		Object.keys(picked).length
			? row(
					"_Your picks apply from your next message._",
					button("Reset", "home_defaults", "defaults"),
				)
			: hint("The bot's defaults. Changes apply from your next message."),
	)
	return blocks
}

async function appearanceSection(person: Person): Promise<Block[]> {
	const { name, picture } = await appearance(person)
	const icon = picture && pictureUrl(picture)
	const own = systemName()
	const text = `*${escape(name ?? own)}*\n${name || picture ? `On ${own}'s messages for you, for everyone in the conversation.` : `${own}'s own name and picture.`}`
	return [
		header(":art:  Name & picture"),
		icon
			? ({
					type: "section",
					text: md(text),
					accessory: {
						type: "image",
						image_url: icon,
						alt_text: name ?? own,
					},
				} as Block)
			: row(text),
		{
			type: "actions",
			elements: [
				button("Change", "home_look", "edit"),
				...(name || picture
					? [button("Reset", "home_look_reset", "reset")]
					: []),
			],
		},
		hint(
			`Or ask ${own}, e.g. _“call yourself Jalebi”_. You still tag it as @${own}.`,
		),
	]
}

async function placeLabel(client: WebClient, channel: string): Promise<string> {
	const info = await client.conversations.info({ channel }).catch(() => null)
	const found = info?.channel
	if (!found) return "A conversation"
	if (found.is_im) return `Your DM with ${systemName()}`
	if (found.is_mpim) return "A group DM"
	return `#${found.name}`
}

async function workingSection(
	client: WebClient,
	sessions: AgentSessions,
	person: Person,
): Promise<Block[]> {
	const running = sessions.running(person.userId)
	const rows = await Promise.all(
		running.map(async run => {
			const [place, link] = await Promise.all([
				placeLabel(client, run.channel),
				client.chat
					.getPermalink({
						channel: run.channel,
						message_ts: run.threadTs,
					})
					.then(found => found.permalink)
					.catch(() => undefined),
			])
			return row(
				`*${link ? `<${link}|${escape(place)}>` : escape(place)}*\n:hourglass_flowing_sand:  ${ago(Date.now() - run.startedAt)}`,
				button("Stop", "home_stop", `${run.channel}|${run.threadTs}`, {
					style: "danger",
					confirm: {
						title: "Stop this?",
						text: `${systemName()} stops working on it there, along with anything else you asked there that hasn't started.`,
						yes: "Stop",
					},
				}),
			)
		}),
	)
	return [
		header(":zap:  Working now"),
		...(rows.length ? rows : [hint("Nothing running.")]),
	]
}

async function connectionsSection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const connect = (value: string) =>
		button("Connect", "home_connect", value, { style: "primary" })
	const account = await codexAccount(config, person).catch(() => null)
	const rows: Block[] = [
		row(
			`*ChatGPT*\n${account ? `${ON}  Connected${account.email ? ` as ${escape(account.email)}` : ""}${PLANS[account.plan] ? `  ·  ${PLANS[account.plan]}` : ""}` : `${OFF}  Not connected`}`,
			account
				? button("Disconnect", "home_chatgpt", "signout", {
						confirm: {
							title: "Disconnect ChatGPT?",
							text: `${systemName()} won't run on Codex for you until you connect it again.`,
							yes: "Disconnect",
						},
					})
				: button("Connect", "home_chatgpt", "signin", {
						style: "primary",
					}),
		),
	]
	if (config.slackSignIn) {
		const connection = await slackSignIn.connection(person)
		rows.push(
			row(
				`*Slack*\n${connection ? `${ON}  Connected` : `${OFF}  Not connected`}`,
				connection
					? button("Disconnect", "home_disconnect", "slack", {
							confirm: {
								title: "Disconnect Slack?",
								text: `${systemName()} will only be able to message people as itself.`,
								yes: "Disconnect",
							},
						})
					: connect("slack"),
			),
		)
	}
	if (config.microsoft) {
		const account = await microsoft.account(person)
		const as = account ? ` as ${escape(account.name || account.email)}` : ""
		const disconnect = button(
			"Disconnect",
			"home_disconnect",
			"microsoft",
			{
				confirm: {
					title: "Disconnect Microsoft?",
					text: `This signs ${systemName()} out of Microsoft 365 *and* Azure DevOps; they share one sign-in.`,
					yes: "Disconnect",
				},
			},
		)
		// One sign-in for both; a service it doesn't cover yet gets its own approve button.
		const { ready, missing } = account
			? await microsoft.reach(config.microsoft, person)
			: { ready: [], missing: [] }
		const services = (ready.length ? ready : (["graph", "devops"] as const))
			.map(resource => microsoft.NAMES[resource])
			.join(" and ")
		rows.push(
			row(
				`*Microsoft*\n${ready.length ? `${ON}  Connected${as}` : `${OFF}  Not connected`}  ·  ${services}`,
				ready.length ? disconnect : connect("graph"),
			),
			...(ready.length
				? missing.map(({ resource }) =>
						row(
							`${OFF}  ${microsoft.NAMES[resource]} isn't approved for ${systemName()} yet`,
							button("Approve", "home_connect", resource),
						),
					)
				: []),
		)
	}
	return [
		header(":link:  Connections"),
		...rows,
		hint(
			`Connecting sends you a sign-in link in your DM with ${systemName()}. ChatGPT runs Codex on your own plan.`,
		),
	]
}

type Connections = {
	keys: { name: string; note: string; added: string }[]
	mcp: {
		name: string
		target: string
		keys: string[]
		note: string
		added: string
	}[]
	accounts: { name: string; detail: string }[]
}
const MAX_LISTED = 15

/** Everything else laddu can use for them: keys, MCP servers, accounts on its computer. */
async function toolsSection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const found = JSON.parse(
		await runTool(config, person, ["connections", "json"]),
	) as Connections
	const added = (when: string) =>
		when && !Number.isNaN(Date.parse(when))
			? `  ·  added ${slackTime(new Date(when))}`
			: ""
	const remove = (kind: "key" | "mcp", name: string, text: string) =>
		button("Remove", "home_connection_remove", `${kind}|${name}`, {
			confirm: {
				title: `Remove ${clip(name, 15)}?`,
				text,
				yes: "Remove",
			},
		})
	const saved = new Set(found.keys.map(key => key.name))
	const rows: Block[] = [
		...found.keys
			.slice(0, MAX_LISTED)
			.map(key =>
				row(
					`*\`${key.name}\`*  ·  key\n${key.note ? escape(key.note) : "_No note_"}${added(key.added)}`,
					remove(
						"key",
						key.name,
						`${systemName()} won't be able to use \`${key.name}\` any more.`,
					),
				),
			),
		...found.mcp.slice(0, MAX_LISTED).map(server => {
			const missing = server.keys.filter(key => !saved.has(key))
			return row(
				`*${escape(server.name)}*  ·  MCP server\n${escape(clip(server.target, 120))}${server.note ? ` · ${escape(server.note)}` : ""}${added(server.added)}${missing.length ? `\n:warning:  Needs ${missing.map(key => `\`${key}\``).join(", ")}` : ""}`,
				remove(
					"mcp",
					server.name,
					`${systemName()} won't have the *${escape(server.name)}* tools any more.`,
				),
			)
		}),
	]
	const profile = config.codeCommit?.profiles[person.userId]
	const accounts = [
		...(profile
			? [
					`*AWS CodeCommit*: profile \`${escape(profile)}\`, set up by whoever runs ${systemName()}`,
				]
			: []),
		...found.accounts.map(
			account => `*${escape(account.name)}*: ${escape(account.detail)}`,
		),
	]
	if (accounts.length)
		rows.push(
			row(
				`*Signed in on ${systemName()}'s computer*\n${clip(accounts.join("\n"), 2800)}`,
			),
		)
	const more =
		Math.max(0, found.keys.length - MAX_LISTED) +
		Math.max(0, found.mcp.length - MAX_LISTED)
	return [
		header(":key:  Keys & tools"),
		...(rows.length
			? rows
			: [hint("Nothing yet: no keys, MCP servers or other accounts.")]),
		...(more
			? [hint(`…and ${more} more. Ask ${systemName()} to list them.`)]
			: []),
		{
			type: "actions",
			elements: [
				button("Add a key", "home_key_add", "add", {
					style: "primary",
				}),
			],
		},
		hint(
			`Keys go in a private form, never in the chat. Or ask ${systemName()} to connect something, e.g. _“connect the Linear MCP server”_ or _“sign in to the AWS CLI”_.`,
		),
	]
}

function jobWhen(job: Job): string {
	const next = nextRun(job)
	if (job.at) return next ? `Once  ·  ${slackTime(next)}` : "Once  ·  done"
	return next
		? `Repeats  ·  next ${slackTime(next)}`
		: "Repeats  ·  nothing in the next 5 weeks"
}

async function scheduledSection(person: Person): Promise<Block[]> {
	const jobs = await listJobs(person.teamId, person.userId)
	return [
		header(":alarm_clock:  Scheduled"),
		...(jobs.length
			? jobs.map(job =>
					row(
						`*${escape(job.name)}*\n${jobWhen(job)}`,
						button("Remove", "home_job_remove", job.id, {
							confirm: {
								title: "Remove this task?",
								text: `*${escape(job.name)}* won't run again.`,
								yes: "Remove",
							},
						}),
					),
				)
			: [
					hint(
						`Nothing scheduled. Ask ${systemName()}, e.g. _“every Monday at 9, summarise #sales”_.`,
					),
				]),
	]
}

type Rule = {
	id: string
	name: string
	event: string
	channel: string
	contains?: string
	reaction?: string
	domain?: string
	action: "message" | "task" | "reaction"
	enabled: boolean
}

const EVENTS: Record<string, string> = {
	member_joined_channel: "someone joins",
	member_left_channel: "someone leaves",
	team_join: "someone joins the workspace",
	message: "a message is posted",
	reaction_added: "someone reacts",
	reaction_removed: "someone removes a reaction",
	file_shared: "a file is shared",
	channel_created: "a channel is created",
	channel_rename: "a channel is renamed",
	channel_archive: "a channel is archived",
	link_shared: "a link is shared",
}
const ACTIONS: Record<Rule["action"], () => string> = {
	message: () => `${systemName()} posts a message`,
	reaction: () => `${systemName()} reacts`,
	task: () => `${systemName()} works on it`,
}

function describeRule(rule: Rule): string {
	const where = ["team_join", "channel_created"].includes(rule.event)
		? ""
		: ` in <#${rule.channel}>`
	const filter = rule.contains
		? ` containing “${escape(rule.contains)}”`
		: rule.reaction
			? ` with :${rule.reaction}:`
			: rule.domain
				? ` from ${escape(rule.domain)}`
				: ""
	return `When ${EVENTS[rule.event] ?? rule.event}${where}${filter}, ${ACTIONS[rule.action]()}`
}

async function automationsSection(
	automations: SlackAutomations | undefined,
	person: Person,
): Promise<Block[]> {
	if (!automations) return []
	const rules = (await automations.manage(person, {
		operation: "list",
	})) as unknown as Rule[]
	return [
		header(":repeat:  Automations"),
		...(rules.length
			? rules.map(rule =>
					row(
						`*${escape(rule.name)}*\n${rule.enabled ? "" : ":double_vertical_bar:  _Paused_  ·  "}${describeRule(rule)}`,
						{
							type: "overflow",
							action_id: "home_rule",
							options: [
								{
									text: plain(
										rule.enabled ? "Pause" : "Resume",
									),
									value: `${rule.enabled ? "disable" : "enable"}|${rule.id}`,
								},
								{
									text: plain("Remove"),
									value: `remove|${rule.id}`,
								},
							],
						},
					),
				)
			: [
					hint(
						`No automations. Ask ${systemName()}, e.g. _“when someone joins #general, welcome them”_.`,
					),
				]),
	]
}

type Memory = { user: string[]; notes: string[] }

async function readMemory(config: BotConfig, person: Person): Promise<Memory> {
	return JSON.parse(
		await runTool(config, person, ["memory", "json"]),
	) as Memory
}

async function memorySection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const memory = await readMemory(config, person)
	const store = (
		key: keyof Memory,
		title: string,
		about: string,
		empty: string,
	): Block[] => [
		header(title),
		hint(about),
		...(memory[key].length
			? memory[key].map((entry, index) =>
					row(escape(entry), {
						type: "overflow",
						action_id: "home_memory_entry",
						options: [
							{
								text: plain("Edit"),
								value: `edit|${key}|${index + 1}`,
							},
							{
								text: plain("Forget"),
								value: `forget|${key}|${index + 1}`,
							},
						],
					}),
				)
			: [hint(empty)]),
		{
			type: "actions",
			elements: [
				button(":heavy_plus_sign:  Add", "home_memory_add", key),
			],
		},
	]
	return [
		...store(
			"user",
			":bust_in_silhouette:  About you",
			"Who you are and how you like answers.",
			`Nothing yet. ${systemName()} saves things as you work together.`,
		),
		divider,
		...store(
			"notes",
			`:notebook:  ${systemName()}'s notes`,
			"Your setup, standing conventions and lessons learned.",
			"No notes yet.",
		),
		...(memory.user.length || memory.notes.length
			? [
					divider,
					row(
						`*Start over*\n${systemName()} forgets everything above and learns about you again.`,
						button(
							"Forget everything",
							"home_memory_clear",
							"clear",
							{
								style: "danger",
								confirm: {
									title: "Forget everything?",
									text: `${systemName()} starts over and learns about you again from scratch.`,
									yes: "Forget everything",
								},
							},
						),
					),
				]
			: []),
		hint("Changes apply to new conversations."),
	]
}

type Skill = { name: string; description: string; linked: boolean }

const readSkills = async (config: BotConfig, person: Person) =>
	JSON.parse(await runTool(config, person, ["skills", "json"])) as Skill[]

/** Most rows a Home page can hold next to everything else (Slack allows 100 blocks). */
const MAX_SKILLS = 70

async function skillsSection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const skills = await readSkills(config, person)
	return [
		header(":hammer_and_wrench:  Skills"),
		hint(
			`How-to guides ${systemName()} writes as it learns your work, and follows when a task matches. Changes apply from your next message.`,
		),
		{
			type: "actions",
			elements: [
				button(
					":heavy_plus_sign:  New skill",
					"home_skill_new",
					"new",
					{
						style: "primary",
					},
				),
			],
		},
		...(skills.length
			? skills.slice(0, MAX_SKILLS).map(skill =>
					row(
						`*${escape(skill.name)}*${skill.linked ? "  ·  _installed_" : ""}\n${escape(clip(skill.description || "No description.", 180))}`,
						{
							type: "overflow",
							action_id: "home_skill",
							options: [
								{
									text: plain("View"),
									value: `view|${skill.name}`,
								},
								...(skill.linked
									? []
									: [
											{
												text: plain("Edit"),
												value: `edit|${skill.name}`,
											},
										]),
								{
									text: plain("Remove"),
									value: `remove|${skill.name}`,
								},
							],
						},
					),
				)
			: [
					hint(
						`No skills yet. ${systemName()} writes one when it works out something likely to come up again, or ask it, e.g. _“remember how to pull the weekly sales report”_.`,
					),
				]),
		...(skills.length > MAX_SKILLS
			? [
					hint(
						`…and ${skills.length - MAX_SKILLS} more. Ask ${systemName()} to list or tidy them.`,
					),
				]
			: []),
	]
}

// ---- the page -------------------------------------------------------------------------------

/** Each tab's sections as last built for a person, so switching to it shows them at once. */
const built = new Map<string, Block[][]>()
/** Counts each person's redraws, so a slow one doesn't cover a newer one. */
const redraws = new Map<string, number>()
const firstNames = new Map<string, string>()
/** People whose page showTab() just drew from built, so refreshHome() can skip an identical redraw. */
const shown = new Set<string>()

/** The sections of one tab. A section that fails shows a short note instead of breaking the page. */
function buildTab(
	client: WebClient,
	person: Person,
	tab: Tab,
): Promise<Block[][]> {
	const { config, agentSessions, automations } = deps!
	const safe = async (name: string, build: () => Promise<Block[]>) =>
		build().catch(error => {
			console.warn(`[home] ${name} failed`, error)
			return [
				header(name),
				hint(":warning:  Couldn't load this right now."),
			]
		})
	const builds: Record<Tab, [string, () => Promise<Block[]>][]> = {
		overview: [
			[
				"Working now",
				() => workingSection(client, agentSessions, person),
			],
			["Scheduled", () => scheduledSection(person)],
			["Automations", () => automationsSection(automations, person)],
		],
		skills: [["Skills", () => skillsSection(config, person)]],
		memory: [["Memory", () => memorySection(config, person)]],
		settings: [
			["Agent", () => agentSection(config, person)],
			["Name & picture", () => appearanceSection(person)],
			["Connections", () => connectionsSection(config, person)],
			["Keys & tools", () => toolsSection(config, person)],
		],
	}
	return Promise.all(builds[tab].map(([name, build]) => safe(name, build)))
}

async function publish(
	client: WebClient,
	person: Person,
	tab: Tab,
	sections: Block[][],
	notice?: string,
): Promise<void> {
	const { config } = deps!
	const key = personKey(person)
	if (!firstNames.has(key))
		firstNames.set(
			key,
			await userFirstName(client, person.userId).catch(() => ""),
		)
	// Slack fetches images itself, so only with a public address (assets/home-banner.png; bump ?v
	// when it changes, Slack caches it). It reads "laddu", so only when that's the bot's name.
	const banner =
		config.desktopViewer.publicUrl.startsWith("https:") &&
		systemName() === "laddu"
			? `${config.desktopViewer.publicUrl}/_laddu/home-banner.png?v=3`
			: null
	const blocks: Block[] = [
		banner
			? { type: "image", image_url: banner, alt_text: systemName() }
			: header(systemName()),
		row(
			`*Hi ${escape(firstNames.get(key) || "there")}* :wave:\nOnly you can see this page.`,
		),
		{
			type: "actions",
			elements: [
				button(
					":arrows_counterclockwise:  Refresh",
					"home_refresh",
					"refresh",
				),
				...(config.desktop
					? [
							button(
								":desktop_computer:  Open computer",
								"open_computer",
								"open",
								{
									style: "primary",
									url: await desktopLink(config, person),
								},
							),
						]
					: []),
			],
		},
		divider,
		{
			type: "actions",
			elements: Object.entries(TABS).map(([id, label]) =>
				button(
					label,
					`home_tab_${id}`,
					id,
					id === tab ? { style: "primary" } : {},
				),
			),
		},
		...(notice ? [row(notice)] : []),
	]
	sections
		.filter(section => section.length)
		.forEach((section, index) =>
			blocks.push(...(index || notice ? [divider] : []), ...section),
		)
	await client.views.publish({
		user_id: person.userId,
		view: { type: "home", blocks: blocks.slice(0, 100) },
	})
}

/** Shows their current tab at once: as last built, or loading. refreshHome() then brings it up to date. */
async function showTab(client: WebClient, person: Person): Promise<void> {
	const key = personKey(person)
	// Whatever redraw is still building is for the tab they just left.
	redraws.set(key, (redraws.get(key) ?? 0) + 1)
	const tab = tabs.get(key) ?? "overview"
	if (built.has(`${key}|${tab}`)) shown.add(key)
	await publish(
		client,
		person,
		tab,
		built.get(`${key}|${tab}`) ?? [
			[hint(":hourglass_flowing_sand:  Loading…")],
		],
	)
}

/** Redraws their Home tab, and builds tabs they haven't seen yet in the background so switching is instant. */
export async function refreshHome(
	client: WebClient,
	person: Person,
): Promise<void> {
	if (!deps) return
	const key = personKey(person)
	const redraw = (redraws.get(key) ?? 0) + 1
	redraws.set(key, redraw)
	const tab = tabs.get(key) ?? "overview"
	const before = built.get(`${key}|${tab}`)
	const sections = await buildTab(client, person, tab)
	built.set(`${key}|${tab}`, sections)
	if (redraws.get(key) !== redraw) return
	const notice = notices.get(key)
	notices.delete(key)
	// After a tab switch the page already shows these; publishing them again only makes Slack redraw.
	if (
		notice ||
		!shown.has(key) ||
		JSON.stringify(before) !== JSON.stringify(sections)
	)
		await publish(client, person, tab, sections, notice)
	shown.delete(key)
	for (const other of Object.keys(TABS) as Tab[])
		if (!built.has(`${key}|${other}`))
			buildTab(client, person, other)
				.then(sections => built.set(`${key}|${other}`, sections))
				.catch(() => {})
}

// ---- memory and skill popups ---------------------------------------------------------------

const waitView = (title: string): types.ModalView => ({
	type: "modal",
	title: plain(title),
	close: plain("Close"),
	blocks: [row(":hourglass_flowing_sand:  Loading…")],
})

const problemView = (title: string, problem: string): types.ModalView => ({
	type: "modal",
	title: plain(title),
	close: plain("Close"),
	blocks: [row(`:warning:  ${escape(problem)}`)],
})

/** What a laddu command printed to say why it refused, else a generic line. */
function toolProblem(error: unknown): string {
	const stderr = String((error as { stderr?: unknown }).stderr ?? "")
	const said = stderr.trim().replace(/^error:\s*/, "")
	return said
		? clip(said.split("\n")[0]!, 300)
		: "That didn't work. Please try again."
}

const memoryStore = (store: keyof Memory) =>
	store === "user" ? "About you" : `${systemName()}'s notes`

function memoryEntryView(
	store: keyof Memory,
	number: number | null,
	entry: string,
): types.ModalView {
	return {
		type: "modal",
		callback_id: "home_memory_save",
		private_metadata: `${store}|${number ?? ""}`,
		title: plain(number ? "Edit memory" : "Add to memory"),
		submit: plain("Save"),
		close: plain("Cancel"),
		blocks: [
			{
				type: "input",
				block_id: "entry",
				label: plain(memoryStore(store)),
				hint: plain(
					store === "user"
						? "One fact about you, e.g. your role or how you like answers."
						: `One note for ${systemName()}, e.g. a convention or where something lives.`,
				),
				element: {
					type: "plain_text_input",
					action_id: "value",
					multiline: true,
					max_length: 1000,
					...(entry ? { initial_value: entry } : {}),
				},
			},
		],
	}
}

/** SKILL.md split into its --- block (lines) and the steps under it. */
function splitSkill(text: string): { front: string[]; body: string } {
	const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/)
	return match
		? { front: match[1]!.split("\n"), body: text.slice(match[0].length) }
		: { front: [], body: text }
}

/** SKILL.md with a new description and steps, keeping any other settings in its --- block. */
function skillText(
	name: string,
	description: string,
	body: string,
	front: string[] = [],
): string {
	const kept: string[] = []
	let skipping = false
	for (const line of front) {
		if (/^description:/.test(line)) skipping = true
		else if (!skipping || !/^\s/.test(line)) {
			skipping = false
			kept.push(line)
		}
	}
	if (!kept.some(line => /^name:/.test(line))) kept.unshift(`name: ${name}`)
	kept.push(
		`description: ${JSON.stringify(description.replace(/\s+/g, " ").trim())}`,
	)
	return `---\n${kept.join("\n")}\n---\n\n${body.trim()}\n`
}

/** Slack's longest text input. */
const MAX_STEPS = 3000

function skillEditView(
	skill: { name: string; description: string; body: string } | null,
): types.ModalView {
	return {
		type: "modal",
		callback_id: "home_skill_save",
		private_metadata: skill?.name ?? "",
		title: plain(skill ? "Edit skill" : "New skill"),
		submit: plain("Save"),
		close: plain("Cancel"),
		blocks: [
			skill
				? header(skill.name)
				: {
						type: "input",
						block_id: "name",
						label: plain("Name"),
						hint: plain("Lowercase words with hyphens."),
						element: {
							type: "plain_text_input",
							action_id: "value",
							max_length: 64,
							placeholder: plain("weekly-sales-report"),
						},
					},
			{
				type: "input",
				block_id: "description",
				label: plain("When to use it"),
				hint: plain(
					`${systemName()} sees only this until a task matches, so say what it does and when.`,
				),
				element: {
					type: "plain_text_input",
					action_id: "value",
					multiline: true,
					max_length: 1000,
					placeholder: plain(
						"Pulls last week's numbers from the sales sheet and posts a summary. Use when asked for the weekly sales report.",
					),
					...(skill?.description
						? { initial_value: skill.description }
						: {}),
				},
			},
			{
				type: "input",
				block_id: "body",
				label: plain("Steps"),
				hint: plain(
					"Short and concrete: the commands, links and gotchas.",
				),
				element: {
					type: "plain_text_input",
					action_id: "value",
					multiline: true,
					max_length: MAX_STEPS,
					...(skill?.body.trim()
						? { initial_value: skill.body.trim() }
						: {}),
				},
			},
		],
	}
}

function skillReadView(name: string, text: string): types.ModalView {
	const chunks = text.match(/[\s\S]{1,2900}/g) ?? [""]
	return {
		type: "modal",
		title: plain("Skill"),
		close: plain("Close"),
		blocks: [
			header(clip(name, 150)),
			...chunks
				.slice(0, 95)
				.map(chunk => row(`\`\`\`${escape(chunk)}\`\`\``)),
		],
	}
}

// ---- name & picture popup -------------------------------------------------------------------

const KEEP = "keep"
const OWN = "own"

function appearanceView(current: Appearance): types.ModalView {
	const uploaded = current.picture && !(current.picture in PRESETS)
	const choices = [
		{ text: `${systemName()}'s own`, value: OWN },
		...Object.entries(PRESETS).map(([value, text]) => ({ text, value })),
		...(uploaded ? [{ text: "The one you uploaded", value: KEEP }] : []),
	]
	const picked = uploaded ? KEEP : (current.picture ?? OWN)
	return {
		type: "modal",
		callback_id: "home_look",
		title: plain("Name & picture"),
		submit: plain("Save"),
		close: plain("Cancel"),
		blocks: [
			{
				type: "input",
				block_id: "name",
				optional: true,
				label: plain("Name"),
				hint: plain(
					`What ${systemName()} is called on its messages for you. Empty for ${systemName()}.`,
				),
				element: {
					type: "plain_text_input",
					action_id: "value",
					max_length: MAX_NAME,
					placeholder: plain(systemName()),
					...(current.name ? { initial_value: current.name } : {}),
				},
			},
			...(picturesWork()
				? ([
						{
							type: "input",
							block_id: "picture",
							label: plain("Picture"),
							element: {
								...select("value", choices, picked),
							},
						},
						{
							type: "input",
							block_id: "upload",
							optional: true,
							label: plain("Or upload your own"),
							hint: plain(
								"PNG, JPEG or GIF up to 5 MB; square looks best.",
							),
							element: {
								type: "file_input",
								action_id: "value",
								filetypes: ["png", "jpg", "jpeg", "gif"],
								max_files: 1,
							},
						},
					] as Block[])
				: [
						context(
							`Pictures need a public HTTPS address for ${systemName()} (DESKTOP_PUBLIC_URL); this one has none.`,
						),
					]),
		],
	}
}

/** The picture they uploaded in the popup, saved; its name, or why it can't be used. */
async function uploadedPicture(file: {
	url_private_download?: string
	url_private?: string
	size?: number
}): Promise<{ picture: string } | { problem: string }> {
	if ((file.size ?? 0) > MAX_PICTURE_BYTES)
		return { problem: "That picture is over 5 MB." }
	const response = await fetch(
		file.url_private_download ?? file.url_private!,
		{
			headers: { authorization: `Bearer ${deps!.config.slackBotToken}` },
		},
	)
	if (!response.ok)
		return { problem: "Couldn't fetch that picture from Slack." }
	return savePicture(await response.bytes())
}

// ---- actions --------------------------------------------------------------------------------

export function registerHome(app: App, given: Deps) {
	deps = given
	const { config, agentSessions, automations, isAllowed } = given

	app.event("app_home_opened", async ({ event, client, context: ctx }) => {
		if (event.tab !== "home" || !isAllowed(event.user)) return
		await refreshHome(client, {
			teamId: ctx.teamId!,
			userId: event.user,
		}).catch(error => console.warn("[home] couldn't publish", error))
	})

	/** Runs a Home tab control for the clicker, then redraws their page. */
	const control = (
		actionId: string | RegExp,
		run: (args: {
			person: Person
			client: WebClient
			value: string
			body: { trigger_id: string; view?: { id: string; type: string } }
		}) => Promise<string | void>,
	) =>
		app.action(actionId, async ({ ack, body, action, client }) => {
			await ack()
			if (body.type !== "block_actions" || !isAllowed(body.user.id))
				return
			const person = {
				teamId: body.team?.id ?? body.user.team_id!,
				userId: body.user.id,
			}
			const value: string =
				("selected_option" in action && action.selected_option
					? action.selected_option.value
					: "value" in action
						? action.value
						: undefined) ?? ""
			try {
				const notice = await run({
					person,
					client,
					value,
					body: body as {
						trigger_id: string
						view?: { id: string; type: string }
					},
				})
				if (notice) notices.set(personKey(person), notice)
			} catch (error) {
				console.warn(`[home] ${String(actionId)} failed`, error)
				notices.set(
					personKey(person),
					":warning:  That didn't work. Please try again.",
				)
			}
			if (body.view?.type === "home")
				await refreshHome(client, person).catch(error =>
					console.warn("[home] couldn't publish", error),
				)
		})

	// The Computer button is a link; Slack still sends the click.
	app.action("open_computer", async ({ ack }) => ack())
	// Link buttons on system messages (sign-ins); the click lets the message be replaced later.
	app.action("system_link", async ({ ack, body, action }) => {
		await ack()
		noticeClicked(
			"value" in action ? action.value : undefined,
			"response_url" in body ? body.response_url : undefined,
		)
	})
	control("home_refresh", async () => {})

	control("home_agent", async ({ person, value }) => {
		if (!isAgent(value)) return
		// Each agent has its own models; the picks for the old one don't carry over.
		await setPreferences(person, {
			agent: value,
			model: undefined,
			effort: undefined,
			fast: undefined,
		})
	})
	control("home_model", async ({ person, value }) =>
		setPreferences(person, { model: value }),
	)
	control("home_effort", async ({ person, value }) =>
		setPreferences(person, { effort: value }),
	)
	control("home_speed", async ({ person, value }) =>
		setPreferences(person, { fast: value === "fast" }),
	)
	control("home_defaults", async ({ person }) =>
		setPreferences(person, {
			agent: undefined,
			model: undefined,
			effort: undefined,
			fast: undefined,
		}),
	)

	control("home_look", async ({ person, client, body }) => {
		await client.views.open({
			trigger_id: body.trigger_id,
			view: appearanceView(await appearance(person)),
		})
	})
	control("home_look_reset", async ({ person }) =>
		setAppearance(person, { name: undefined, picture: undefined }),
	)
	app.view("home_look", async ({ ack, body, view, client }) => {
		const person = {
			teamId: body.team?.id ?? body.user.team_id!,
			userId: body.user.id,
		}
		if (!isAllowed(person.userId)) return ack()
		const values = view.state.values
		const name = cleanName(values.name?.value?.value ?? "")
		const problem = name && (await nameProblem(client, name))
		if (problem)
			return ack({ response_action: "errors", errors: { name: problem } })
		await ack()
		const choice = values.picture?.value?.selected_option?.value
		const file = values.upload?.value?.files?.[0]
		const change: Appearance = { name: name || undefined }
		let notice: string | undefined
		if (file) {
			const saved = await uploadedPicture(file).catch(error => {
				console.warn("[home] couldn't save the picture", error)
				return { problem: "Couldn't save that picture." }
			})
			if ("picture" in saved) change.picture = saved.picture
			else notice = `:warning:  ${saved.problem} The name is saved.`
		} else if (choice && choice !== KEEP)
			change.picture = choice === OWN ? undefined : choice
		await setAppearance(person, change)
		if (notice) notices.set(personKey(person), notice)
		await refreshHome(client, person).catch(error =>
			console.warn("[home] couldn't publish", error),
		)
	})

	control("home_connect", async ({ person, client, value }) => {
		if (value === "slack" && config.slackSignIn)
			await slackSignIn.connect(config.slackSignIn, client, person, null)
		else if ((value === "graph" || value === "devops") && config.microsoft)
			await microsoft.connect(
				config.microsoft,
				client,
				person,
				value,
				null,
			)
		else return
		return `:envelope_with_arrow:  Sign-in link sent to your DM with ${systemName()}. Press Refresh here once you're done.`
	})
	control("home_chatgpt", async ({ person, client, value }) => {
		if (value === "signout") return signOut(config, person)
		await signIn(config, client, person, null, () =>
			refreshHome(client, person).catch(error =>
				console.warn("[home] couldn't publish", error),
			),
		)
		return `:envelope_with_arrow:  Sign-in code sent to your DM with ${systemName()}. This page updates once you're connected.`
	})
	control("home_disconnect", async ({ person, client, value }) => {
		if (value === "slack") await slackSignIn.disconnect(client, person)
		if (value === "microsoft") await microsoft.disconnect(person)
	})

	control("home_stop", async ({ person, value }) => {
		const [channel, threadTs] = value.split("|") as [string, string]
		agentSessions.stop(channel, threadTs, person.userId)
	})
	control("home_job_remove", async ({ person, value }) => {
		await removeJob(person.teamId, person.userId, value)
	})
	control("home_rule", async ({ person, value }) => {
		const [operation, id] = value.split("|") as [string, string]
		await automations?.manage(person, { operation, id })
	})

	control(/^home_tab_/, async ({ person, client, value }) => {
		if (!isTab(value)) return
		tabs.set(personKey(person), value)
		await showTab(client, person)
	})

	/** Opens a popup at once (the trigger expires in 3 s), then fills it in. */
	const popup = async (
		client: WebClient,
		triggerId: string,
		title: string,
		fill: () => Promise<types.ModalView>,
	) => {
		const opened = await client.views.open({
			trigger_id: triggerId,
			view: waitView(title),
		})
		const view = await fill().catch(error => {
			console.warn(`[home] ${title} failed`, error)
			return problemView(title, toolProblem(error))
		})
		await client.views.update({ view_id: opened.view!.id!, view })
	}
	const viewPerson = (body: {
		team: { id: string } | null
		user: { id: string; team_id?: string }
	}): Person => ({
		teamId: body.team?.id ?? body.user.team_id!,
		userId: body.user.id,
	})
	/** A popup's Save: runs the change after closing it, then redraws their page. */
	const saved = async (
		client: WebClient,
		person: Person,
		run: () => Promise<string | void>,
	) => {
		try {
			const notice = await run()
			if (notice) notices.set(personKey(person), notice)
		} catch (error) {
			console.warn("[home] save failed", error)
			notices.set(personKey(person), `:warning:  ${toolProblem(error)}`)
		}
		await refreshHome(client, person).catch(error =>
			console.warn("[home] couldn't publish", error),
		)
	}

	control("home_connection_remove", async ({ person, value }) => {
		const [kind, name] = value.split("|") as [string, string]
		if (kind !== "key" && kind !== "mcp") return
		await runTool(config, person, ["connections", kind, "remove", name])
	})
	control("home_key_add", async ({ client, body }) => {
		await client.views.open({
			trigger_id: body.trigger_id,
			view: keyView("home_key_save", ""),
		})
	})
	app.view("home_key_save", async ({ ack, body, view, client }) => {
		const person = viewPerson(body)
		if (!isAllowed(person.userId)) return ack()
		const form = readKeyForm(view)
		if ("problem" in form)
			return ack({
				response_action: "errors",
				errors: { [form.field]: form.problem },
			})
		await ack()
		await saved(client, person, async () => {
			await saveKey(config, person, form.name, form.note, form.value)
			return `:lock:  Saved \`${form.name}\`. ${systemName()} can use it from your next message.`
		})
	})

	control("home_memory_add", async ({ client, value, body }) => {
		if (value !== "user" && value !== "notes") return
		await client.views.open({
			trigger_id: body.trigger_id,
			view: memoryEntryView(value, null, ""),
		})
	})
	control("home_memory_entry", async ({ person, client, value, body }) => {
		const [operation, store, number] = value.split("|") as [
			string,
			keyof Memory,
			string,
		]
		if (operation === "forget")
			return void (await runTool(config, person, [
				"memory",
				"forget",
				store,
				number,
			]))
		await popup(client, body.trigger_id, "Edit memory", async () => {
			const entry = (await readMemory(config, person))[store][
				Number(number) - 1
			]
			if (entry === undefined) throw new Error("That entry is gone.")
			return memoryEntryView(store, Number(number), entry)
		})
	})
	control("home_memory_clear", async ({ person }) => {
		await runTool(config, person, ["memory", "clear"])
	})
	app.view("home_memory_save", async ({ ack, body, view, client }) => {
		const person = viewPerson(body)
		if (!isAllowed(person.userId)) return ack()
		await ack()
		const [store, number] = view.private_metadata.split("|") as [
			string,
			string,
		]
		const entry = view.state.values.entry?.value?.value ?? ""
		await saved(client, person, async () => {
			await runTool(
				config,
				person,
				number
					? ["memory", "set", store, number, entry]
					: ["memory", "add", store, entry],
			)
		})
	})

	control("home_skill_new", async ({ client, body }) => {
		await client.views.open({
			trigger_id: body.trigger_id,
			view: skillEditView(null),
		})
	})
	control("home_skill", async ({ person, client, value, body }) => {
		const [operation, name] = value.split("|") as [string, string]
		if (operation === "remove") {
			await runTool(config, person, ["skills", "remove", name])
			return `:wastebasket:  Removed the *${escape(name)}* skill.`
		}
		const read = () => runTool(config, person, ["skills", "show", name])
		if (operation === "view")
			return popup(client, body.trigger_id, "Skill", async () =>
				skillReadView(name, await read()),
			)
		await popup(client, body.trigger_id, "Edit skill", async () => {
			const [text, skills] = await Promise.all([
				read(),
				readSkills(config, person),
			])
			const { body: steps } = splitSkill(text)
			if (steps.trim().length > MAX_STEPS)
				throw new Error(
					`This skill is too long to edit here. Ask ${systemName()} to change it.`,
				)
			return skillEditView({
				name,
				description:
					skills.find(skill => skill.name === name)?.description ??
					"",
				body: steps,
			})
		})
	})
	app.view("home_skill_save", async ({ ack, body, view, client }) => {
		const person = viewPerson(body)
		if (!isAllowed(person.userId)) return ack()
		const values = view.state.values
		const editing = view.private_metadata
		const name =
			editing ||
			(values.name?.value?.value ?? "")
				.trim()
				.toLowerCase()
				.replace(/[\s_]+/g, "-")
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
			return ack({
				response_action: "errors",
				errors: { name: "Lowercase letters, digits and hyphens only." },
			})
		await ack()
		await saved(client, person, async () => {
			const exists = (await readSkills(config, person)).some(
				skill => skill.name === name,
			)
			if (!editing && exists)
				return `:warning:  You already have a skill called *${escape(name)}*. Edit that one instead.`
			const front = editing
				? splitSkill(
						await runTool(config, person, ["skills", "show", name]),
					).front
				: []
			await runTool(
				config,
				person,
				["skills", "save", name],
				skillText(
					name,
					values.description?.value?.value ?? "",
					values.body?.value?.value ?? "",
					front,
				),
			)
			return `:white_check_mark:  Saved the *${escape(name)}* skill. ${systemName()} uses it from your next message.`
		})
	})
}
