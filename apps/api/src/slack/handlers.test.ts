import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import * as inflight from "../inflight"
import * as sessions from "../sessions"
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
