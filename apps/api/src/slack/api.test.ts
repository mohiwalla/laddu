import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { callSlack, capabilities, methods, type SlackClient } from "./api"
import * as tokens from "./user-tokens"
import { transfer } from "./transfers"

const person = { teamId: "T00000001", userId: "U00000001" }
const apiCall = mock(
	async (_method: string, _args: Record<string, unknown>) => ({
		ok: true,
		messages: [{ text: "Found" }],
		response_metadata: { next_cursor: "next-page" },
	}),
)
const members = mock(async (_args: unknown) => ({
	members: [person.userId],
	response_metadata: {},
}))
const info = mock(async (_args: unknown) => ({
	channel: { id: "C00000001", is_private: true, is_member: true },
}))
const client = {
	apiCall,
	conversations: {
		info,
		members,
		list: async () => ({
			channels: [{ id: "C00000001", name: "general" }],
		}),
	},
} as unknown as SlackClient
let connection: ReturnType<typeof spyOn<typeof tokens, "connection">>
beforeEach(() => {
	connection = spyOn(tokens, "connection").mockResolvedValue(null)
	apiCall.mockClear()
	apiCall.mockImplementation(async () => ({
		ok: true,
		messages: [{ text: "Found" }],
		response_metadata: { next_cursor: "next-page" },
	}))
	members.mockImplementation(async () => ({
		members: [person.userId],
		response_metadata: {},
	}))
	info.mockClear()
})
afterEach(() => connection.mockRestore())

test("private bot access checks requester membership before reading or writing", async () => {
	members.mockResolvedValueOnce({
		members: ["U_OTHER"],
		response_metadata: {},
	})
	await expect(
		callSlack(client, person, {
			method: "conversations.history",
			args: { channel: "C00000001" },
		}),
	).rejects.toThrow("aren't a member")
	expect(apiCall).not.toHaveBeenCalled()
	members.mockResolvedValueOnce({
		members: ["U_OTHER"],
		response_metadata: {},
	})
	await expect(
		callSlack(client, person, {
			method: "chat.postMessage",
			args: { channel: "C00000001", text: "hello" },
			as: "dot",
		}),
	).rejects.toThrow("aren't a member")
	expect(apiCall).not.toHaveBeenCalled()
})

test("user searches use only the requester's host token and preserve pagination", async () => {
	connection.mockResolvedValue({
		token: "private-token",
		scopes: ["search:read"],
		connectedAt: "2026-10-16",
	})
	const result = await callSlack(client, person, {
		method: "search.messages",
		args: { query: "in:general decision", count: 20, page: 2 },
	})
	expect(apiCall).toHaveBeenCalledWith("search.messages", {
		token: "private-token",
		query: "in:general decision",
		count: 20,
		page: 2,
	})
	expect(result.result.response_metadata?.next_cursor).toBe("next-page")
	expect(JSON.stringify(result)).not.toContain("private-token")
	expect(info).not.toHaveBeenCalled()
})

test("tokens, other-user overrides, paid and arbitrary methods are rejected", async () => {
	for (const method of [
		"admin.users.remove",
		"lists.create",
		"views.open",
		"oauth.v2.access",
		"__proto__",
		"constructor",
	])
		await expect(callSlack(client, person, { method })).rejects.toThrow(
			"isn't exposed",
		)
	for (const args of [
		{ query: "x", token: "other-token" },
		{ query: "x", team_id: "other-team" },
	])
		await expect(
			callSlack(client, person, { method: "search.messages", args }),
		).rejects.toThrow("Unsupported argument")
	await expect(
		callSlack(client, person, {
			method: "users.profile.set",
			args: { profile: {}, user: "U_OTHER" },
		}),
	).rejects.toThrow("Unsupported argument")
	expect(apiCall).not.toHaveBeenCalled()
})

test("user-only operations never silently fall back to the bot", async () => {
	await expect(
		callSlack(client, person, {
			method: "search.messages",
			args: { query: "decision" },
		}),
	).rejects.toThrow("Connect your Slack")
	await expect(
		callSlack(client, person, {
			method: "conversations.create",
			args: { name: "new-channel" },
			as: "dot",
		}),
	).rejects.toThrow("requires --as user")
	expect(apiCall).not.toHaveBeenCalled()
})

test("channel names resolve exactly and bot calls cannot impersonate a person", async () => {
	await callSlack(client, person, {
		method: "chat.postMessage",
		args: { channel: "#general", text: "hello" },
		as: "dot",
	})
	expect(apiCall).toHaveBeenCalledWith("chat.postMessage", {
		channel: "C00000001",
		text: "hello",
	})
	await expect(
		callSlack(client, person, {
			method: "chat.postMessage",
			args: { channel: "C00000001", text: "x", username: "Boss" },
		}),
	).rejects.toThrow("Unsupported argument")
})

test("missing scopes produce reconnect guidance without discarding a valid token", async () => {
	connection.mockResolvedValue({
		token: "private-token",
		scopes: ["chat:write"],
		connectedAt: "2026-10-16",
	})
	apiCall.mockRejectedValueOnce({
		data: { error: "missing_scope", needed: "search:read" },
	})
	await expect(
		callSlack(client, person, {
			method: "search.messages",
			args: { query: "x" },
		}),
	).rejects.toThrow("Reconnect with slack connect")
})

test("capability discovery never returns tokens or enables standalone canvases", async () => {
	connection.mockResolvedValue({
		token: "private-token",
		scopes: ["chat:write"],
		connectedAt: "2026-10-16",
	})
	const catalog = await capabilities(client, person)
	expect(catalog.connected).toBe(true)
	expect(JSON.stringify(catalog)).not.toContain("private-token")
	expect(methods["canvases.create"]?.required).toContain("channel_id")
	expect(methods["lists.create"]).toBeUndefined()
})

test("file downloads reject a non-Slack host before sending credentials", async () => {
	connection.mockResolvedValue({
		token: "private-token",
		scopes: ["files:read"],
		connectedAt: "2026-10-16",
	})
	const fetcher = spyOn(globalThis, "fetch")
	try {
		const fileClient = {
			files: {
				info: async () => ({
					file: {
						url_private_download: "https://attacker.example/file",
						size: 10,
					},
				}),
			},
		} as unknown as SlackClient
		await expect(
			transfer(
				fileClient,
				person,
				new Request("http://local/slack/download?file=F123"),
				"download",
			),
		).rejects.toThrow("unexpected file host")
		expect(fetcher).not.toHaveBeenCalled()
	} finally {
		fetcher.mockRestore()
	}
})

test("file transfers carry bytes through Slack's external upload protocol", async () => {
	connection.mockResolvedValue({
		token: "private-token",
		scopes: ["files:read", "files:write"],
		connectedAt: "2026-10-16",
	})
	const bytes = new Uint8Array([0, 255, 1, 128])
	const complete = mock(async (_args: unknown) => ({
		ok: true,
		files: [{ id: "F123" }],
	}))
	const files = {
		getUploadURLExternal: mock(async (_args: unknown) => ({
			upload_url: "https://files.slack.com/upload/v1/abc",
			file_id: "F123",
		})),
		completeUploadExternal: complete,
		info: mock(async (_args: unknown) => ({
			file: {
				size: bytes.length,
				mimetype: "application/octet-stream",
				url_private_download: "https://files.slack.com/download/F123",
			},
		})),
	}
	const fetcher = spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(new Response("OK"))
		.mockResolvedValueOnce(new Response(bytes))
	try {
		const fileClient = { ...client, files } as unknown as SlackClient
		const response = await transfer(
			fileClient,
			person,
			new Request(
				"http://local/slack/upload?channel=C00000001&filename=test.bin&thread_ts=123.456",
				{ method: "PUT", body: bytes },
			),
			"upload",
		)
		expect(response.status).toBe(200)
		expect(complete).toHaveBeenCalledWith({
			token: "private-token",
			files: [{ id: "F123", title: "test.bin" }],
			channel_id: "C00000001",
			thread_ts: "123.456",
		})
		const downloaded = await transfer(
			fileClient,
			person,
			new Request("http://local/slack/download?file=F123"),
			"download",
		)
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)
	} finally {
		fetcher.mockRestore()
	}
})
