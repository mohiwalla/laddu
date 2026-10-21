/**
 * Questions dot asks in a thread (`slack ask`): choices right in the message (one-click buttons,
 * radio buttons, checkboxes, or a dropdown for many), a typed answer in a modal, or a whole form
 * of fields in a modal (question-fields.ts). Only the person the turn is for can answer. The
 * command doesn't wait: dot ends its turn, and the answer comes back as a turn of its own (or goes
 * into theirs, if one is running). A reply typed in the thread is just their next message, and
 * closes the question. Kept in memory: a restart drops open questions.
 */
import type { App, types } from "@slack/bolt"
import { sessionKey } from "../sessions"
import {
	type Field,
	FieldError,
	fieldBlock,
	parseFields,
	readField,
} from "./question-fields"

type WebClient = App["client"]
export type Asker = {
	teamId: string
	userId: string
	channel: string
	threadTs: string
}

type Question = Asker & {
	id: string
	/** The session (channel:thread:user) whose turn asked. */
	key: string
	ts: string
	text: string
	choices: string[]
	multiple: boolean
	/** Each choice is a button that answers in one click. */
	buttons: boolean
	/** Offers "Something else…" next to the choices. */
	other: boolean
	/** A form: the Answer button opens these in a modal. */
	fields?: Field[]
	/** The form's modal title. */
	title: string
	askedAt: number
	answer?: string
}

/** How long a question stays answerable. */
const OPEN_MS = 24 * 3600_000
const MAX_OPEN = 5

const questions = new Map<string, Question>()

export class QuestionError extends Error {}

function prune() {
	const now = Date.now()
	for (const [id, question] of questions)
		if (question.askedAt + OPEN_MS < now) questions.delete(id)
}

const escape = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const plain = (text: string) => ({ type: "plain_text" as const, text })

function openBlocks(question: Question): types.KnownBlock[] {
	const { choices, id } = question
	const options = choices.map((choice, index) => ({
		text: plain(choice),
		value: String(index),
	}))
	const typed = {
		type: "button" as const,
		action_id: "dot_ask_type",
		text: plain(choices.length ? "Something else…" : "Answer"),
		...(choices.length ? {} : { style: "primary" as const }),
		value: id,
	}
	const buttons = question.buttons
		? [
				...choices.map((choice, index) => ({
					type: "button" as const,
					action_id: `dot_ask_choice_${index}`,
					text: plain(choice),
					...(index === 0 ? { style: "primary" as const } : {}),
					value: `${id}:${index}`,
				})),
				...(question.other ? [typed] : []),
			]
		: [
				...(choices.length
					? [
							{
								type: "button" as const,
								action_id: "dot_ask_send",
								text: plain("Send"),
								style: "primary" as const,
								value: id,
							},
						]
					: []),
				...(question.other || !choices.length ? [typed] : []),
			]
	// Radio buttons and checkboxes hold 10; more choices go in a dropdown.
	const many = choices.length > 10
	const picker = question.multiple
		? {
				type: many ? "multi_static_select" : "checkboxes",
				action_id: "dot_ask_pick",
				options,
			}
		: {
				type: many ? "static_select" : "radio_buttons",
				action_id: "dot_ask_pick",
				options,
			}
	return [
		{ type: "section", text: { type: "mrkdwn", text: question.text } },
		...(options.length && !question.buttons
			? [
					{
						// An input block, not actions: ticking a box then stays in Slack (no round trip, no
						// spinner); Send reads the state.
						type: "input" as const,
						block_id: "dot_ask_choices",
						label: plain(
							question.multiple ? "Pick any" : "Pick one",
						),
						element: picker as types.InputBlock["element"],
					},
				]
			: []),
		{ type: "actions", elements: buttons },
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `For <@${question.userId}>${choices.length ? "" : ". Or just reply in the thread"}`,
				},
			],
		},
	]
}

/** The question with its outcome in place of the inputs. */
async function close(client: WebClient, question: Question, outcome: string) {
	await client.chat
		.update({
			channel: question.channel,
			ts: question.ts,
			text: question.text,
			blocks: [
				{
					type: "section",
					text: { type: "mrkdwn", text: question.text },
				},
				{
					type: "context",
					elements: [{ type: "mrkdwn", text: outcome }],
				},
			],
		})
		.catch(error =>
			console.warn("[ask] couldn't update the question", error),
		)
}

/** Their answer: goes to dot as a turn (or into the one running for them there). */
type Answered = (question: Asker & { ts: string }, request: string) => void
let answered: Answered = () => {}

function settle(
	client: WebClient,
	question: Question,
	answer: string,
	outcome?: string,
) {
	if (question.answer !== undefined) return
	question.answer = answer
	questions.delete(question.id)
	void close(
		client,
		question,
		outcome ??
			`:white_check_mark: <@${question.userId}>: ${escape(answer)}`,
	)
	answered(question, `You asked: "${question.text}" Their answer: ${answer}`)
}

export async function ask(
	client: WebClient,
	asker: Asker,
	input: {
		text?: unknown
		choices?: unknown
		multiple?: unknown
		buttons?: unknown
		other?: unknown
		fields?: unknown
		title?: unknown
	},
): Promise<string> {
	prune()
	const text = typeof input.text === "string" ? input.text.trim() : ""
	if (!text || text.length > 2500)
		throw new QuestionError("Give the question (at most 2500 characters).")
	const choices = Array.isArray(input.choices) ? input.choices : []
	const buttons = input.buttons === true
	const limit = buttons ? 5 : 100
	if (
		choices.length === 1 ||
		choices.length > limit ||
		choices.some(
			choice =>
				typeof choice !== "string" ||
				!choice.trim() ||
				choice.length > 75,
		) ||
		new Set(choices).size !== choices.length
	)
		throw new QuestionError(
			`Give 2–${limit} different choices of at most 75 characters, or none for a typed answer.`,
		)
	if (buttons && input.multiple === true)
		throw new QuestionError(
			"Buttons answer in one click, so they can't be --multiple.",
		)
	let fields: Field[] | undefined
	if (input.fields !== undefined) {
		if (choices.length)
			throw new QuestionError(
				"Give choices or fields, not both (a select field holds choices).",
			)
		try {
			fields = parseFields(input.fields)
		} catch (error) {
			if (error instanceof FieldError)
				throw new QuestionError(error.message)
			throw error
		}
	}
	const title =
		typeof input.title === "string" && input.title.trim()
			? input.title.trim()
			: "Answer dot"
	if (title.length > 24)
		throw new QuestionError("The title is at most 24 characters.")
	const key = sessionKey(asker.channel, asker.threadTs, asker.userId)
	if (
		[...questions.values()].filter(question => question.key === key)
			.length >= MAX_OPEN
	)
		throw new QuestionError(
			`There are already ${MAX_OPEN} open questions in this thread; wait for those answers.`,
		)
	const question: Question = {
		...asker,
		id: crypto.randomUUID(),
		key,
		ts: "",
		text,
		choices: choices.map(choice => (choice as string).trim()),
		multiple: input.multiple === true && choices.length > 0,
		buttons: buttons && choices.length > 0,
		other: input.other !== false && !fields,
		...(fields ? { fields } : {}),
		title,
		askedAt: Date.now(),
	}
	const posted = await client.chat.postMessage({
		channel: asker.channel,
		thread_ts: asker.threadTs,
		text,
		blocks: openBlocks(question),
	})
	question.ts = posted.ts!
	questions.set(question.id, question)
	return question.id
}

/**
 * A message from them in the thread: their reply to whatever dot asked them there, so it closes
 * those questions and goes on as their next message. Whether any were open.
 */
export function closeWithMessage(client: WebClient, key: string): boolean {
	const open = [...questions.values()].filter(
		question => question.key === key,
	)
	for (const question of open) {
		questions.delete(question.id)
		void close(client, question, ":speech_balloon: Answered in the thread")
	}
	return open.length > 0
}

/** They stopped dot's work in this thread: its questions there are withdrawn. */
export function withdrawQuestions(client: WebClient, key: string) {
	for (const question of questions.values()) {
		if (question.key !== key) continue
		questions.delete(question.id)
		void close(client, question, "_No longer needed._")
	}
}

export function registerQuestions(app: App, onAnswer: Answered) {
	answered = onAnswer
	/** The question behind a click, or null after telling the clicker why they can't answer. */
	const clicked = async (
		client: WebClient,
		id: string,
		user: string,
		channel: string | undefined,
	) => {
		const question = questions.get(id)
		const tell = (text: string) =>
			channel &&
			client.chat
				.postEphemeral({
					channel,
					user,
					text,
					...(question ? { thread_ts: question.threadTs } : {}),
				})
				.catch(() => {})
		if (!question || question.answer !== undefined) {
			await tell("This question isn't open any more.")
			return null
		}
		if (question.userId !== user) {
			await tell(`Only <@${question.userId}> can answer this one.`)
			return null
		}
		return question
	}

	// Questions posted before choices moved into an input block still send each pick.
	app.action("dot_ask_pick", async ({ ack }) => ack())
	app.action("dot_ask_send", async ({ ack, body, action, client }) => {
		await ack()
		if (
			body.type !== "block_actions" ||
			!("value" in action) ||
			!action.value
		)
			return
		const question = await clicked(
			client,
			action.value,
			body.user.id,
			body.channel?.id,
		)
		if (!question) return
		const picked = body.state?.values?.dot_ask_choices?.dot_ask_pick
		const indexes = (
			question.multiple
				? (picked?.selected_options ?? [])
				: picked?.selected_option
					? [picked.selected_option]
					: []
		).map(option => Number(option.value))
		const answer = indexes
			.map(index => question.choices[index])
			.filter(choice => choice !== undefined)
		if (!answer.length) {
			await client.chat
				.postEphemeral({
					channel: question.channel,
					user: body.user.id,
					thread_ts: question.threadTs,
					text: question.multiple
						? "Tick at least one first."
						: "Pick one first.",
				})
				.catch(() => {})
			return
		}
		settle(client, question, answer.join(", "))
	})
	app.action(
		/^dot_ask_choice_\d+$/,
		async ({ ack, body, action, client }) => {
			await ack()
			if (
				body.type !== "block_actions" ||
				!("value" in action) ||
				!action.value
			)
				return
			const [id, index] = action.value.split(":")
			const question = await clicked(
				client,
				id!,
				body.user.id,
				body.channel?.id,
			)
			const choice = question?.choices[Number(index)]
			if (question && choice !== undefined)
				settle(client, question, choice)
		},
	)
	app.action("dot_ask_type", async ({ ack, body, action, client }) => {
		await ack()
		if (
			body.type !== "block_actions" ||
			!("value" in action) ||
			!action.value
		)
			return
		const question = await clicked(
			client,
			action.value,
			body.user.id,
			body.channel?.id,
		)
		if (!question) return
		await client.views
			.open({
				trigger_id: body.trigger_id,
				view: {
					type: "modal",
					callback_id: "dot_ask_submit",
					private_metadata: question.id,
					title: plain(question.title),
					submit: plain("Send"),
					close: plain("Cancel"),
					blocks: [
						{
							type: "section",
							text: { type: "mrkdwn", text: question.text },
						},
						...(question.fields?.map(fieldBlock) ?? [
							{
								type: "input" as const,
								block_id: "answer",
								label: plain("Your answer"),
								element: {
									type: "plain_text_input" as const,
									action_id: "value",
									multiline: true,
									max_length: 3000,
								},
							},
						]),
					],
				},
			})
			.catch(error =>
				console.warn("[ask] couldn't open the answer form", error),
			)
	})
	app.view("dot_ask_submit", async ({ ack, body, view, client }) => {
		await ack()
		const question = questions.get(view.private_metadata)
		if (!question || question.userId !== body.user.id) return
		if (question.fields) {
			const read = question.fields.map(field => ({
				field,
				...readField(
					field,
					view.state.values[field.name]?.value as never,
				),
			}))
			settle(
				client,
				question,
				JSON.stringify(
					Object.fromEntries(
						read.map(({ field, value }) => [field.label, value]),
					),
				),
				[
					`:white_check_mark: <@${question.userId}> answered:`,
					...read.map(
						({ field, shown }) =>
							`*${escape(field.label)}:* ${shown}`,
					),
				].join("\n"),
			)
			return
		}
		const answer = view.state.values.answer?.value?.value?.trim()
		if (answer) settle(client, question, answer)
	})
}

/** For tests. */
export function clearQuestions() {
	questions.clear()
}
