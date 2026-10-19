import { afterEach, expect, test } from "bun:test"
import type { App } from "@slack/bolt"
import { sessionKey } from "../sessions"
import {
	answerWithMessage,
	ask,
	clearQuestions,
	poll,
	QuestionError,
	registerQuestions,
	turnEnded,
} from "./questions"

const asker = { teamId: "T1", userId: "U1", channel: "C1", threadTs: "1.1" }
const key = sessionKey(asker.channel, asker.threadTs, asker.userId)

function fakeClient() {
	const posted: Record<string, unknown>[] = []
	const updated: Record<string, unknown>[] = []
	const client = {
		chat: {
			postMessage: async (args: Record<string, unknown>) => {
				posted.push(args)
				return { ts: `9.${posted.length}` }
			},
			update: async (args: Record<string, unknown>) => {
				updated.push(args)
				return {}
			},
		},
	} as unknown as App["client"]
	return { client, posted, updated }
}

afterEach(clearQuestions)

test("a choice question shows radio buttons in the thread", async () => {
	const { client, posted } = fakeClient()
	await ask(client, asker, { text: "Which?", choices: ["A", "B"] })
	expect(posted[0]!.thread_ts).toBe("1.1")
	expect(JSON.stringify(posted[0]!.blocks)).toContain('"radio_buttons"')
	expect(JSON.stringify(posted[0]!.blocks)).toContain("Something else")
})

test("bad choices are refused", async () => {
	const { client } = fakeClient()
	await expect(
		ask(client, asker, { text: "Which?", choices: ["A"] }),
	).rejects.toThrow(QuestionError)
	await expect(
		ask(client, asker, { text: "Which?", choices: ["A", "A"] }),
	).rejects.toThrow(QuestionError)
})

test("a reply in the thread answers the waiting question", async () => {
	const { client, updated } = fakeClient()
	const id = await ask(client, asker, { text: "Which?", choices: ["A", "B"] })
	const waiting = poll(id, asker)
	expect(answerWithMessage(client, key, "B please")).toBe("answered")
	expect(await waiting).toEqual({ status: "answered", answer: "B please" })
	expect(updated).toHaveLength(1)
	expect(answerWithMessage(client, key, "thanks")).toBeNull()
})

test("only the asker's session can read the answer", async () => {
	const { client } = fakeClient()
	const id = await ask(client, asker, { text: "Which?" })
	expect(await poll(id, { ...asker, userId: "U2" })).toEqual({
		status: "gone",
	})
})

test("STOP withdraws the question", async () => {
	const { client, updated } = fakeClient()
	const id = await ask(client, asker, { text: "Which?" })
	turnEnded(client, key, true)
	expect(await poll(id, asker)).toEqual({ status: "gone" })
	expect(JSON.stringify(updated[0])).toContain("No longer needed")
})

test("an answer after the turn ended starts a new turn", async () => {
	const { client } = fakeClient()
	const later: string[] = []
	registerQuestions(
		{ action: () => {}, view: () => {} } as unknown as App,
		(_question, request) => later.push(request),
	)
	const id = await ask(client, asker, { text: "Which?" })
	turnEnded(client, key, false)
	expect(await poll(id, asker)).toEqual({ status: "later" })
	// A typed reply then is an ordinary message (its own turn), and closes the question.
	expect(answerWithMessage(client, key, "A")).toBe("closed")
	expect(later).toEqual([])
})

test("a typed answer in the modal, after the turn ended, starts a new turn", async () => {
	const { client, updated } = fakeClient()
	const later: string[] = []
	const views: Record<string, (args: unknown) => Promise<void>> = {}
	registerQuestions(
		{
			action: () => {},
			view: (id: string, handler: (args: unknown) => Promise<void>) =>
				(views[id] = handler),
		} as unknown as App,
		(_question, request) => later.push(request),
	)
	const id = await ask(client, asker, { text: "Which?" })
	turnEnded(client, key, false)
	await views.dot_ask_submit!({
		ack: async () => {},
		body: { user: { id: "U1" } },
		client,
		view: {
			private_metadata: id,
			state: { values: { answer: { value: { value: "B" } } } },
		},
	})
	expect(later).toEqual(['You asked: "Which?" Their answer: B'])
	expect(JSON.stringify(updated[0])).toContain("B")
})

test("buttons answer in one click; many choices make a dropdown", async () => {
	const { client, posted } = fakeClient()
	await ask(client, asker, {
		text: "Ship it?",
		choices: ["Yes", "No"],
		buttons: true,
	})
	expect(JSON.stringify(posted[0]!.blocks)).toContain('"dot_ask_choice_1"')
	await ask(client, asker, {
		text: "Which city?",
		choices: Array.from({ length: 20 }, (_, i) => `City ${i}`),
	})
	expect(JSON.stringify(posted[1]!.blocks)).toContain('"static_select"')
	await expect(
		ask(client, asker, {
			text: "x",
			choices: ["a", "b", "c", "d", "e", "f"],
			buttons: true,
		}),
	).rejects.toThrow(QuestionError)
})

test("a form's answers come back as JSON by label", async () => {
	const { client, updated } = fakeClient()
	const views: Record<string, (args: unknown) => Promise<void>> = {}
	registerQuestions(
		{
			action: () => {},
			view: (id: string, handler: (args: unknown) => Promise<void>) =>
				(views[id] = handler),
		} as unknown as App,
		() => {},
	)
	const id = await ask(client, asker, {
		text: "Trip details",
		fields: [
			{ name: "city", label: "City", type: "text" },
			{ name: "who", label: "Who's coming", type: "users" },
		],
	})
	const waiting = poll(id, asker)
	await views.dot_ask_submit!({
		ack: async () => {},
		body: { user: { id: "U1" } },
		client,
		view: {
			private_metadata: id,
			state: {
				values: {
					city: { value: { value: "Pune" } },
					who: { value: { selected_users: ["U2", "U3"] } },
				},
			},
		},
	})
	expect(await waiting).toEqual({
		status: "answered",
		answer: JSON.stringify({ City: "Pune", "Who's coming": ["U2", "U3"] }),
	})
	expect(JSON.stringify(updated[0])).toContain("<@U2>, <@U3>")
})
