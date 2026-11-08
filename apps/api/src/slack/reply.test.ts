import { expect, mock, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import { openReply, showTodos } from "./reply"

type StreamArgs = Parameters<App["client"]["chat"]["appendStream"]>[0]
type StartArgs = Parameters<App["client"]["chat"]["startStream"]>[0]
const target = {
	channel: "C_ONE",
	threadTs: "1.001",
	userId: "U_ONE",
	teamId: "T_ONE",
}

function streamingClient() {
	const startStream = mock(async (_args: StartArgs) => ({
		ok: true,
		ts: "2.001",
	}))
	const appendStream = mock(async (_args: StreamArgs) => ({ ok: true }))
	const stopStream = mock(async (_args: StreamArgs) => ({ ok: true }))
	const postMessage = mock(
		async (_args: Parameters<App["client"]["chat"]["postMessage"]>[0]) => ({
			ok: true,
			ts: "3.001",
		}),
	)
	const update = mock(
		async (_args: Parameters<App["client"]["chat"]["update"]>[0]) => ({
			ok: true,
		}),
	)
	const remove = mock(async () => ({ ok: true }))
	const client = {
		chat: {
			startStream,
			appendStream,
			stopStream,
			postMessage,
			update,
			delete: remove,
		},
	} as unknown as App["client"]
	return {
		client,
		startStream,
		appendStream,
		stopStream,
		postMessage,
		update,
		remove,
	}
}

test("a failed tool attempt stays visible without failing a recovered plan", async () => {
	const { client, startStream, appendStream, stopStream } = streamingClient()
	const reply = await openReply(client, target)
	try {
		reply.step({
			id: "download",
			title: "Reading the canvas",
			status: "error",
			details: "slack download F_ONE canvas.html",
		})
		// Exercise a failure already published to Slack, not only one pending at finish.
		expect(startStream).toHaveBeenCalled()
		reply.step({
			id: "browser",
			title: "Reading the canvas in the browser",
			status: "complete",
		})
	} finally {
		await reply.finish("Converted all 10 points into checkboxes.")
	}
	const chunks = [
		...startStream.mock.calls,
		...appendStream.mock.calls,
		...stopStream.mock.calls,
	].flatMap(([args]) => args.chunks ?? [])
	expect(
		chunks.some(
			chunk => chunk.type === "task_update" && chunk.status === "error",
		),
	).toBe(false)
	expect(chunks).toContainEqual(
		expect.objectContaining({
			type: "task_update",
			id: "download",
			title: "Attempt failed: Reading the canvas",
			details: expect.stringContaining("slack download"),
		}),
	)
	expect(chunks).toContainEqual({
		type: "markdown_text",
		text: "Converted all 10 points into checkboxes.",
	})
})

test("a terminal failure still marks the plan failed and explains the failure", async () => {
	const { client, stopStream } = streamingClient()
	const reply = await openReply(client, target)
	reply.step({ id: "read", title: "Reading", status: "in_progress" })
	await reply.fail("The model connection could not be restored.")
	const chunks = stopStream.mock.calls[0]![0].chunks!
	expect(chunks).toContainEqual(
		expect.objectContaining({ type: "task_update", status: "error" }),
	)
	expect(chunks).toContainEqual(
		expect.objectContaining({
			type: "plan_update",
			title: expect.stringMatching(/^Failed after /),
		}),
	)
	expect(chunks).toContainEqual({
		type: "markdown_text",
		text: ":warning: The model connection could not be restored.",
	})
})

test("stopping a turn does not label it failed", async () => {
	const { client, stopStream } = streamingClient()
	const reply = await openReply(client, target)
	reply.step({ id: "read", title: "Reading", status: "error" })
	await reply.cancel()
	const chunks = stopStream.mock.calls[0]![0].chunks!
	expect(
		chunks.some(
			chunk => chunk.type === "task_update" && chunk.status === "error",
		),
	).toBe(false)
	expect(chunks).toContainEqual({ type: "plan_update", title: "Stopped" })
})

test("a direct answer creates no progress message before the final response", async () => {
	const { client, startStream, postMessage } = streamingClient()
	const recorded = mock(
		async (_message: { ts: string; streaming: boolean }) => {},
	)
	const reply = await openReply(client, target, recorded)
	expect(startStream).not.toHaveBeenCalled()
	expect(postMessage).not.toHaveBeenCalled()
	expect(recorded).not.toHaveBeenCalled()
	await reply.finish("You're welcome.")
	expect(startStream).not.toHaveBeenCalled()
	expect(postMessage).toHaveBeenCalledTimes(1)
	expect(postMessage).toHaveBeenCalledWith({
		channel: target.channel,
		thread_ts: target.threadTs,
		markdown_text: "You're welcome.",
	})
	expect(recorded).toHaveBeenCalledWith({ ts: "3.001", streaming: false })
})

test.each(["reaction", "files"])(
	"%s-only turns create no empty accordion or placeholder",
	async kind => {
		const { client, startStream, postMessage, remove } = streamingClient()
		const reply = await openReply(client, target)
		if (kind === "reaction") await reply.discard()
		else await reply.finish("")
		expect(startStream).not.toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()
		expect(remove).not.toHaveBeenCalled()
	},
)

test("failure before any action posts only the error", async () => {
	const { client, startStream, postMessage } = streamingClient()
	const reply = await openReply(client, target)
	await reply.fail("Please sign in again.")
	expect(startStream).not.toHaveBeenCalled()
	expect(postMessage).toHaveBeenCalledWith({
		channel: target.channel,
		thread_ts: target.threadTs,
		markdown_text: ":warning: Please sign in again.",
	})
})

test("the first action opens an accordion with real command details and no synthetic stages", async () => {
	const { client, startStream, appendStream, stopStream } = streamingClient()
	const recorded = mock(
		async (_message: { ts: string; streaming: boolean }) => {},
	)
	const reply = await openReply(client, target, recorded)
	const first = {
		id: "read",
		title: "Reading your checklist",
		status: "in_progress" as const,
		details: "slack canvas read F_ONE",
	}
	reply.step(first)
	reply.step({ ...first, status: "complete" })
	await reply.finish("Updated your checklist.")
	expect(startStream).toHaveBeenCalledTimes(1)
	expect(startStream.mock.calls[0]![0].chunks).toContainEqual({
		type: "plan_update",
		title: first.title,
	})
	expect(recorded).toHaveBeenCalledWith({ ts: "2.001", streaming: true })
	const chunks = [
		...startStream.mock.calls,
		...appendStream.mock.calls,
		...stopStream.mock.calls,
	].flatMap(([args]) => args.chunks ?? [])
	const tasks = chunks.filter(chunk => chunk.type === "task_update")
	expect(tasks.every(task => task.id === first.id)).toBe(true)
	expect(
		tasks.filter(task => task.details?.includes(first.details)),
	).toHaveLength(1)
	expect(
		chunks.some(
			chunk =>
				chunk.type === "plan_update" &&
				/Working on it|Thinking|Reading the conversation/.test(
					chunk.title,
				),
		),
	).toBe(false)
	expect(chunks).toContainEqual(
		expect.objectContaining({
			type: "plan_update",
			title: expect.stringMatching(/^Done · 1 step · /),
		}),
	)
})

test("finishing waits for stream creation and preserves steps received while it opens", async () => {
	const { client, startStream, stopStream } = streamingClient()
	let release!: (message: { ok: boolean; ts: string }) => void
	startStream.mockImplementation(
		() =>
			new Promise(resolve => {
				release = resolve
			}),
	)
	const reply = await openReply(client, target)
	reply.step({ id: "read", title: "Reading", status: "in_progress" })
	reply.step({ id: "read", title: "Reading", status: "complete" })
	reply.step({ id: "edit", title: "Updating", status: "complete" })
	const finishing = reply.finish("Done")
	expect(stopStream).not.toHaveBeenCalled()
	release({ ok: true, ts: "2.001" })
	await finishing
	expect(stopStream.mock.calls[0]![0].chunks).toContainEqual(
		expect.objectContaining({
			type: "task_update",
			id: "edit",
			status: "complete",
		}),
	)
})

test("streaming fallback starts with the actual action and ends with the answer", async () => {
	const { client, startStream, postMessage, update } = streamingClient()
	startStream.mockRejectedValue({ data: { error: "feature_disabled" } })
	const recorded = mock(
		async (_message: { ts: string; streaming: boolean }) => {},
	)
	const reply = await openReply(client, target, recorded)
	expect(postMessage).not.toHaveBeenCalled()
	reply.step({
		id: "edit",
		title: "Updating your checklist",
		status: "in_progress",
	})
	await reply.finish("Done")
	expect(postMessage).toHaveBeenCalledWith({
		channel: target.channel,
		thread_ts: target.threadTs,
		markdown_text: "Updating your checklist",
	})
	expect(recorded).toHaveBeenCalledWith({ ts: "3.001", streaming: false })
	expect(update).toHaveBeenLastCalledWith({
		channel: target.channel,
		ts: "3.001",
		markdown_text: "Done",
	})
})

test("a long turn moves its progress to a new message before Slack ends the stream", async () => {
	const { client, startStream, appendStream, stopStream } = streamingClient()
	startStream
		.mockResolvedValueOnce({ ok: true, ts: "2.001" })
		.mockResolvedValueOnce({ ok: true, ts: "2.002" })
	const posted: string[] = []
	const now = Date.now()
	const clock = spyOn(Date, "now").mockReturnValue(now)
	try {
		const reply = await openReply(client, target, async m => {
			posted.push(m.ts)
		})
		reply.step({ id: "a", title: "Building", status: "in_progress" })
		reply.step({ id: "b", title: "Testing", status: "complete" })
		await Bun.sleep(900)
		clock.mockReturnValue(now + 9 * 60_000 + 1_000)
		reply.step({ id: "c", title: "Fixing", status: "in_progress" })
		await reply.finish("Shipped")
	} finally {
		clock.mockRestore()
	}
	expect(posted).toEqual(["2.001", "2.002"])
	const closed = stopStream.mock.calls[0]![0]
	expect(closed.ts).toBe("2.001")
	expect(closed.chunks).toContainEqual(
		expect.objectContaining({ id: "a", status: "complete" }),
	)
	// The new message carries the running step and the next one, not finished ones.
	const ids = [
		...(startStream.mock.calls[1]![0].chunks ?? []),
		...appendStream.mock.calls
			.filter(([args]) => args.ts === "2.002")
			.flatMap(([args]) => args.chunks ?? []),
		...(stopStream.mock.calls[1]![0].chunks ?? []),
	].flatMap(chunk => (chunk.type === "task_update" ? [chunk.id] : []))
	expect(new Set(ids)).toEqual(new Set(["a", "c"]))
	expect(stopStream.mock.calls[1]![0].chunks).toContainEqual(
		expect.objectContaining({
			title: expect.stringMatching(/^Done · 3 steps/),
		}),
	)
})

test("progress continues in a new message when Slack already ended the stream", async () => {
	const { client, startStream, appendStream } = streamingClient()
	startStream
		.mockResolvedValueOnce({ ok: true, ts: "2.001" })
		.mockResolvedValueOnce({ ok: true, ts: "2.002" })
	appendStream.mockRejectedValueOnce({
		data: { error: "message_not_in_streaming_state" },
	})
	const reply = await openReply(client, target)
	reply.step({ id: "a", title: "Building", status: "in_progress" })
	reply.step({ id: "a", title: "Building", status: "complete" })
	reply.step({ id: "b", title: "Testing", status: "in_progress" })
	await Bun.sleep(900)
	await reply.finish("Done")
	expect(startStream).toHaveBeenCalledTimes(2)
	expect(startStream.mock.calls[1]![0].chunks).toContainEqual(
		expect.objectContaining({ id: "b", status: "in_progress" }),
	)
})

const todos = (current: number) => ({
	title: "Scheduled exports",
	items: ["Design the table", "Cron dispatcher", "Backfill job"].map(
		(text, index) => ({
			text,
			status:
				index < current
					? ("completed" as const)
					: index === current
						? ("in_progress" as const)
						: ("pending" as const),
		}),
	),
})

test("a to-do list goes above the steps, which carry on below it with the answer", async () => {
	const {
		client,
		startStream,
		appendStream,
		stopStream,
		postMessage,
		remove,
	} = streamingClient()
	startStream
		.mockResolvedValueOnce({ ok: true, ts: "2.001" })
		.mockResolvedValueOnce({ ok: true, ts: "2.002" })
	const reply = await openReply(client, target)
	reply.step({ id: "read", title: "Reading", status: "complete" })
	reply.step({
		id: "todo",
		title: "Updating the to-do list",
		status: "in_progress",
	})
	reply.todos(todos(0))
	reply.todos(todos(1))
	await Bun.sleep(1_100)
	reply.step({ id: "cron", title: "Writing the cron", status: "in_progress" })
	await reply.finish("All three are in.")
	// Batched: one message with the latest list.
	expect(postMessage).toHaveBeenCalledTimes(1)
	const list = postMessage.mock.calls[0]![0] as {
		blocks: { text?: { text: string } }[]
	}
	expect(list.blocks[0]!.text!.text).toBe(
		":heavy_check_mark: Design the table\n:arrows_counterclockwise: *Cron dispatcher*\n:white_circle: Backfill job",
	)
	expect(list.blocks[1]!.text!.text).toBe("Scheduled exports")
	// The steps above it went; they start again below it, every one, and the answer ends them.
	expect(remove).toHaveBeenCalledWith({ channel: "C_ONE", ts: "2.001" })
	expect(startStream).toHaveBeenCalledTimes(2)
	const ids = [
		...(startStream.mock.calls[1]![0].chunks ?? []),
		...appendStream.mock.calls
			.filter(([args]) => args.ts === "2.002")
			.flatMap(([args]) => args.chunks ?? []),
		...(stopStream.mock.calls.at(-1)![0].chunks ?? []),
	].flatMap(chunk => (chunk.type === "task_update" ? [chunk.id] : []))
	expect(new Set(ids)).toEqual(new Set(["read", "todo", "cron"]))
	const last = stopStream.mock.calls.at(-1)![0]
	expect(last.ts).toBe("2.002")
	expect(last.chunks).toContainEqual({
		type: "markdown_text",
		text: "All three are in.",
	})
})

test("the to-do list moves back to the bottom once the thread moves on", async () => {
	const { client, postMessage, update, remove } = streamingClient()
	let latest = "3.001"
	let bot: string | undefined
	;(client as unknown as { conversations: unknown }).conversations = {
		replies: mock(async () => ({
			messages: [{ ts: thread.threadTs }, { ts: latest, bot_id: bot }],
		})),
	}
	const thread = { ...target, threadTs: "0.601" }
	const reply = await openReply(client, thread)
	reply.todos(todos(0))
	await Bun.sleep(1_100)
	expect(postMessage).toHaveBeenCalledTimes(1)
	// Nothing new since: edited in place.
	reply.todos(todos(1))
	await Bun.sleep(1_100)
	expect(update).toHaveBeenCalledTimes(1)
	// Its own posts don't move it.
	bot = "B1"
	latest = "3.501"
	reply.todos(todos(1))
	await Bun.sleep(1_100)
	expect(update).toHaveBeenCalledTimes(2)
	// Someone replied: posted again below, the old one removed.
	bot = undefined
	latest = "4.001"
	reply.todos(todos(2))
	await reply.cancel()
	expect(update).toHaveBeenCalledTimes(2)
	expect(postMessage).toHaveBeenCalledTimes(3)
	expect(remove).toHaveBeenCalledWith({ channel: "C_ONE", ts: "3.001" })
	expect(postMessage.mock.calls[2]![0]).toMatchObject({
		markdown_text: "_Stopped._",
	})
})

test("the answer goes below parts posted while it worked", async () => {
	const { client, stopStream, postMessage } = streamingClient()
	;(client as unknown as { conversations: unknown }).conversations = {
		replies: mock(async () => ({
			messages: [{ ts: target.threadTs }, { ts: "9.001", bot_id: "B1" }],
		})),
	}
	const reply = await openReply(client, target)
	reply.step({ id: "post", title: "Posting the haiku", status: "complete" })
	await reply.finish("All three are up.")
	const chunks = stopStream.mock.calls[0]![0].chunks ?? []
	expect(chunks.some(chunk => chunk.type === "markdown_text")).toBe(false)
	expect(postMessage).toHaveBeenCalledWith({
		channel: target.channel,
		thread_ts: target.threadTs,
		markdown_text: "All three are up.",
	})
})

test("`slack todo` reaches the reply in progress for that person and thread", async () => {
	const { client, postMessage } = streamingClient()
	const thread = { ...target, threadTs: "7.001" }
	const reply = await openReply(client, thread)
	expect(showTodos({ ...thread, userId: "U_TWO" }, todos(0))).toBe(false)
	expect(showTodos(thread, todos(0))).toBe(true)
	await reply.finish("Done.")
	expect(postMessage).toHaveBeenCalledTimes(2)
	expect(showTodos(thread, todos(1))).toBe(false)
})

test("a later turn in the thread picks up its to-do list instead of adding another", async () => {
	const { client, postMessage, update, remove } = streamingClient()
	const thread = { ...target, threadTs: "5.001" }
	let person = false
	;(client as unknown as { conversations: unknown }).conversations = {
		replies: mock(async () => ({
			messages: person ? [{ ts: "9.001", user: "U_ONE" }] : [],
		})),
	}
	const first = await openReply(client, thread)
	first.todos(todos(0))
	await first.finish("")
	expect(postMessage).toHaveBeenCalledTimes(1)
	// Nobody posted since: the next turn edits it.
	const second = await openReply(client, thread)
	second.todos(todos(1))
	await second.finish("")
	expect(update).toHaveBeenCalledTimes(1)
	expect(postMessage).toHaveBeenCalledTimes(1)
	// They replied: the next turn's list goes below it, and the old one goes.
	person = true
	const third = await openReply(client, thread)
	third.todos(todos(2))
	await third.finish("")
	expect(postMessage).toHaveBeenCalledTimes(2)
	expect(remove).toHaveBeenCalledWith({ channel: "C_ONE", ts: "3.001" })
})
