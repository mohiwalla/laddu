/**
 * The bot's reply after a tool action starts. Uses Slack's streaming messages: each step is a native task card
 * (spinner, then done or failed) with its command tucked into the card's details, and the answer
 * lands in the same message. Falls back to editing a plain placeholder if streaming is unavailable.
 */
import type { App } from "@slack/bolt"
import type { Step } from "../agent/steps"

type WebClient = App["client"]
type Chunk = NonNullable<
	Parameters<WebClient["chat"]["appendStream"]>[0]["chunks"]
>[number]
type TaskChunk = Extract<Chunk, { type: "task_update" }>

export type ReplyTarget = {
	channel: string
	threadTs: string
	userId: string
	teamId: string
}

/** Reads one message of a thread back (to see what a stream left behind). */
async function readMessage(
	client: WebClient,
	channel: string,
	threadTs: string,
	ts: string,
) {
	const page = await client.conversations
		.replies({
			channel,
			ts: threadTs,
			oldest: ts,
			latest: ts,
			inclusive: true,
			limit: 1,
		})
		.catch(() => null)
	return page?.messages?.find(candidate => candidate.ts === ts)
}

export type Reply = {
	step(step: Step): void
	/** Posts the answer; an empty answer (files only) just closes the progress. */
	finish(text: string): Promise<void>
	fail(message: string): Promise<void>
	/** Confirms native Stop, including when Slack already stopped the stream. */
	cancel(): Promise<void>
	/** Removes the reply altogether (the answer was only a reaction). */
	discard(): Promise<void>
}

type ReplyMessage = { ts: string; streaming: boolean }
type PostedReply = Reply & ReplyMessage

/** Slack's limit for `markdown_text`. */
const MAX_MARKDOWN = 12_000
/** Slack's limit for task and plan chunk fields. */
const MAX_TASK_TEXT = 256
const STREAM_FLUSH_MS = 800
/**
 * The running clock in the progress title ticks every second, sharing Slack's budget for stream
 * updates (chat.appendStream, ~100 a minute per app) across every reply in progress: with several
 * at once, each ticks a bit slower. A tick is skipped while an update is still in flight.
 */
const CLOCK_TICK_MS = 1_000
const CLOCK_UPDATES_PER_MINUTE = 80
let liveStreams = 0
const clockInterval = () =>
	Math.max(
		CLOCK_TICK_MS,
		Math.ceil((liveStreams * 60_000) / CLOCK_UPDATES_PER_MINUTE),
	)
const PLACEHOLDER_INTERVAL_MS = 2_500
/**
 * Slack ends a streaming message 10 minutes after it starts and rejects every update after that,
 * so a long turn's progress moves to a fresh message (in the same thread) a bit before then.
 */
const STREAM_LIFETIME_MS = 9 * 60_000
const streamEnded = (error: unknown) =>
	["message_not_in_streaming_state", "message_not_found"].includes(
		(error as { data?: { error?: string } })?.data?.error ?? "",
	)

/** Split on paragraph, then line, boundaries so each part fits in one Slack message. */
export function chunkMarkdown(
	text: string,
	max = MAX_MARKDOWN - 500,
): string[] {
	const chunks: string[] = []
	let rest = text
	while (rest.length > max) {
		const window = rest.slice(0, max)
		const cut = Math.max(
			window.lastIndexOf("\n\n"),
			window.lastIndexOf("\n"),
		)
		const at = cut > max / 2 ? cut : max
		chunks.push(rest.slice(0, at))
		rest = rest.slice(at).replace(/^\n+/, "")
	}
	chunks.push(rest)
	return chunks
}

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text

function taskChunk(step: Step, failed = false): TaskChunk {
	// Slack derives the plan's warning icon from any task with status=error. A failed tool
	// attempt is still a finished step while Codex recovers; only a failed turn gets that icon.
	const attemptFailed = step.status === "error" && !failed
	const chunk: TaskChunk = {
		type: "task_update",
		id: step.id,
		title: clip(
			attemptFailed ? `Attempt failed: ${step.title}` : step.title,
			MAX_TASK_TEXT,
		),
		status: attemptFailed ? "complete" : step.status,
	}
	// Code fence around the command; clipped inside so the fence always closes.
	if (step.details)
		chunk.details = `\`\`\`\n${clip(step.details, MAX_TASK_TEXT - 8)}\n\`\`\``
	return chunk
}

export async function openReply(
	client: WebClient,
	target: ReplyTarget,
	onPosted: (message: ReplyMessage) => Promise<void> = async () => {},
): Promise<Reply> {
	const started = Date.now()
	let posted: Promise<PostedReply> | undefined
	let chain: Promise<void> = Promise.resolve()
	let closed = false
	const remember = (message: ReplyMessage) =>
		onPosted(message).catch(error =>
			console.warn("[reply] couldn't save message:", error),
		)
	const show = async (first: Step) => {
		let reply: PostedReply
		try {
			reply = await openStream(client, target, first, started, remember)
		} catch (error) {
			console.warn(
				"[reply] streaming unavailable, using a placeholder:",
				(error as { data?: { error?: string } })?.data?.error ?? error,
			)
			reply = await openPlaceholder(client, target, first)
		}
		await remember({ ts: reply.ts, streaming: reply.streaming })
		return reply
	}
	const postText = async (text: string) => {
		let first = true
		for (const part of text ? chunkMarkdown(text) : []) {
			const message = await client.chat.postMessage({
				channel: target.channel,
				thread_ts: target.threadTs,
				markdown_text: part,
			})
			if (first && message.ts)
				await remember({ ts: message.ts, streaming: false })
			first = false
		}
	}
	const settle = async () => {
		closed = true
		await chain
		return posted?.catch(() => undefined)
	}
	return {
		step(step) {
			if (closed) return
			// The native agent status covers the time before the first real action.
			if (!posted) {
				posted = show(step)
				chain = posted.then(() => {})
			} else {
				const opening = posted
				chain = chain.then(async () => (await opening).step(step))
			}
			chain = chain.catch(error =>
				console.warn("[reply] progress unavailable:", error),
			)
		},
		async finish(text) {
			const reply = await settle()
			if (reply) await reply.finish(text)
			else await postText(text)
		},
		async fail(message) {
			const reply = await settle()
			if (reply) await reply.fail(message)
			else await postText(`:warning: ${message}`)
		},
		async cancel() {
			const reply = await settle()
			if (reply) await reply.cancel()
			else await postText("_Stopped._")
		},
		async discard() {
			await (await settle())?.discard()
		},
	}
}

async function openStream(
	client: WebClient,
	target: ReplyTarget,
	first: Step,
	started: number,
	onRolled: (message: ReplyMessage) => Promise<void>,
): Promise<PostedReply> {
	const { channel } = target
	let title = first.title
	const begin = async (tasks: Step[]) => {
		const { ts } = await client.chat.startStream({
			channel,
			thread_ts: target.threadTs,
			recipient_user_id: target.userId,
			recipient_team_id: target.teamId,
			task_display_mode: "plan",
			chunks: [
				{ type: "plan_update", title: clip(title, MAX_TASK_TEXT) },
				...tasks.map(step => taskChunk(step)),
			],
		})
		if (!ts) throw new Error("chat.startStream returned no ts")
		return ts
	}
	let ts = await begin([first])
	let opened = Date.now()

	// Latest state per step, sent in batches. Slack updates a task in place by id but appends its
	// details on every update, so they're sent once. `steps` holds this message's steps; `total`
	// counts every step across the messages a long turn rolled over to.
	let steps = new Map<string, Step>([[first.id, first]])
	let detailed = new Set<string>(first.details ? [first.id] : [])
	let earlier = 0
	const total = () => earlier + steps.size
	const toChunks = (batch: Map<string, Step>, failed = false) =>
		[...batch.values()].map(step => {
			const chunk = taskChunk(
				detailed.has(step.id) ? { ...step, details: undefined } : step,
				failed,
			)
			if (step.details) detailed.add(step.id)
			return chunk
		})
	let pending = new Map<string, Step>()
	let timer: Timer | undefined
	let chain: Promise<unknown> = Promise.resolve()
	let inFlight = 0

	/**
	 * Closes this message (its running steps carry on in the next) and opens a fresh stream below it
	 * with the steps still running, before Slack's limit, or right away if Slack already ended it.
	 */
	const rollOver = async () => {
		const done = new Map(
			[...steps.values()].map(step => [
				step.id,
				step.status === "in_progress"
					? { ...step, status: "complete" as const }
					: step,
			]),
		)
		await client.chat
			.stopStream({
				channel,
				ts,
				chunks: [
					...toChunks(done),
					{
						type: "plan_update",
						title: clip(`${title} · continued below`, MAX_TASK_TEXT),
					},
				],
			})
			.catch(() => {})
		const running = [...steps.values()].filter(
			step => step.status === "in_progress",
		)
		const left = steps
		ts = await begin(running)
		opened = Date.now()
		// Steps that came in meanwhile went to the old map (and `pending`, sent next).
		steps = new Map(running.map(step => [step.id, left.get(step.id)!]))
		for (const step of pending.values()) steps.set(step.id, step)
		earlier += left.size - running.length
		detailed = new Set(running.filter(step => step.details).map(s => s.id))
		await onRolled({ ts, streaming: true })
	}
	/** Sends an update; if the message had to roll over, the new one already shows it. */
	const append = async (chunks: Chunk[]) => {
		if (Date.now() - opened > STREAM_LIFETIME_MS) return rollOver()
		try {
			await client.chat.appendStream({ channel, ts, chunks })
		} catch (error) {
			if (!streamEnded(error)) throw error
			await rollOver()
		}
	}

	const elapsed = () => {
		const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
		return seconds < 60
			? `${seconds}s`
			: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
	}
	// Every update also refreshes the running clock in the title.
	const flush = () => {
		timer = undefined
		const chunks: Chunk[] = [
			{
				type: "plan_update",
				title: clip(`${title} · ${elapsed()}`, MAX_TASK_TEXT),
			},
			...toChunks(pending),
		]
		pending = new Map()
		inFlight++
		chain = chain
			.then(() => append(chunks))
			.catch(error => console.warn("[reply] append failed:", error))
			.finally(() => inFlight--)
	}
	liveStreams++
	let stopped = false
	let clock: Timer | undefined
	const tick = () => {
		if (stopped) return
		if (!inFlight && !timer) flush()
		clock = setTimeout(tick, clockInterval())
	}
	clock = setTimeout(tick, clockInterval())
	const update = (step: Step) => {
		if (stopped) return
		title = step.title
		steps.set(step.id, step)
		pending.set(step.id, step)
		timer ??= setTimeout(flush, STREAM_FLUSH_MS)
	}
	/** Settles every step still running and waits for queued updates. */
	const settle = async (status: Step["status"]) => {
		if (!stopped) liveStreams--
		stopped = true
		clearTimeout(clock)
		clearTimeout(timer)
		timer = undefined
		await chain
		if (Date.now() - opened > STREAM_LIFETIME_MS)
			await rollOver().catch(error =>
				console.warn("[reply] couldn't continue the progress:", error),
			)
		for (const step of steps.values())
			if (step.status === "in_progress")
				pending.set(step.id, { ...step, status })
		const chunks = toChunks(pending, status === "error")
		pending = new Map()
		return chunks
	}
	return {
		ts,
		streaming: true,
		step(step) {
			update(step)
		},
		async finish(text) {
			const tasks = await settle("complete")
			const [first, ...rest] = text ? chunkMarkdown(text) : []
			const done: Chunk[] = [
				...tasks,
				{
					type: "plan_update",
					title: `Done · ${total()} step${total() === 1 ? "" : "s"} · ${elapsed()}`,
				},
			]
			try {
				await client.chat.stopStream({
					channel,
					ts,
					chunks: first
						? [...done, { type: "markdown_text", text: first }]
						: done,
				})
			} catch (error) {
				// Some Markdown (e.g. tables) may not stream: close the progress, post the answer on its own.
				console.warn(
					"[reply] answer didn't fit the stream, posting separately:",
					error,
				)
				await client.chat
					.stopStream({ channel, ts, chunks: done })
					.catch(() => {})
				if (first) rest.unshift(first)
			}
			for (const part of rest)
				await client.chat.postMessage({
					channel,
					thread_ts: target.threadTs,
					markdown_text: part,
				})
		},
		async fail(message) {
			const tasks = await settle("error")
			await client.chat.stopStream({
				channel,
				ts,
				chunks: [
					...tasks,
					{
						type: "plan_update",
						title: `Failed after ${elapsed()}`,
					},
					{ type: "markdown_text", text: `:warning: ${message}` },
				],
			})
		},
		async cancel() {
			const tasks = await settle("complete")
			await client.chat
				.stopStream({
					channel,
					ts,
					chunks: [
						...tasks,
						{ type: "plan_update", title: "Stopped" },
						{ type: "markdown_text", text: "_Stopped._" },
					],
				})
				.catch(() =>
					client.chat.postMessage({
						channel,
						thread_ts: target.threadTs,
						markdown_text: "_Stopped._",
					}),
				)
		},
		async discard() {
			await settle("complete")
			await client.chat.stopStream({ channel, ts }).catch(() => {})
			await client.chat
				.delete({ channel, ts })
				.catch(error =>
					console.warn("[reply] couldn't remove the reply:", error),
				)
		},
	}
}

/** If streaming is unavailable, show the actual action and edit it with later steps. */
async function openPlaceholder(
	client: WebClient,
	target: ReplyTarget,
	first: Step,
): Promise<PostedReply> {
	const { channel, threadTs } = target
	const placeholder = await client.chat.postMessage({
		channel,
		thread_ts: threadTs,
		markdown_text: first.title,
	})
	const ts = placeholder.ts!

	let latest: string | null = null
	let lastSent = 0
	let timer: Timer | undefined
	let closed = false
	let chain: Promise<unknown> = Promise.resolve()
	const flush = () => {
		timer = undefined
		if (closed || latest === null) return
		const status = latest
		latest = null
		lastSent = Date.now()
		chain = chain
			.then(() =>
				client.chat.update({
					channel,
					ts,
					markdown_text: status,
				}),
			)
			.catch(() => {})
	}
	/** Stops updates and waits for any in-flight edit, so it can't overwrite the final message. */
	const close = async () => {
		closed = true
		clearTimeout(timer)
		await chain
	}

	return {
		ts,
		streaming: false,
		async cancel() {
			await close()
			await client.chat.update({
				channel,
				ts,
				markdown_text: "_Stopped._",
			})
		},
		step(step) {
			if (closed) return
			latest = step.title
			timer ??= setTimeout(
				flush,
				Math.max(0, lastSent + PLACEHOLDER_INTERVAL_MS - Date.now()),
			)
		},
		async finish(text) {
			await close()
			if (!text) {
				await client.chat.delete({ channel, ts }).catch(() => {})
				return
			}
			const [first, ...rest] = chunkMarkdown(text)
			await client.chat
				.update({ channel, ts, markdown_text: first! })
				.catch(async error => {
					// Slack won't edit a message into different block types (e.g. a Markdown table): post it fresh.
					if (error?.data?.error !== "block_mismatch") throw error
					await client.chat.postMessage({
						channel,
						thread_ts: threadTs,
						markdown_text: first!,
					})
					await client.chat.delete({ channel, ts }).catch(() => {})
				})
			for (const part of rest)
				await client.chat.postMessage({
					channel,
					thread_ts: threadTs,
					markdown_text: part,
				})
		},
		async fail(message) {
			await close()
			await client.chat.update({
				channel,
				ts,
				markdown_text: `:warning: ${message}`,
			})
		},
		async discard() {
			await close()
			await client.chat.delete({ channel, ts }).catch(() => {})
		},
	}
}

/** Closes a reply left open by a previous bot process (it was restarted mid-turn). */
export async function closeInterrupted(
	client: WebClient,
	target: { channel: string; threadTs: string },
	reply: { ts: string; streaming: boolean },
	note: string,
) {
	const { channel } = target
	if (!reply.streaming) {
		await client.chat.update({ channel, ts: reply.ts, markdown_text: note })
		return
	}
	// This process never saw the steps; read the ones still spinning off the message itself.
	const message = await readMessage(
		client,
		channel,
		target.threadTs,
		reply.ts,
	)
	// The SDK's block types predate plan blocks.
	type PlanBlock = {
		type: string
		tasks?: { task_id: string; title: string; status: string }[]
	}
	const plan = (message?.blocks as PlanBlock[] | undefined)?.find(
		block => block.type === "plan",
	)
	const stuck: Chunk[] = (plan?.tasks ?? [])
		.filter(task => task.status === "in_progress")
		.map(task => ({
			type: "task_update",
			id: task.task_id,
			title: task.title,
			status: "error",
		}))
	await client.chat.stopStream({
		channel,
		ts: reply.ts,
		chunks: [
			...stuck,
			{ type: "plan_update", title: "Interrupted" },
			{ type: "markdown_text", text: note },
		],
	})
}
