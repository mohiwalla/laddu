import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import * as inflight from "../inflight"
import * as sessions from "../sessions"
import * as agents from "../agent/agents"
import * as context from "./context"
import * as attachments from "./attachments"
import * as replies from "./reply"
import * as learning from "../agent/learning"
import { registerHandlers } from "./handlers"

const botUserId = "U_DOT"
const userId = "U_PERSON"
const channel = "C_CHANNEL"
let sequence = 0
let started: ReturnType<typeof spyOn<typeof inflight, "markStarted">>
let serialized: ReturnType<typeof spyOn<typeof sessions, "serialize">>

beforeEach(() => {
	// Observe accepted turns without writing deployment state or starting Codex.
	started = spyOn(inflight, "markStarted").mockResolvedValue(undefined)
	serialized = spyOn(sessions, "serialize").mockResolvedValue(undefined)
})
afterEach(() => {
	started.mockRestore()
	serialized.mockRestore()
})

type Message = {
	ts?: string
	user?: string
	bot_id?: string
	bot_profile?: { id: string }
	subtype?: string
	thread_ts?: string
}

async function reactTo(message: Message | null, lookupFails = false) {
	const ts = `1792100000.${String(++sequence).padStart(6, "0")}`
	let onReaction!: (args: unknown) => Promise<void>
	const app = {
		event: (name: string, handler: typeof onReaction) => {
			if (name === "reaction_added") onReaction = handler
		},
		action: () => {},
		message: () => {},
		command: () => {},
		shortcut: () => {},
		view: () => {},
	} as unknown as App
	registerHandlers(
		app,
		{ allowedUsers: "*", triggerEmoji: "robot_face" } as BotConfig,
		botUserId,
	)
	const replies = mock(async () => {
		if (lookupFails) throw new Error("Slack unavailable")
		return { messages: message ? [{ ts, ...message }] : [] }
	})
	await onReaction({
		event: {
			reaction: "robot_face",
			user: userId,
			item: { type: "message", channel, ts },
		},
		client: { conversations: { replies } },
		context: { teamId: "T_TEAM" },
	})
	return ts
}

test.each([
	["dot's own reply", { user: botUserId }],
	["another bot's message", { user: "U_OTHER_BOT", bot_id: "B_OTHER" }],
	["a bot profile", { user: "U_OTHER_BOT", bot_profile: { id: "B_OTHER" } }],
	["a legacy bot message", { user: "U_OTHER_BOT", subtype: "bot_message" }],
	["a message without a user", {}],
] satisfies [string, Message][])(
	"robot reactions ignore %s",
	async (_, message) => {
		await reactTo(message)
		expect(started).not.toHaveBeenCalled()
		expect(serialized).not.toHaveBeenCalled()
	},
)

test("robot reactions ignore messages that cannot be retrieved", async () => {
	await reactTo(null)
	await reactTo(null, true)
	expect(started).not.toHaveBeenCalled()
	expect(serialized).not.toHaveBeenCalled()
})

test.each([undefined, "file_share", "thread_broadcast"])(
	"robot reactions still trigger user messages with subtype %s",
	async subtype => {
		const threadTs = "1792100000.000000"
		const ts = await reactTo({ user: userId, subtype, thread_ts: threadTs })
		expect(started).toHaveBeenCalledWith(
			`${channel}:${ts}:reaction:${userId}`,
			expect.objectContaining({
				channel,
				ts,
				threadTs,
				userId,
				via: "reaction",
			}),
		)
		expect(serialized).toHaveBeenCalledWith(
			`${channel}:${threadTs}:${userId}`,
			expect.any(Function),
		)
	},
)

test.each(["success", "failure", "stop"] as const)(
	"agent DM lifecycle: %s clears working status and persists only successful work",
	async outcome => {
		serialized.mockImplementation(async (_key, task) => task())
		const extraSpies: { mockRestore(): void }[] = []
		let finished!: () => void
		const done = new Promise<void>(resolve => {
			finished = resolve
		})
		let running!: () => void
		const ready = new Promise<void>(resolve => {
			running = resolve
		})
		const reply = {
			ts: "3.001",
			streaming: true,
			step: mock(() => {}),
			finish: mock(async () => {}),
			fail: mock(async () => {}),
			cancel: mock(async () => {}),
			discard: mock(async () => {}),
		}
		const save = spyOn(sessions, "saveSession").mockResolvedValue(undefined)
		const run = spyOn(agents, "runTurn").mockImplementation(
			async ({ signal }) => {
				running()
				if (outcome === "stop") {
					await new Promise((_, reject) =>
						signal!.addEventListener(
							"abort",
							() => reject(signal!.reason),
							{ once: true },
						),
					)
				}
				if (outcome === "failure") throw new Error("Example failure")
				return {
					threadId: "codex-thread",
					text: "Done",
					files: [],
					skipped: [],
				}
			},
		)
		extraSpies.push(
			save,
			run,
			spyOn(sessions, "getSession").mockResolvedValue(undefined),
			spyOn(inflight, "markReply").mockResolvedValue(undefined),
			spyOn(inflight, "markDone").mockImplementation(async () => {
				finished()
			}),
			spyOn(replies, "openReply").mockResolvedValue(reply),
			spyOn(context, "buildTurnInput").mockResolvedValue({
				text: "Do a task",
				transcript: "Do a task",
				attachments: [],
				linked: [],
				place: "DM",
			}),
			spyOn(context, "userTimezone").mockResolvedValue("Asia/Kolkata"),
			spyOn(attachments, "downloadAttachments").mockResolvedValue([]),
			spyOn(attachments, "uploadFiles").mockResolvedValue(undefined),
			spyOn(learning, "afterTurn").mockResolvedValue(undefined),
		)
		try {
			let onMessage!: (args: unknown) => Promise<void>
			let onStop!: (args: unknown) => Promise<void>
			const apiCall = mock(async () => ({ ok: true }))
			const client = {
				apiCall,
				reactions: { add: mock(async () => ({})) },
			}
			const app = {
				event: (name: string, handler: typeof onStop) => {
					if (name === "agent_session_stopped") onStop = handler
				},
				message: (handler: typeof onMessage) => {
					onMessage = handler
				},
				action: () => {},
				command: () => {},
				shortcut: () => {},
				view: () => {},
			} as unknown as App
			registerHandlers(
				app,
				{
					allowedUsers: new Set([userId]),
					codexUsers: "*",
					agent: "codex",
				} as BotConfig,
				botUserId,
			)
			const ts = `1792200000.${String(++sequence).padStart(6, "0")}`
			await onMessage({
				message: {
					channel: "D_AGENT",
					channel_type: "im",
					user: userId,
					ts,
				},
				client,
				context: { teamId: "T_TEAM" },
			})
			await ready
			if (outcome === "stop") {
				const signal = run.mock.calls[0]![0].signal!
				await onStop({
					event: {
						channel: "D_AGENT",
						thread_ts: ts,
						user: "U_OTHER",
					},
				})
				expect(signal.aborted).toBe(false)
				await onStop({
					event: { channel: "D_AGENT", thread_ts: ts, user: userId },
				})
				expect(signal.aborted).toBe(true)
			}
			await done
			expect(apiCall).toHaveBeenLastCalledWith(
				"agents.sessions.setStatus",
				{
					channel_id: "D_AGENT",
					thread_ts: ts,
					status: "active",
				},
			)
			expect(run).toHaveBeenCalledTimes(1)
			expect(save).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0)
			expect(reply.finish).toHaveBeenCalledTimes(
				outcome === "success" ? 1 : 0,
			)
			expect(reply.fail).toHaveBeenCalledTimes(
				outcome === "failure" ? 1 : 0,
			)
			expect(reply.cancel).toHaveBeenCalledTimes(
				outcome === "stop" ? 1 : 0,
			)
		} finally {
			for (const spy of extraSpies) spy.mockRestore()
		}
	},
)

async function dm(text: string) {
	const ts = `1792300000.${String(++sequence).padStart(6, "0")}`
	let onMessage!: (args: unknown) => Promise<void>
	const app = {
		event: () => {},
		action: () => {},
		message: (handler: typeof onMessage) => {
			onMessage = handler
		},
		command: () => {},
		shortcut: () => {},
		view: () => {},
	} as unknown as App
	registerHandlers(app, { allowedUsers: "*" } as BotConfig, botUserId)
	const postMessage = mock(async () => ({ ok: true }))
	await onMessage({
		message: {
			channel: "D_PERSON",
			channel_type: "im",
			ts,
			thread_ts: "1792300000.000000",
			user: userId,
			text,
		},
		client: { chat: { postMessage } },
		context: { teamId: "T_TEAM" },
	})
	await Bun.sleep(0)
	return postMessage
}

test("STOP with nothing running says so, and starts no turn", async () => {
	const postMessage = await dm("STOP")
	expect(started).not.toHaveBeenCalled()
	expect(serialized).not.toHaveBeenCalled()
	expect(postMessage).toHaveBeenCalledWith(
		expect.objectContaining({ markdown_text: "_Nothing to stop._" }),
	)
})

test.each(["stop", "Stop", "STOP please", "please STOP"])(
	"%s is an ordinary message",
	async text => {
		await dm(text)
		expect(serialized).toHaveBeenCalled()
	},
)
