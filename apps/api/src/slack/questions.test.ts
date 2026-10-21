import { afterEach, expect, test } from "bun:test"
import type { App } from "@slack/bolt"
import { sessionKey } from "../sessions"
import {
	ask,
	clearQuestions,
	closeWithMessage,
	QuestionError,
	registerQuestions,
	withdrawQuestions,
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

/** Registers the handlers; returns the answers sent on to dot and the modal submit handler. */
function register() {
	const answers: string[] = []
	const views: Record<string, (args: unknown) => Promise<void>> = {}
	registerQuestions(
		{
			action: () => {},
			view: (id: string, handler: (args: unknown) => Promise<void>) =>
				(views[id] = handler),
		} as unknown as App,
		(_question, request) => answers.push(request),
	)
	return { answers, submit: (args: unknown) => views.dot_ask_submit!(args) }
}

test("a reply typed in the thread closes the question and is their next message", async () => {
	const { client, updated } = fakeClient()
	const { answers } = register()
	await ask(client, asker, { text: "Which?", choices: ["A", "B"] })
	expect(closeWithMessage(client, key)).toBe(true)
	expect(JSON.stringify(updated[0])).toContain("Answered in the thread")
	expect(answers).toEqual([])
	expect(closeWithMessage(client, key)).toBe(false)
})

test("STOP withdraws the question", async () => {
	const { client, updated } = fakeClient()
	await ask(client, asker, { text: "Which?" })
	withdrawQuestions(client, key)
	expect(JSON.stringify(updated[0])).toContain("No longer needed")
	expect(closeWithMessage(client, key)).toBe(false)
})

test("a typed answer in the modal goes to dot", async () => {
	const { client, updated } = fakeClient()
	const { answers, submit } = register()
	const id = await ask(client, asker, { text: "Which?" })
	await submit({
		ack: async () => {},
		body: { user: { id: "U1" } },
		client,
		view: {
			private_metadata: id,
			state: { values: { answer: { value: { value: "B" } } } },
		},
	})
	expect(answers).toEqual(['You asked: "Which?" Their answer: B'])
	expect(JSON.stringify(updated[0])).toContain("B")
})

test("only the asker can answer in the modal", async () => {
	const { client } = fakeClient()
	const { answers, submit } = register()
	const id = await ask(client, asker, { text: "Which?" })
	await submit({
		ack: async () => {},
		body: { user: { id: "U2" } },
		client,
		view: {
			private_metadata: id,
			state: { values: { answer: { value: { value: "B" } } } },
		},
	})
	expect(answers).toEqual([])
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
	const { answers, submit } = register()
	const id = await ask(client, asker, {
		text: "Trip details",
		fields: [
			{ name: "city", label: "City", type: "text" },
			{ name: "who", label: "Who's coming", type: "users" },
		],
	})
	await submit({
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
	expect(answers).toEqual([
		`You asked: "Trip details" Their answer: ${JSON.stringify({ City: "Pune", "Who's coming": ["U2", "U3"] })}`,
	])
	expect(JSON.stringify(updated[0])).toContain("<@U2>, <@U3>")
})
