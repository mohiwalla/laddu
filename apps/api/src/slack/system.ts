/**
 * Messages from the system rather than the agent: sign-ins, failures, confirmations. They never
 * speak as the agent ("I"): they say what the bot needs or what happened, in a line or two, with
 * numbered steps when there's something to do. Sent from the bot itself, never with a person's
 * custom name and picture for laddu.
 */
import type { App, types } from "@slack/bolt"

type WebClient = App["client"]
type Block = types.KnownBlock
type Person = { teamId: string; userId: string }

/** The bot's name in Slack (index.ts sets it at startup), for "dot needs…". */
let name = "laddu"
export const setSystemName = (value: string) => {
	if (value) name = value
}
export const systemName = () => name
/** Its slash command, which `laddu setup` names after it (apps/cli's commandName). */
export const commandName = () =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 31) || "laddu"

export type Notice = {
	/** One bold line saying what this is: "Connect ChatGPT". */
	title: string
	icon?: string
	/** One short line: why, or what happened. */
	text?: string
	/** What to do, in order. */
	steps?: string[]
	/** A code to type, shown large. */
	code?: string
	/** The main button. */
	link?: { label: string; url: string }
	/** Other choices, after it: buttons an app.action handles (each action id once per message). */
	buttons?: {
		label: string
		action: string
		value: string
		primary?: boolean
	}[]
	/** Small print: how long it works, what to do if they didn't ask. */
	footer?: string
}

/** The notice as Slack blocks, plus the plain text Slack shows in notifications. */
export function noticeMessage(
	notice: Notice,
	/** Sent with the button's click, so the message can be replaced afterwards. */
	id?: string,
): { text: string; blocks: Block[] } {
	const blocks: Block[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: [
					`${notice.icon ? `${notice.icon}  ` : ""}*${notice.title}*`,
					notice.text,
				]
					.filter(Boolean)
					.join("\n"),
			},
		},
	]
	if (notice.steps?.length)
		blocks.push({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "ordered",
					elements: notice.steps.map(step => ({
						type: "rich_text_section",
						elements: richText(step),
					})),
				},
			],
		})
	if (notice.code)
		blocks.push({
			type: "header",
			text: { type: "plain_text", text: notice.code, emoji: false },
		})
	if (notice.link || notice.buttons?.length)
		blocks.push({
			type: "actions",
			elements: [
				...(notice.link
					? [
							{
								type: "button" as const,
								action_id: "system_link",
								text: {
									type: "plain_text" as const,
									text: notice.link.label,
								},
								url: notice.link.url,
								style: "primary" as const,
							},
						]
					: []),
				...(notice.buttons ?? []).map(button => ({
					type: "button" as const,
					action_id: button.action,
					text: { type: "plain_text" as const, text: button.label },
					value: button.value,
					...(button.primary ? { style: "primary" as const } : {}),
				})),
			],
		})
	if (notice.footer)
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: notice.footer }],
		})
	const text = [
		notice.title,
		notice.text,
		notice.code && `Code: ${notice.code}`,
		notice.link?.url,
	]
		.filter(Boolean)
		.join(" · ")
	return { text, blocks }
}

/** A step's text as rich text, keeping `*bold*` and `<url|links>`. */
const richText = (step: string) =>
	step
		.split(/(\*[^*]+\*|<[^|>]+\|[^>]+>)/)
		.filter(Boolean)
		.map(part => {
			const link = part.match(/^<([^|>]+)\|([^>]+)>$/)
			if (link)
				return { type: "link" as const, url: link[1]!, text: link[2]! }
			if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
				return {
					type: "text" as const,
					text: part.slice(1, -1),
					style: { bold: true },
				}
			return { type: "text" as const, text: part }
		})

/** Where a notice goes: the conversation they're in (private to them), or null for their DM. */
export type Where = { channel: string; threadTs?: string } | null

/** A sent notice, to replace once it's done its job (a sign-in code with the outcome). */
export type Sent = { replace: (notice: Notice) => Promise<void> }

/**
 * Where to replace each private notice, by id: Slack can't delete or edit a message only one
 * person sees, except through the response URL a click on it gives (good for 30 minutes).
 */
const clicked = new Map<string, string>()

/** A click on a notice's button: remembers how to replace it. */
export function noticeClicked(
	id: string | undefined,
	responseUrl: string | undefined,
) {
	if (!id || !responseUrl) return
	clicked.set(id, responseUrl)
	setTimeout(() => clicked.delete(id), 30 * 60_000)
}

/**
 * Sends a notice only they can see: in a channel or group, privately in the thread they're in
 * ("Only visible to you"); in their DM with the bot (or with no conversation), as a plain message.
 * `replace` swaps it for another notice: in place when Slack allows it (a DM, or a private one
 * they've pressed the button on), otherwise as a new one in the same place.
 */
export async function sendNotice(
	client: WebClient,
	person: Person,
	where: Where,
	notice: Notice,
): Promise<Sent> {
	const id = crypto.randomUUID()
	const message = noticeMessage(notice, id)
	const post = (channel: string, threadTs?: string) =>
		client.chat.postMessage({
			channel,
			...(threadTs ? { thread_ts: threadTs } : {}),
			...message,
		})
	const inMessage = (channel: string, ts: string | undefined): Sent => ({
		replace: async next => {
			if (!ts) return void (await sendNotice(client, person, where, next))
			await client.chat.update({ channel, ts, ...noticeMessage(next) })
		},
	})
	if (!where || where.channel.startsWith("D")) {
		const sent = await post(
			where?.channel ?? person.userId,
			where?.threadTs,
		)
		return inMessage(sent.channel ?? person.userId, sent.ts)
	}
	try {
		await client.chat.postEphemeral({
			channel: where.channel,
			user: person.userId,
			...(where.threadTs ? { thread_ts: where.threadTs } : {}),
			...message,
		})
	} catch {
		// Not in that channel any more, or it's gone: their DM instead.
		const sent = await post(person.userId)
		return inMessage(sent.channel ?? person.userId, sent.ts)
	}
	return {
		replace: async next => {
			const url = clicked.get(id)
			clicked.delete(id)
			const replaced =
				url &&
				(await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						replace_original: true,
						...noticeMessage(next),
					}),
				})
					.then(response => response.ok)
					.catch(() => false))
			if (!replaced) await sendNotice(client, person, where, next)
		},
	}
}
