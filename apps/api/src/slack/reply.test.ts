import { expect, mock, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import { openReply } from "./reply"

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
		expect.objectContaining({ title: expect.stringMatching(/^Done · 3 steps/) }),
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
