import { expect, test } from "bun:test"
import type { AcpSessionInfo } from "./acp"
import { agySignInLink, parseAgyModels } from "./agy"
import { AgyLimitError, classify, NotSignedInError } from "./errors"

test("a sign-in that prints after its link still ends cleanly", async () => {
	// Like `agy acp --login`: the link, a wait for the code, then confirmation and exit 0.
	const proc = Bun.spawn(
		[
			"sh",
			"-c",
			'echo "Open this link: https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz"; read code; sleep 0.2; echo "Logged in."',
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	)
	expect(await agySignInLink(proc.stdout)).toBe(
		"https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz",
	)
	proc.stdin.write("4/0A-sample-code\n")
	await proc.stdin.flush()
	proc.stdin.end()
	expect(await proc.exited).toBe(0)
	expect(proc.signalCode).toBeNull()
})

test("a sign-in link split across multiple stdout chunks resolves complete before EOF", async () => {
	const proc = Bun.spawn(
		[
			"sh",
			"-c",
			'printf "Open: https://accounts.google.com/o/oauth2/auth?client_id=abc"; sleep 0.05; printf "&redirect_uri=https%%3A%%2F%%2Fantigravity.google%%2Foauth-callback"; sleep 0.05; printf "&state=xyz\\nEnter code: "; read code; echo "ok"',
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	)
	expect(await agySignInLink(proc.stdout)).toBe(
		"https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz",
	)
	proc.stdin.write("code\n")
	await proc.stdin.flush()
	proc.stdin.end()
	expect(await proc.exited).toBe(0)
	expect(proc.signalCode).toBeNull()
})

test("no sign-in link is an error that says what was printed instead", async () => {
	const proc = Bun.spawn(["sh", "-c", "echo 'login cancelled: offline'"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	})
	await expect(agySignInLink(proc.stdout)).rejects.toThrow(
		"login cancelled: offline",
	)
})

test("parseAgyModels extracts models, sorted thinking levels, and default selection", () => {
	const session: AcpSessionInfo = {
		sessionId: "sess-1",
		images: true,
		models: {
			currentModelId: "gemini-3.1-pro-low",
			availableModels: [
				{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
				{
					modelId: "gemini-4-neon-xhigh",
					name: "Gemini 4 Neon (XHigh)",
				},
				{
					modelId: "gemini-4-neon-medium",
					name: "Gemini 4 Neon (Medium)",
				},
				{ modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
				{
					modelId: "gemini-3.1-pro-high",
					name: "Gemini 3.1 Pro (High)",
				},
				{ modelId: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
			],
		},
		configOptions: [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "gemini-3.1-pro",
				options: [
					{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
					{ value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
				],
			},
			{
				id: "thought_level",
				name: "Thinking Level",
				category: "thought_level",
				type: "select",
				currentValue: "low",
				options: [
					{ value: "low", name: "Low" },
					{ value: "high", name: "High" },
				],
			},
		],
	}
	expect(parseAgyModels(session)).toEqual([
		{
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
			description: "",
			efforts: [
				{ id: "low", description: "" },
				{ id: "medium", description: "" },
				{ id: "high", description: "" },
				{ id: "xhigh", description: "" },
			],
			defaultEffort: "high",
			fast: false,
			images: true,
		},
		{
			id: "gemini-3.1-pro",
			name: "Gemini 3.1 Pro",
			description: "",
			efforts: [
				{ id: "low", description: "" },
				{ id: "high", description: "" },
			],
			defaultEffort: "low",
			fast: false,
			images: true,
			isDefault: true,
		},
	])
})

test("Antigravity auth and quota errors classify cleanly", () => {
	const auth = classify(new NotSignedInError("agy"))
	expect(auth.kind).toBe("agy_auth")
	expect(auth.message).toContain("Antigravity isn't connected")

	const limit = classify(new AgyLimitError("RESOURCE_EXHAUSTED"))
	expect(limit.kind).toBe("usage_limit")
	expect(limit.message).toContain("Antigravity")
	expect(limit.message).toContain("RESOURCE_EXHAUSTED")
})

test("connections sync writes 0600 agy-mcp.json with resolved headers and env", async () => {
	const home = `/tmp/laddu-agy-conn-${crypto.randomUUID()}`
	const connections = Bun.fileURLToPath(
		new URL("../../runtime/connections", import.meta.url),
	)
	const run = (args: string[], stdin?: string) =>
		Bun.spawn([connections, ...args], {
			env: { ...Bun.env, HOME: home },
			stdin: stdin ? new Response(stdin) : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
	try {
		await Bun.$`mkdir -p ${home}`.quiet()
		expect(
			await run(["key", "save", "API_TOKEN"], "secret-token\n").exited,
		).toBe(0)
		expect(
			await run([
				"mcp",
				"add",
				"docs",
				"--url",
				"https://mcp.example.com",
				"--bearer",
				"API_TOKEN",
			]).exited,
		).toBe(0)
		expect(
			await run([
				"mcp",
				"add",
				"local",
				"--command",
				"my-mcp --flag",
				"--env",
				"API_TOKEN",
			]).exited,
		).toBe(0)
		const agyMcp = (await Bun.file(
			`${home}/.laddu/agy-mcp.json`,
		).json()) as {
			mcpServers: Record<string, unknown>
		}
		expect(agyMcp).toEqual({
			mcpServers: {
				docs: {
					serverUrl: "https://mcp.example.com",
					headers: { Authorization: "Bearer secret-token" },
				},
				local: {
					command: "my-mcp",
					args: ["--flag"],
					env: { API_TOKEN: "secret-token" },
				},
			},
		})
		const mode = (
			await Bun.$`stat -c %a ${`${home}/.laddu/agy-mcp.json`}`.text()
		).trim()
		expect(mode).toBe("600")

		// Direct key-file updates refresh resolved headers and env on sync.
		await Bun.write(`${home}/.laddu/keys/API_TOKEN`, "rotated-token\n")
		expect(await run(["sync"]).exited).toBe(0)
		const refreshed = (await Bun.file(
			`${home}/.laddu/agy-mcp.json`,
		).json()) as {
			mcpServers: Record<string, unknown>
		}
		expect(refreshed).toEqual({
			mcpServers: {
				docs: {
					serverUrl: "https://mcp.example.com",
					headers: { Authorization: "Bearer rotated-token" },
				},
				local: {
					command: "my-mcp",
					args: ["--flag"],
					env: { API_TOKEN: "rotated-token" },
				},
			},
		})
	} finally {
		await Bun.$`rm -rf ${home}`.quiet().nothrow()
	}
})
