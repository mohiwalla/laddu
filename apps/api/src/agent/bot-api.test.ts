import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"

// Keep sign-ins created by these tests away from any deployment's tokens.
const dataDir = (await Bun.$`mktemp -d`.text()).trim()
const previousDataDir = Bun.env.DATA_DIR
Bun.env.DATA_DIR = dataDir
const { callerCredential, startBotApi } = await import("./bot-api")
const { oauthCallback } = await import("../slack/user-tokens")
const microsoft = await import("../integrations/microsoft")
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
const slackCalls: { method: string; args: Record<string, unknown> }[] = []
const client = {
	apiCall: async (method: string, args: Record<string, unknown>) => {
		slackCalls.push({ method, args })
		return {
			ok: true,
			ts: "1792100000.000010",
			response_metadata: { next_cursor: "next" },
		}
	},
	users: {
		info: async ({ user }: { user: string }) => ({
			user: {
				id: user,
				team_id: caller.teamId,
				real_name: "Test Person",
				profile: { email: "person@example.com" },
			},
		}),
	},
	chat: {
		postMessage: async (args: Record<string, unknown>) => {
			posts.push(args)
			return { ok: true }
		},
	},
	conversations: {
		info: async () => ({
			channel: { id: caller.channel, is_member: true },
		}),
		members: async () => ({ members: [caller.userId] }),
		open: async (args: Record<string, unknown>) => {
			opens.push(args)
			return { channel: { id: "D00000002" } }
		},
	},
} as unknown as App["client"]
const { SlackAutomations } = await import("../slack/automations")
const { SlackForms } = await import("../slack/forms")
const slackFeatures = {
	automations: new SlackAutomations(client, "U_DOT", {
		file: `${dataDir}/rules.json`,
	}),
	forms: new SlackForms(client, `${dataDir}/forms.json`),
}
const api = startBotApi("127.0.0.1", {
	client,
	slack: slackFeatures,
	config: {
		slackSignIn: settings,
		microsoft: {
			clientId: "test-ms-client",
			tenant: "organizations",
			graphScopes: [],
		},
		codeCommit: {
			profiles: { [caller.userId]: "test-aws" },
			cli: `${dataDir}/aws`,
		},
	} as unknown as BotConfig,
})
const credential = callerCredential(caller)

beforeEach(() => {
	posts.length = 0
	opens.length = 0
	slackCalls.length = 0
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

test("expanded Slack CLI commands reach signed API tools and persisted rules", async () => {
	async function command(args: string[], signed = credential) {
		const child = Bun.spawn(
			[
				"python3",
				Bun.fileURLToPath(
					new URL("../../runtime/slack", import.meta.url),
				),
				...args,
			],
			{
				env: { ...Bun.env, DOT_API: api.url, DOT_CALLER: signed },
				stdout: "pipe",
				stderr: "pipe",
			},
		)
		const [out, err, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		return { out, err, exit }
	}
	expect((await command(["capabilities"])).out).toContain(
		'"planTarget":"free"',
	)
	const sent = await command([
		"send",
		"C00000001",
		"Requested message",
		"--as",
		"dot",
	])
	expect(sent.exit, sent.err).toBe(0)
	expect(slackCalls).toEqual([
		{
			method: "chat.postMessage",
			args: { channel: "C00000001", text: "Requested message" },
		},
	])
	const denied = await command([
		"api",
		"search.messages",
		'{"query":"x","token":"override"}',
	])
	expect(denied.exit).toBe(1)
	expect(denied.err).toContain("Unsupported argument token")
	const forged = await command(
		["send", "C00000001", "Not authorized"],
		credential.replace(caller.userId, "U00000099"),
	)
	expect(forged.exit).toBe(1)
	expect(slackCalls).toHaveLength(1)
	const welcome = await command([
		"automate",
		"welcome",
		"C00000001",
		"Welcome <@{user}>!",
	])
	expect(welcome.exit, welcome.err).toBe(0)
	expect((await command(["automate", "list"])).out).toContain(
		"member_joined_channel",
	)
	const background = await command(
		["automate", "welcome", "C00000002", "Welcome!"],
		callerCredential({ ...caller, scheduled: true }),
	)
	expect(background.exit).toBe(1)
	expect(background.err).toContain("Background tasks")
})

test("coding tasks share cached repos, isolate worktrees and update PRs in both providers", async () => {
	const root = `${dataDir}/git`
	const bare = `${root}/test/Project/_git/Repo`
	const seed = `${dataDir}/seed`
	const nativeFetch = globalThis.fetch
	const token = spyOn(microsoft, "accessToken").mockResolvedValue(
		"test-ms-token",
	)
	const account = spyOn(microsoft, "account").mockResolvedValue({
		name: "Test Person",
		email: "person@example.com",
		refreshToken: "unused",
		tokens: {},
		devops: { organizations: ["test"], defaultOrganization: "test" },
	})
	const pullRequests: {
		pullRequestId: number
		status: string
		[key: string]: unknown
	}[] = []
	let upstreamPushes = 0
	const upstreamHeaders: Headers[] = []
	const awsHeaders: Headers[] = []
	const upstream = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request =
					input instanceof Request
						? new Request(input, init)
						: new Request(String(input), init)
				const url = new URL(request.url)
				const isAws =
					url.hostname === "git-codecommit.us-east-2.amazonaws.com"
				if (url.hostname !== "dev.azure.com" && !isAws)
					return nativeFetch(input, init)
				;(isAws ? awsHeaders : upstreamHeaders).push(request.headers)
				if (url.pathname.includes("/_apis/git/repositories/")) {
					if (/\/pullrequests(\/42)?$/.test(url.pathname)) {
						if (request.method === "POST") {
							const body = (await request.json()) as Record<
								string,
								unknown
							>
							pullRequests.push({
								...body,
								pullRequestId: 42,
								status: "active",
							})
							return Response.json(
								{ pullRequestId: 42 },
								{ status: 201 },
							)
						}
						if (request.method === "PATCH") {
							Object.assign(
								pullRequests[0]!,
								await request.json(),
							)
							return Response.json(pullRequests[0])
						}
						return Response.json({ value: pullRequests })
					}
					return Response.json({
						id: "repo-id",
						defaultBranch: "refs/heads/main",
					})
				}
				if (url.pathname.includes("/_git/Redirect/"))
					return new Response(null, {
						status: 302,
						headers: { location: "https://other.example.com" },
					})
				if (
					request.method === "POST" &&
					url.pathname.endsWith("git-receive-pack")
				)
					upstreamPushes++
				// A real Git smart HTTP server, without any external repo or network writes.
				const child = Bun.spawn(["git", "http-backend"], {
					env: {
						...Bun.env,
						GIT_PROJECT_ROOT: root,
						GIT_HTTP_EXPORT_ALL: "1",
						PATH_INFO: decodeURIComponent(url.pathname),
						QUERY_STRING: url.search.slice(1),
						REQUEST_METHOD: request.method,
						CONTENT_TYPE: request.headers.get("content-type") ?? "",
						HTTP_CONTENT_ENCODING:
							request.headers.get("content-encoding") ?? "",
						GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
					},
					stdin: new Uint8Array(await request.arrayBuffer()),
					stdout: "pipe",
					stderr: "pipe",
				})
				const bytes = new Uint8Array(
					await new Response(child.stdout).arrayBuffer(),
				)
				const error = await new Response(child.stderr).text()
				expect(await child.exited, error).toBe(0)
				let split = 0
				while (
					split < bytes.length &&
					!(
						bytes[split] === 13 &&
						bytes[split + 1] === 10 &&
						bytes[split + 2] === 13 &&
						bytes[split + 3] === 10
					)
				)
					split++
				const headers = new Headers()
				for (const line of new TextDecoder()
					.decode(bytes.subarray(0, split))
					.split("\r\n")) {
					const at = line.indexOf(":")
					if (at !== -1)
						headers.set(
							line.slice(0, at),
							line.slice(at + 1).trim(),
						)
				}
				return new Response(bytes.subarray(split + 4), {
					headers,
					status: Number(headers.get("status")?.split(" ")[0] ?? 200),
				})
			},
			{ preconnect: nativeFetch.preconnect },
		),
	)
	const ado = Bun.fileURLToPath(new URL("../../runtime/ado", import.meta.url))
	const env = {
		...Bun.env,
		DOT_API: api.url,
		DOT_CALLER: credential,
		DOT_CODE_DIR: `${dataDir}/code`,
	}
	async function command(args: string[], cwd?: string, extraEnv = env) {
		const child = Bun.spawn(args, {
			cwd,
			env: extraEnv,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [out, err, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		return { out, err, exit }
	}
	async function checked(args: string[], cwd?: string) {
		const result = await command(args, cwd)
		expect(result.exit, result.err || result.out).toBe(0)
		return result.out.trim()
	}
	try {
		await checked(["git", "init", "--bare", "--initial-branch=main", bare])
		await checked(["git", "-C", bare, "config", "http.receivepack", "true"])
		await checked(["git", "init", "--initial-branch=main", seed])
		await checked(["git", "config", "user.name", "Test Person"], seed)
		await checked(
			["git", "config", "user.email", "person@example.com"],
			seed,
		)
		await Bun.write(`${seed}/README.md`, "Original\n")
		await Bun.write(`${seed}/remove.txt`, "Remove this\n")
		await checked(["git", "add", "."], seed)
		await checked(["git", "commit", "-m", "Initial"], seed)
		await checked(["git", "push", bare, "main"], seed)
		const main = await checked(["git", "rev-parse", "main"], seed)
		const [clone, second] = await Promise.all([
			checked([
				"python3",
				ado,
				"checkout",
				"https://test@dev.azure.com/test/Project/_git/Repo",
			]),
			checked([
				"python3",
				ado,
				"checkout",
				"https://dev.azure.com/test/Project/_git/Repo",
			]),
		])
		const path = /^Checkout: (.+)$/m.exec(clone)![1]!
		const secondPath = /^Checkout: (.+)$/m.exec(second)![1]!
		expect(second).not.toContain(`Checkout: ${path}\n`)
		expect(await Bun.file(`${path}/README.md`).text()).toBe("Original\n")
		const commonDir = await checked(
			["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
			path,
		)
		expect(
			await checked(
				[
					"git",
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				secondPath,
			),
		).toBe(commonDir)
		expect((await Bun.file(`${path}/.git`).stat()).isFile()).toBe(true)
		const config = await Bun.file(`${commonDir}/config`).text()
		expect(config).toContain("https://dev.azure.com/test/Project/_git/Repo")
		expect(config).not.toContain(credential)
		expect(config).not.toContain("test-ms-token")
		expect(await checked(["git", "config", "user.email"], path)).toBe(
			"person@example.com",
		)
		await checked(
			[
				"git",
				"config",
				"--worktree",
				"user.email",
				"second-task@example.com",
			],
			secondPath,
		)
		expect(await checked(["git", "config", "user.email"], path)).toBe(
			"person@example.com",
		)
		const bodyFile = `${dataDir}/pr.md`
		await Bun.write(
			bodyFile,
			"Fix the example.\n\nValidation: fixture checks passed.",
		)
		const publish = [
			"python3",
			ado,
			"pr",
			"--title",
			"Fix example",
			"--body-file",
			bodyFile,
		]
		expect((await command(publish, path)).err).toContain(
			"no committed changes",
		)
		await Bun.write(`${path}/README.md`, "Fixed\n")
		await checked(["git", "mv", "remove.txt", "renamed ü.txt"], path)
		const binary = new Uint8Array([0, 255, 1, 128, 17])
		await Bun.write(`${path}/binary.dat`, binary)
		expect((await command(publish, path)).err).toContain("must be clean")
		await checked(["git", "add", "."], path)
		expect(
			await checked(
				["git", "diff", "--cached", "--name-only"],
				secondPath,
			),
		).toBe("")
		expect(await Bun.file(`${secondPath}/README.md`).text()).toBe(
			"Original\n",
		)
		await checked(["git", "commit", "-m", "Fix example"], path)
		expect((await command(publish, secondPath)).err).toContain(
			"no committed changes",
		)
		const result = await checked(publish, path)
		expect(result).toContain(
			"https://dev.azure.com/test/Project/_git/repo-id/pullrequest/42",
		)
		expect(pullRequests).toHaveLength(1)
		expect(pullRequests[0]).toMatchObject({
			isDraft: true,
			targetRefName: "refs/heads/main",
			title: "Fix example",
			description:
				"Fix the example.\n\nValidation: fixture checks passed.",
		})
		const branch = await checked(["git", "branch", "--show-current"], path)
		expect(pullRequests[0]?.sourceRefName).toBe(`refs/heads/${branch}`)
		expect(await checked(["git", "-C", bare, "rev-parse", branch])).toBe(
			await checked(["git", "rev-parse", "HEAD"], path),
		)
		expect(
			await checked([
				"git",
				"-C",
				bare,
				"show",
				`${branch}:renamed ü.txt`,
			]),
		).toBe("Remove this")
		const blob = Bun.spawn(
			["git", "-C", bare, "show", `${branch}:binary.dat`],
			{ stdout: "pipe" },
		)
		expect(
			new Uint8Array(await new Response(blob.stdout).arrayBuffer()),
		).toEqual(binary)
		expect(await blob.exited).toBe(0)
		await Bun.write(`${path}/README.md`, "Follow-up fix\n")
		await checked(["git", "add", "README.md"], path)
		await checked(["git", "commit", "-m", "Follow-up fix"], path)
		await Bun.write(
			bodyFile,
			"Follow-up fix.\n\nValidation: updated checks passed.",
		)
		expect(await checked(publish, path)).toContain("Updated PR:")
		expect(pullRequests).toHaveLength(1)
		expect(pullRequests[0]?.description).toBe(
			"Follow-up fix.\n\nValidation: updated checks passed.",
		)
		expect(await checked(["git", "-C", bare, "rev-parse", branch])).toBe(
			await checked(["git", "rev-parse", "HEAD"], path),
		)

		const gitEnv = {
			...env,
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: `url.${api.url}/ado/git/test/Project/_git/Repo.insteadOf`,
			GIT_CONFIG_VALUE_0: "https://dev.azure.com/test/Project/_git/Repo",
			GIT_CONFIG_KEY_1: `http.${api.url}/ado/git/test/Project/_git/Repo.extraHeader`,
			GIT_CONFIG_VALUE_1: `x-dot-caller: ${credential}`,
		}
		const pushesBefore = upstreamPushes
		for (const refspec of [
			"HEAD:main",
			`:refs/heads/${branch}`,
			"HEAD:refs/heads/dot/another-user/task",
		])
			expect(
				(
					await command(
						["git", "push", "origin", refspec],
						path,
						gitEnv,
					)
				).exit,
			).not.toBe(0)
		expect(upstreamPushes).toBe(pushesBefore)
		expect(await checked(["git", "-C", bare, "rev-parse", "main"])).toBe(
			main,
		)
		expect(
			upstreamHeaders.every(
				headers =>
					headers.get("authorization") === "Bearer test-ms-token",
			),
		).toBe(true)
		expect(
			upstreamHeaders.every(headers => !headers.has("x-dot-caller")),
		).toBe(true)
		const redirects = await fetch(
			`${api.url}/ado/git/test/Project/_git/Redirect/info/refs?service=git-upload-pack`,
			{ headers: { "x-dot-caller": credential } },
		)
		expect(redirects.status).toBe(502)
		const unsigned = await fetch(
			`${api.url}/ado/git/test/Project/_git/Repo/info/refs?service=git-upload-pack`,
		)
		expect(unsigned.status).toBe(401)
		const post = (body: string) =>
			fetch(
				`${api.url}/ado/git/test/Project/_git/Repo/git-receive-pack`,
				{
					method: "POST",
					headers: {
						"x-dot-caller": credential,
						"content-type":
							"application/x-git-receive-pack-request",
					},
					body,
				},
			)
		const packet = (line: string) =>
			`${(line.length + 4).toString(16).padStart(4, "0")}${line}`
		const hash = "1".repeat(40)
		const beforeRefusal = upstreamPushes
		expect(
			(
				await post(
					`${packet(`${hash} ${hash} refs/heads/${branch}\0report-status\n`)}${packet(`${hash} ${hash} refs/heads/main\n`)}0000PACK`,
				)
			).status,
		).toBe(403)
		expect((await post("zzzz0000PACK")).status).toBe(403)
		expect(upstreamPushes).toBe(beforeRefusal)

		// Each new task fetches the latest base, including a branch absent from the initial clone.
		await Bun.write(`${seed}/README.md`, "Updated base\n")
		await checked(["git", "add", "README.md"], seed)
		await checked(["git", "commit", "-m", "Update base"], seed)
		await checked(["git", "push", bare, "main", "HEAD:release"], seed)
		const fresh = /^Checkout: (.+)$/m.exec(
			await checked([
				"python3",
				ado,
				"checkout",
				"https://dev.azure.com/test/Project/_git/Repo",
			]),
		)![1]!
		expect(await Bun.file(`${fresh}/README.md`).text()).toBe(
			"Updated base\n",
		)
		const release = /^Checkout: (.+)$/m.exec(
			await checked([
				"python3",
				ado,
				"checkout",
				"https://dev.azure.com/test/Project/_git/Repo",
				"--base",
				"release",
			]),
		)![1]!
		expect(
			await checked(
				[
					"git",
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				release,
			),
		).toBe(commonDir)
		expect(await Bun.file(`${release}/README.md`).text()).toBe(
			"Updated base\n",
		)
		expect(await checked(["git", "rev-parse", "HEAD"], secondPath)).toBe(
			main,
		)
		expect(await Bun.file(`${secondPath}/README.md`).text()).toBe(
			"Original\n",
		)
		const anotherUser = await command(
			[
				"python3",
				ado,
				"checkout",
				"https://dev.azure.com/test/Project/_git/Repo",
			],
			undefined,
			{
				...env,
				DOT_CALLER: callerCredential({
					...caller,
					userId: "U00000099",
				}),
			},
		)
		expect(anotherUser.exit, anotherUser.err).toBe(0)
		const otherPath = /^Checkout: (.+)$/m.exec(anotherUser.out)![1]!
		expect(
			await checked(
				[
					"git",
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				otherPath,
			),
		).not.toBe(commonDir)
		const legacy = `${dataDir}/legacy`
		await checked(["git", "clone", "--branch", "main", bare, legacy])
		const legacyBranch = `dot/${caller.userId.toLowerCase()}/legacy`
		await checked(["git", "checkout", "-b", legacyBranch], legacy)
		const taskFile = await checked(
			[
				"git",
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"dot-task.json",
			],
			path,
		)
		const legacyTask = {
			...((await Bun.file(taskFile).json()) as object),
			branch: legacyBranch,
			start: await checked(["git", "rev-parse", "HEAD"], legacy),
		}
		await Bun.write(
			`${legacy}/.git/dot-task.json`,
			JSON.stringify(legacyTask),
		)
		expect((await command(publish, legacy)).err).toContain(
			"no committed changes",
		)
		token.mockResolvedValueOnce(null)
		const disconnected = await fetch(
			`${api.url}/ado/git/test/Project/_git/Repo/info/refs?service=git-upload-pack`,
			{ headers: { "x-dot-caller": credential } },
		)
		expect(disconnected.status).toBe(409)
		pullRequests[0]!.status = "completed"
		expect((await command(publish, path)).err).toContain("closed PR")
		expect(upstreamPushes).toBe(beforeRefusal)

		// Exercise the CodeCommit CLI adapter and the same real Git transport end to end.
		await Bun.$`mkdir -p ${`${root}/v1/repos`}`.quiet()
		await Bun.$`ln -s ${bare} ${`${root}/v1/repos/Repo`}`.quiet()
		const awsState = `${dataDir}/aws-state.json`
		await Bun.write(
			`${dataDir}/aws`,
			`#!/usr/bin/env bun
const args = Bun.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
const action = args[args.indexOf("codecommit") + 1]
if (option("--profile") !== "test-aws") throw new Error("Wrong AWS profile")
const file = Bun.file(${JSON.stringify(awsState)})
let pr = await file.exists() ? await file.json() : null
if (action === "credential-helper") console.log("username=test-aws-user\\npassword=test-aws-signature")
else if (action === "get-repository") console.log(JSON.stringify({repositoryMetadata:{repositoryId:"aws-repo",defaultBranch:"main"}}))
else if (action === "list-pull-requests") console.log(JSON.stringify({pullRequestIds:pr ? [pr.pullRequestId] : []}))
else if (action === "get-pull-request") console.log(JSON.stringify({pullRequest:pr}))
else if (action === "create-pull-request") {
  const target = JSON.parse(option("--targets"))[0]
  pr = {pullRequestId:"43",pullRequestStatus:"OPEN",title:option("--title"),description:option("--description"),pullRequestTargets:[target]}
  await Bun.write(file,JSON.stringify(pr)); console.log(JSON.stringify({pullRequest:pr}))
} else if (action === "update-pull-request-title" || action === "update-pull-request-description") {
  if(action.endsWith("title")) pr.title=option("--title"); else pr.description=option("--description")
  await Bun.write(file,JSON.stringify(pr)); console.log(JSON.stringify({pullRequest:pr}))
} else throw new Error("Unexpected CodeCommit action: " + action)
`,
		)
		await Bun.$`chmod 755 ${`${dataDir}/aws`}`.quiet()
		const code = Bun.fileURLToPath(
			new URL("../../runtime/code", import.meta.url),
		)
		const awsClone = await checked([
			"python3",
			code,
			"checkout",
			"https://git-codecommit.us-east-2.amazonaws.com/v1/repos/Repo",
		])
		const awsPath = /^Checkout: (.+)$/m.exec(awsClone)![1]!
		await Bun.write(`${awsPath}/README.md`, "CodeCommit fix\n")
		await checked(["git", "add", "README.md"], awsPath)
		await checked(
			["git", "commit", "-m", "Fix CodeCommit example"],
			awsPath,
		)
		const awsPublish = [
			"python3",
			code,
			"pr",
			"--title",
			"Fix CodeCommit example",
			"--body-file",
			bodyFile,
		]
		expect(await checked(awsPublish, awsPath)).toContain(
			"/codecommit/repositories/Repo/pull-requests/43?region=us-east-2",
		)
		const awsPr = (await Bun.file(awsState).json()) as {
			pullRequestId: string
			title: string
			description: string
			pullRequestStatus: string
		}
		expect(awsPr.pullRequestId).toBe("43")
		expect(awsPr.title).toBe("Fix CodeCommit example")
		await Bun.write(bodyFile, "Updated CodeCommit checks.")
		await checked(awsPublish, awsPath)
		expect((await Bun.file(awsState).json()).description).toBe(
			"Updated CodeCommit checks.",
		)
		expect(
			awsHeaders.every(
				headers =>
					headers.get("authorization") ===
					`Basic ${btoa("test-aws-user:test-aws-signature")}`,
			),
		).toBe(true)
		expect(awsHeaders.every(headers => !headers.has("x-dot-caller"))).toBe(
			true,
		)
		const awsCommonDir = await checked(
			["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
			awsPath,
		)
		const awsGitConfig = await Bun.file(`${awsCommonDir}/config`).text()
		expect(awsGitConfig).not.toContain("test-aws-signature")
		expect(awsGitConfig).not.toContain(credential)
		const unassigned = await fetch(`${api.url}/codecommit/repository`, {
			method: "POST",
			headers: {
				"x-dot-caller": callerCredential({
					...caller,
					userId: "U00000099",
				}),
				"content-type": "application/json",
			},
			body: JSON.stringify({ region: "us-east-2", repository: "Repo" }),
		})
		expect(unassigned.status).toBe(502)
		expect(((await unassigned.json()) as { text: string }).text).toContain(
			"isn't connected for this Slack account",
		)
		await Bun.write(
			awsState,
			JSON.stringify({ ...awsPr, pullRequestStatus: "CLOSED" }),
		)
		expect((await command(awsPublish, awsPath)).err).toContain(
			"PR is closed",
		)
	} finally {
		upstream.mockRestore()
		token.mockRestore()
		account.mockRestore()
	}
}, 30_000)
