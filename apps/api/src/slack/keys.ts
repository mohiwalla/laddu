/**
 * Keys people give laddu (API keys, tokens, passwords) without putting them in the chat, where the
 * model and its provider would see them. They're typed into a Slack form, which comes to the bot
 * directly, and saved in the person's own container (`connections key save`, runtime/connections),
 * where their agent's commands and MCP servers read them. Two ways in: "Add a key" on the Home tab,
 * or laddu asking (`connections key request`), which posts a button only they can use (in a
 * channel, in a message only they can see) and, once they've added it, carries on as a turn of its
 * own. Requests are kept in memory: a restart drops open ones.
 */
import type { App, types } from "@slack/bolt"
import { postAs } from "../appearance"
import type { BotConfig } from "../config"
import { runTool } from "../agent/tools"
import { refreshHome } from "./home"
import { systemName } from "./system"

type WebClient = App["client"]
type Person = { teamId: string; userId: string }
export type Asker = Person & { channel: string; threadTs: string }

type Request = Asker & {
	id: string
	name: string
	note: string
	ts: string
	/** Only visible to them (in a channel): edited through the button's response URL, not by ts. */
	ephemeral: boolean
	responseUrl?: string
	askedAt: number
}

export const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_NOTE = 200
const MAX_VALUE = 16 * 1024
/** How long a request stays open. */
const OPEN_MS = 24 * 3600_000

const requests = new Map<string, Request>()
/** When laddu last asked for a key, by person and thread. */
const lastAsked = new Map<string, number>()
const askerKey = (asker: Asker) =>
	[asker.teamId, asker.userId, asker.channel, asker.threadTs].join(":")

/** Whether laddu asked them for a key here since `since`: the request is its message for the turn. */
export function askedForKey(asker: Asker, since: number): boolean {
	return (lastAsked.get(askerKey(asker)) ?? 0) >= since
}

export class KeyError extends Error {}

const escape = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const plain = (text: string) => ({ type: "plain_text" as const, text })

/** Saves a key in their container; the value goes on stdin, never on a command line. */
export async function saveKey(
	config: BotConfig,
	person: Person,
	name: string,
	note: string,
	value: string,
): Promise<void> {
	await runTool(
		config,
		person,
		["connections", "key", "save", name, "--note", note],
		value,
	)
}

/** The form for a key: the name and note are fixed when laddu asked for this one. */
export function keyView(
	callbackId: string,
	metadata: string,
	asked?: { name: string; note: string },
): types.ModalView {
	return {
		type: "modal",
		callback_id: callbackId,
		private_metadata: metadata,
		title: plain("Add a key"),
		submit: plain("Save"),
		close: plain("Cancel"),
		blocks: [
			...(asked
				? [
						{
							type: "section" as const,
							text: {
								type: "mrkdwn" as const,
								text: `*\`${asked.name}\`*${asked.note ? `\n${escape(asked.note)}` : ""}`,
							},
						},
					]
				: [
						{
							type: "input" as const,
							block_id: "name",
							label: plain("Name"),
							hint: plain(
								"Capitals, digits and _, e.g. GITHUB_TOKEN. Saving one with the same name replaces it.",
							),
							element: {
								type: "plain_text_input" as const,
								action_id: "value",
								max_length: 64,
								placeholder: plain("GITHUB_TOKEN"),
							},
						},
						{
							type: "input" as const,
							block_id: "note",
							optional: true,
							label: plain("What it's for"),
							element: {
								type: "plain_text_input" as const,
								action_id: "value",
								max_length: MAX_NOTE,
								placeholder: plain(
									"GitHub, to open PRs in our repos",
								),
							},
						},
					]),
			{
				type: "input",
				block_id: "secret",
				label: plain("Key"),
				hint: plain(
					`Saved on ${systemName()}'s computer for you, never posted in Slack or passed through the chat. Remove it any time on the Home tab.`,
				),
				element: {
					type: "plain_text_input",
					action_id: "value",
					multiline: true,
					max_length: 3000,
				},
			},
		],
	}
}

/** The form's name, note and key, or the field to fix and why. */
export function readKeyForm(
	view: {
		state: {
			values: Record<string, Record<string, { value?: string | null }>>
		}
	},
	asked?: { name: string; note: string },
):
	| { name: string; note: string; value: string }
	| { field: string; problem: string } {
	const field = (block: string) =>
		view.state.values[block]?.value?.value?.trim() ?? ""
	const name = asked?.name ?? field("name")
	const value = field("secret")
	if (!KEY_NAME.test(name))
		return {
			field: "name",
			problem: "Capitals, digits and _, starting with a letter.",
		}
	if (!value) return { field: "secret", problem: "Paste the key." }
	if (new TextEncoder().encode(value).length > MAX_VALUE)
		return { field: "secret", problem: "That's too long for a key." }
	return { name, note: asked?.note ?? field("note"), value }
}

function prune() {
	const now = Date.now()
	for (const [id, request] of requests)
		if (request.askedAt + OPEN_MS < now) requests.delete(id)
}

/** `connections key request`: a button in the thread that only they can use. */
export async function requestKey(
	client: WebClient,
	asker: Asker,
	input: { name?: unknown; note?: unknown },
): Promise<string> {
	prune()
	const name = typeof input.name === "string" ? input.name : ""
	const note = typeof input.note === "string" ? input.note.trim() : ""
	if (!KEY_NAME.test(name))
		throw new KeyError(
			"A key's name is capitals, digits and _, starting with a letter (e.g. GITHUB_TOKEN).",
		)
	if (!note || note.length > MAX_NOTE)
		throw new KeyError(
			`Say what it's for, in at most ${MAX_NOTE} characters.`,
		)
	const request: Request = {
		...asker,
		id: crypto.randomUUID(),
		name,
		note,
		ts: "",
		// A DM is already private; in a channel, only they see the request.
		ephemeral: !asker.channel.startsWith("D"),
		askedAt: Date.now(),
	}
	const text = `:lock:  <@${asker.userId}>, add \`${name}\` here: ${escape(note)}`
	const message = {
		channel: asker.channel,
		thread_ts: asker.threadTs,
		text,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text } },
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "laddu_key_add",
						text: plain("Add it securely"),
						style: "primary",
						value: request.id,
					},
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `${request.ephemeral ? "Only you can see this." : `Only <@${asker.userId}> can add it.`} It goes straight to ${systemName()}'s computer, not into this chat; please don't paste keys in messages.`,
					},
				],
			},
		],
		...(await postAs(asker)),
	}
	request.ts =
		(request.ephemeral
			? (
					await client.chat.postEphemeral({
						...message,
						user: asker.userId,
					})
				).message_ts
			: (await client.chat.postMessage(message)).ts) ?? ""
	requests.set(request.id, request)
	lastAsked.set(askerKey(asker), request.askedAt)
	return `Asked them for ${name} with a private form; that's your message, nothing else goes in the thread. End your turn now; you'll hear back once they've added it.`
}

/** A key they added when asked: goes to laddu as a turn (or into theirs, if one is running). */
type Added = (request: Asker & { ts: string }, message: string) => void

export function registerKeys(
	app: App,
	deps: { config: BotConfig; isAllowed: (user: string) => boolean },
	onAdded: Added,
) {
	app.action("laddu_key_add", async ({ ack, body, action, client }) => {
		await ack()
		if (body.type !== "block_actions" || !("value" in action)) return
		const request = requests.get(action.value ?? "")
		const tell = (text: string) =>
			body.channel &&
			client.chat
				.postEphemeral({
					channel: body.channel.id,
					user: body.user.id,
					text,
					...(request ? { thread_ts: request.threadTs } : {}),
				})
				.catch(() => {})
		if (!request) return void (await tell("This isn't open any more."))
		if (request.userId !== body.user.id)
			return void (await tell(
				`Only <@${request.userId}> can add this one.`,
			))
		request.responseUrl = body.response_url
		await client.views.open({
			trigger_id: body.trigger_id,
			view: keyView("laddu_key_save", request.id, request),
		})
	})

	app.view("laddu_key_save", async ({ ack, body, view, client }) => {
		const request = requests.get(view.private_metadata)
		if (!request || request.userId !== body.user.id)
			return ack({
				response_action: "errors",
				errors: { secret: "This isn't open any more." },
			})
		const form = readKeyForm(view, request)
		if ("problem" in form)
			return ack({
				response_action: "errors",
				errors: { [form.field]: form.problem },
			})
		await ack()
		requests.delete(request.id)
		try {
			await saveKey(
				deps.config,
				request,
				form.name,
				form.note,
				form.value,
			)
		} catch (error) {
			console.warn("[keys] couldn't save", error)
			requests.set(request.id, request)
			await client.chat
				.postEphemeral({
					channel: request.channel,
					user: request.userId,
					thread_ts: request.threadTs,
					text: `:warning:  Couldn't save \`${form.name}\`. Press the button to try again.`,
				})
				.catch(() => {})
			return
		}
		const done = `:lock:  <@${request.userId}> added \`${form.name}\`.`
		const update = {
			text: done,
			blocks: [{ type: "section", text: { type: "mrkdwn", text: done } }],
		}
		await (
			!request.ephemeral
				? client.chat.update({
						channel: request.channel,
						ts: request.ts,
						...update,
					})
				: request.responseUrl
					? fetch(request.responseUrl, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								replace_original: true,
								...update,
							}),
						})
					: Promise.resolve()
		).catch(error => console.warn("[keys] couldn't update", error))
		void refreshHome(client, request).catch(() => {})
		onAdded(
			request,
			`You asked them for the key ${form.name} (${request.note}); they've added it. Use it as "$(cat ~/.laddu/keys/${form.name})".`,
		)
	})
}
