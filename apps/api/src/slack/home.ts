/**
 * dot's Home tab: each person's own settings page. Their agent and model, a link to their
 * computer, the accounts they've connected, what dot is working on for them, their scheduled tasks and
 * automations, and what dot remembers. Redrawn whenever they open it and after every change made
 * here; only they can see it, and every control acts only on their own things.
 */
import type { App, types } from "@slack/bolt"
import type { BotConfig } from "../config"
import { listModels, type ModelOption } from "../agent/codex"
import { desktopLink } from "../agent/desktop"
import { runTool } from "../agent/tools"
import * as microsoft from "../integrations/microsoft"
import { effective, preferences, setPreferences } from "../preferences"
import { listJobs, nextRun, removeJob, type Job } from "../scheduler"
import type { AgentSessions } from "./agent-sessions"
import type { SlackAutomations } from "./automations"
import { userFirstName } from "./context"
import * as slackSignIn from "./user-tokens"

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

const ON = ":large_green_circle:"
const OFF = ":white_circle:"
const hint = (text: string) => context(text)

async function agentSection(
	config: BotConfig,
	person: Person,
): Promise<Block[]> {
	const [picked, models] = await Promise.all([
		preferences(person),
		listModels(),
	])
	const chosen = effective(config, picked, models)
	const option: ModelOption | undefined = chosen.option
	const blocks: Block[] = [
		header(":brain:  Agent"),
		{
			type: "section",
			// Slack trims a trailing line break; the zero-width space keeps an empty line under them.
			fields: [
				md("*Agent*\nCodex\n\u200b"),
				md("*Plan*\nChatGPT subscription\n\u200b"),
			],
		},
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

async function placeLabel(client: WebClient, channel: string): Promise<string> {
	const info = await client.conversations.info({ channel }).catch(() => null)
	const found = info?.channel
	if (!found) return "A conversation"
	if (found.is_im) return "Your DM with dot"
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
						text: "dot stops working on it there, along with anything else you asked there that hasn't started.",
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
	const rows: Block[] = []
	const connect = (value: string) =>
		button("Connect", "home_connect", value, { style: "primary" })
	if (config.slackSignIn) {
		const connection = await slackSignIn.connection(person)
		rows.push(
			row(
				`*Slack*\n${connection ? `${ON}  Connected` : `${OFF}  Not connected`}`,
				connection
					? button("Disconnect", "home_disconnect", "slack", {
							confirm: {
								title: "Disconnect Slack?",
								text: "dot will only be able to message people as itself.",
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
					text: "This signs dot out of Microsoft 365 *and* Azure DevOps; they share one sign-in.",
					yes: "Disconnect",
				},
			},
		)
		rows.push(
			row(
				`*Microsoft 365*\n${account?.tokens.graph ? `${ON}  Connected${as}` : `${OFF}  Not connected`}`,
				account?.tokens.graph ? disconnect : connect("graph"),
			),
			row(
				`*Azure DevOps*\n${account?.tokens.devops ? `${ON}  Connected${as}` : `${OFF}  Not connected`}`,
				account?.tokens.devops ? disconnect : connect("devops"),
			),
		)
	}
	if (!rows.length) return []
	return [
		header(":link:  Connections"),
		...rows,
		hint("Connecting sends you a sign-in link in your DMs with dot."),
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
						"Nothing scheduled. Ask dot, e.g. _“every Monday at 9, summarise #sales”_.",
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
const ACTIONS: Record<Rule["action"], string> = {
	message: "dot posts a message",
	reaction: "dot reacts",
	task: "dot works on it",
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
	return `When ${EVENTS[rule.event] ?? rule.event}${where}${filter}, ${ACTIONS[rule.action]}`
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
						"No automations. Ask dot, e.g. _“when someone joins #general, welcome them”_.",
					),
				]),
	]
}

function memorySection(): Block[] {
	return [
		header(":thought_balloon:  Memory"),
		row(
			"*What dot remembers about you*\nYour role, preferences and how you like answers",
			button("View", "home_memory", "view"),
		),
	]
}

// ---- the page -------------------------------------------------------------------------------

/** Redraws their Home tab. A section that fails shows a short note instead of breaking the page. */
export async function refreshHome(
	client: WebClient,
	person: Person,
): Promise<void> {
	if (!deps) return
	const { config, agentSessions, automations } = deps
	const safe = async (name: string, build: () => Promise<Block[]>) =>
		build().catch(error => {
			console.warn(`[home] ${name} failed`, error)
			return [
				header(name),
				hint(":warning:  Couldn't load this right now."),
			]
		})
	const [firstName, ...sections] = await Promise.all([
		userFirstName(client, person.userId).catch(() => ""),
		safe("Agent", () => agentSection(config, person)),
		safe("Working now", () =>
			workingSection(client, agentSessions, person),
		),
		safe("Connections", () => connectionsSection(config, person)),
		safe("Scheduled", () => scheduledSection(person)),
		safe("Automations", () => automationsSection(automations, person)),
		safe("Memory", async () => memorySection()),
	])
	const notice = notices.get(personKey(person))
	notices.delete(personKey(person))
	// Slack fetches images itself, so only with a public address (assets/home-banner.png; bump ?v
	// when it changes, Slack caches it).
	const banner = config.desktopViewer.publicUrl.startsWith("https:")
		? `${config.desktopViewer.publicUrl}/_dot/home-banner.png?v=2`
		: null
	const blocks: Block[] = [
		banner
			? { type: "image", image_url: banner, alt_text: "dot" }
			: header("dot"),
		row(
			`*Hi ${escape(firstName || "there")}* :wave:\nOnly you can see this page.`,
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
		...(notice ? [divider, row(notice)] : []),
	]
	for (const section of sections.filter(section => section.length))
		blocks.push(divider, ...section)
	await client.views.publish({
		user_id: person.userId,
		view: { type: "home", blocks: blocks.slice(0, 100) },
	})
}

// ---- memory popup ---------------------------------------------------------------------------

type Memory = { user: string[]; notes: string[] }

function memoryView(memory: Memory | null, problem?: string): types.ModalView {
	const entries = (store: keyof Memory, title: string): Block[] =>
		memory?.[store].length
			? [
					header(title),
					...memory[store].map((entry, index) =>
						row(
							escape(entry),
							button(
								"Forget",
								"home_memory_forget",
								`${store}|${index + 1}`,
								{
									confirm: {
										title: "Forget this?",
										text: escape(entry).slice(0, 280),
										yes: "Forget",
									},
								},
							),
						),
					),
				]
			: []
	const empty = memory && !memory.user.length && !memory.notes.length
	return {
		type: "modal",
		callback_id: "home_memory",
		title: plain("What dot remembers"),
		close: plain("Done"),
		blocks: problem
			? [row(`:warning:  ${escape(problem)}`)]
			: !memory
				? [row(":hourglass_flowing_sand:  Loading…")]
				: empty
					? [
							row(
								"dot doesn't remember anything about you yet. It saves things as you work together: who you are, how you like answers, the tools you use.",
							),
						]
					: [
							...entries("user", "About you"),
							...entries("notes", "dot's notes"),
							divider,
							{
								type: "actions",
								elements: [
									button(
										"Forget everything",
										"home_memory_clear",
										"clear",
										{
											style: "danger",
											confirm: {
												title: "Forget everything?",
												text: "dot starts over and learns about you again from scratch.",
												yes: "Forget everything",
											},
										},
									),
								],
							},
							context("Changes apply to new conversations."),
						],
	}
}

async function readMemory(config: BotConfig, person: Person): Promise<Memory> {
	return JSON.parse(
		await runTool(config, person, ["memory", "json"]),
	) as Memory
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
	control("home_refresh", async () => {})

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
			model: undefined,
			effort: undefined,
			fast: undefined,
		}),
	)

	control("home_connect", async ({ person, client, value }) => {
		if (value === "slack" && config.slackSignIn)
			await slackSignIn.connect(config.slackSignIn, client, person)
		else if ((value === "graph" || value === "devops") && config.microsoft)
			await microsoft.connect(config.microsoft, client, person, value)
		else return
		return ":envelope_with_arrow:  Sent you a sign-in link in your DMs with dot. Come back here once you're done."
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

	control("home_memory", async ({ person, client, body }) => {
		const opened = await client.views.open({
			trigger_id: body.trigger_id,
			view: memoryView(null),
		})
		const view = opened.view!
		const memory = await readMemory(config, person).catch(error => {
			console.warn("[home] couldn't read memory", error)
			return null
		})
		await client.views.update({
			view_id: view.id!,
			view: memory
				? memoryView(memory)
				: memoryView(null, "Couldn't read dot's memory right now."),
		})
	})
	const changeMemory = async (
		client: WebClient,
		person: Person,
		viewId: string,
		args: [string, ...string[]],
	) => {
		await runTool(config, person, args)
		await client.views.update({
			view_id: viewId,
			view: memoryView(await readMemory(config, person)),
		})
	}
	control("home_memory_forget", async ({ person, client, value, body }) => {
		const [store, number] = value.split("|") as [string, string]
		await changeMemory(client, person, body.view!.id, [
			"memory",
			"forget",
			store,
			number,
		])
	})
	control("home_memory_clear", async ({ person, client, body }) => {
		await changeMemory(client, person, body.view!.id, ["memory", "clear"])
	})
}
