import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"

// Keep sign-ins created by these tests away from any deployment's tokens.
const dataDir = (await Bun.$`mktemp -d`.text()).trim()
const previousDataDir = Bun.env.DATA_DIR
Bun.env.DATA_DIR = dataDir
const { callerCredential, startBotApi } = await import("./bot-api")
const { oauthCallback } = await import("../slack/user-tokens")
if (previousDataDir === undefined) delete Bun.env.DATA_DIR
else Bun.env.DATA_DIR = previousDataDir

const caller = {
	teamId: "T00000001",
	userId: "U00000001",
	channel: "D00000001",
	threadTs: "1792100000.000001",
	scheduled: false,
}
const settings = {
	clientId: "test-client",
	clientSecret: "test-secret",
	redirectUrl: "https://dot.example.com/slack/oauth",
}
const posts: Record<string, unknown>[] = []
const opens: Record<string, unknown>[] = []
const client = {
	users: {
		info: async ({ user }: { user: string }) => ({
			user: { id: user, team_id: caller.teamId },
		}),
	},
	chat: {
		postMessage: async (args: Record<string, unknown>) => {
			posts.push(args)
			return { ok: true }
		},
	},
	conversations: {
		open: async (args: Record<string, unknown>) => {
			opens.push(args)
			return { channel: { id: "D00000002" } }
		},
	},
} as unknown as App["client"]
const api = startBotApi("127.0.0.1", {
	client,
	config: { slackSignIn: settings } as BotConfig,
})
const credential = callerCredential(caller)

beforeEach(() => {
	posts.length = 0
	opens.length = 0
})
afterAll(async () => {
	await Bun.$`rm -rf ${dataDir}`.quiet()
})

function dm(scheduled = false, text = "Please send a status update.") {
	return fetch(`${api.url}/slack/dm`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-dot-caller": callerCredential({ ...caller, scheduled }),
		},
		body: JSON.stringify({ to: "U00000002", text }),
	})
}

test("unconnected DM exits cleanly and sends only the sender a sign-in link", async () => {
	const command = Bun.spawn(
		[
			"python3",
			Bun.fileURLToPath(new URL("../../runtime/slack", import.meta.url)),
			"dm",
			"U00000002",
			"Please send a status update.",
		],
		{
			env: { ...Bun.env, DOT_API: api.url, DOT_CALLER: credential },
			stdout: "pipe",
			stderr: "pipe",
		},
	)
	const output = await new Response(command.stdout).text()
	expect(await command.exited).toBe(0)
	expect(output).toContain("Not sent yet:")
	expect(posts).toHaveLength(1)
	expect(posts[0]?.channel).toBe(caller.userId)
	expect(posts[0]?.text).toContain("https://slack.com/oauth/v2/authorize?")
	expect(opens).toHaveLength(0)
})

test("scheduled runs cannot start sign-in or send an unconnected DM", async () => {
	const response = await dm(true)
	expect(response.status).toBe(400)
	expect(posts).toHaveLength(0)
	expect(opens).toHaveLength(0)
})

test("invalid messages do not start sign-in", async () => {
	const response = await dm(false, " ")
	expect(response.status).toBe(400)
	expect(posts).toHaveLength(0)
	expect(opens).toHaveLength(0)
})

test("unsigned requests cannot send messages or sign-in links", async () => {
	const response = await fetch(`${api.url}/slack/dm`, { method: "POST" })
	expect(response.status).toBe(401)
	expect(posts).toHaveLength(0)
})

test("after sign-in, the DM uses the sender's token and their conversation", async () => {
	await dm()
	const link = /<(https:\/\/slack\.com\/oauth\/v2\/authorize\?[^|]+)\|/.exec(
		String(posts[0]?.text),
	)![1]!
	const state = new URL(link).searchParams.get("state")!
	const exchange = spyOn(globalThis, "fetch").mockResolvedValueOnce(
		Response.json({
			ok: true,
			team: { id: caller.teamId },
			authed_user: {
				id: caller.userId,
				access_token: "test-user-token",
				scope: "chat:write,im:write",
			},
		}),
	)
	try {
		const response = await oauthCallback(
			new Request(
				`${settings.redirectUrl}?state=${state}&code=test-code`,
			),
			settings,
			client,
		)
		expect(response.status).toBe(200)
	} finally {
		exchange.mockRestore()
	}
	posts.length = 0
	const response = await dm()
	expect(response.status).toBe(200)
	expect(opens).toEqual([{ token: "test-user-token", users: "U00000002" }])
	expect(posts).toEqual([
		{
			token: "test-user-token",
			channel: "D00000002",
			markdown_text: "Please send a status update.",
		},
	])
})
