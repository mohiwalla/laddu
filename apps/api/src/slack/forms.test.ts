import { afterAll, expect, mock, test } from "bun:test"
import type { App } from "@slack/bolt"
import { SlackForms } from "./forms"
import type { SlackClient } from "./api"

const root = (await Bun.$`mktemp -d`.text()).trim()
afterAll(async () => {
	await Bun.$`rm -rf ${root}`.quiet()
})
const owner = { teamId: "T123", userId: "U_OWNER" }
const definition = {
	channel: "C123",
	title: "Report an issue",
	instruction: "Summarize this report.",
	fields: [
		{ name: "description", label: "Description", type: "text" },
		{
			name: "priority",
			label: "Priority",
			type: "select",
			options: ["High", "Low"],
		},
	],
}

test("a button opens a persisted form and duplicate submissions run once as the submitter", async () => {
	const postMessage = mock(async (_args: unknown) => ({
		ok: true,
		ts: "123.456",
	}))
	const views = { open: mock(async (_args: unknown) => ({ ok: true })) }
	const members = mock(async () => ({
		members: [owner.userId, "U_SUBMITTER"],
	}))
	const client = {
		chat: { postMessage },
		views,
		conversations: { info: async () => ({ channel: {} }), members },
	} as unknown as SlackClient
	const path = `${root}/forms.json`
	const forms = new SlackForms(client, path)
	const created = await forms.create(owner, definition)
	expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
		blocks: expect.any(Array),
		channel: "C123",
	})
	const callbacks: Record<string, (args: any) => Promise<void>> = {}
	const app = {
		action: (name: string, callback: (typeof callbacks)[string]) => {
			callbacks[name] = callback
		},
		view: (name: string, callback: (typeof callbacks)[string]) => {
			callbacks[name] = callback
		},
	} as unknown as App
	const submit = mock(
		(
			_person: unknown,
			_channel: string,
			_ts: string,
			_thread: string | undefined,
			_request: string,
		) => {},
	)
	// New instance proves the definition isn't held only in the creating process.
	new SlackForms(client, path).register(app, () => true, submit)
	await callbacks.laddu_form_open!({
		ack: mock(async () => {}),
		body: {
			team: { id: owner.teamId },
			user: { id: "U_SUBMITTER" },
			trigger_id: "trigger",
		},
		action: { value: created.id },
		client,
	})
	expect(views.open.mock.calls[0]?.[0]).toMatchObject({
		trigger_id: "trigger",
		view: {
			callback_id: "laddu_form_submit",
			private_metadata: created.id,
		},
	})
	const submission = {
		ack: mock(async () => {}),
		body: { team: { id: owner.teamId }, user: { id: "U_SUBMITTER" } },
		view: {
			id: "V123",
			private_metadata: created.id,
			state: {
				values: {
					description: { value: { value: "Something broke" } },
					priority: { value: { selected_option: { value: "High" } } },
				},
			},
		},
		client,
	}
	await callbacks.laddu_form_submit!(submission)
	await callbacks.laddu_form_submit!(submission)
	expect(submit).toHaveBeenCalledTimes(1)
	expect(submit.mock.calls[0]?.[0]).toEqual({
		teamId: owner.teamId,
		userId: "U_SUBMITTER",
	})
	expect(submit.mock.calls[0]?.[4]).toContain("untrusted data")
	expect(submit.mock.calls[0]?.[4]).toContain("Something broke")
	expect(postMessage).toHaveBeenCalledTimes(2)
	members.mockResolvedValue({ members: [owner.userId] })
	await callbacks.laddu_form_open!({
		ack: mock(async () => {}),
		body: {
			team: { id: owner.teamId },
			user: { id: "U_SUBMITTER" },
			trigger_id: "second",
		},
		action: { value: created.id },
		client,
	})
	expect(views.open).toHaveBeenCalledTimes(1)
})

test("invalid select fields fail before any Slack write", async () => {
	const postMessage = mock(async () => ({ ok: true }))
	const forms = new SlackForms(
		{ chat: { postMessage } } as unknown as SlackClient,
		`${root}/invalid.json`,
	)
	await expect(
		forms.create(owner, {
			...definition,
			fields: [
				{
					name: "priority",
					label: "Priority",
					type: "select",
					options: [],
				},
			],
		}),
	).rejects.toThrow("choices")
	expect(postMessage).not.toHaveBeenCalled()
})
