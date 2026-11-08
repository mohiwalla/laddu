/**
 * Claude Code as laddu's agent, on each person's own Claude plan (or their own API key). It's
 * Anthropic's own `claude`, unmodified, run headless in the person's container
 * (scripts/claude-docker.sh) with the same persona, commands, skills and computer as Codex.
 *
 * Sign-in is Claude Code's own (`claude auth login`): its sign-in page opens in Chromium on their
 * laddu computer, they sign in there themselves, and the login stays in their container, where
 * Claude Code refreshes it. laddu never sees it.
 *
 * A turn speaks Claude Code's stream-json over stdin and stdout: the prompt goes in as a user
 * message, more messages mid-turn steer it (Claude Code queues them for its next step), and an
 * interrupt stops it.
 */
import type { App } from "@slack/bolt"
import type { ThreadItem } from "@openai/codex-sdk"
import type { BotConfig } from "../config"
import { sendNotice, systemName, type Where } from "../slack/system"
import { LostSessionError } from "./acp"
import {
	CLAUDE_DOCKER_WRAPPER,
	CONTAINER_HOME,
	CONTAINER_TOOLS_DIR,
	ensureContainer,
	stopRun,
} from "./containers"
import { ClaudeLimitError, NotSignedInError } from "./errors"
import { stepTracker, type AgentItem, type Todos } from "./steps"
import { runTool } from "./tools"
import {
	childEnv,
	collectOutbox,
	containerWorkspace,
	loadMemory,
	memoryNote,
	newTurnId,
	outboxNote,
	saveAttachments,
	turnEnv,
	type ModelOption,
	type TurnFile,
	type TurnOptions,
	type TurnResult,
	type TurnUser,
} from "./turn"

type WebClient = App["client"]

/** The API key Claude Code takes instead of a plan, as `connections` keeps it. */
export const CLAUDE_KEY = "ANTHROPIC_API_KEY"

/** `claude` in their container (the wrapper), with this run's env; LADDU_TURN names the process. */
async function startClaude(
	config: BotConfig,
	user: TurnUser,
	args: string[],
	env: Record<string, string>,
) {
	const container = await ensureContainer(config, user.teamId, user.userId)
	const proc = Bun.spawn([CLAUDE_DOCKER_WRAPPER, ...args], {
		env: childEnv({ LADDU_CONTAINER: container, ...env }),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	})
	let stderr = ""
	void (async () => {
		for await (const chunk of proc.stderr.pipeThrough(
			new TextDecoderStream(),
		))
			stderr = (stderr + chunk).slice(-4000)
	})().catch(() => {})
	return { proc, container, stderr: () => stderr }
}

/** Stdout as lines of JSON (other lines are skipped). */
async function* events(
	stdout: Bun.Subprocess<"pipe", "pipe", "pipe">["stdout"],
) {
	let rest = ""
	for await (const chunk of stdout.pipeThrough(new TextDecoderStream())) {
		const lines = (rest + chunk).split("\n")
		rest = lines.pop() ?? ""
		for (const line of lines) {
			if (!line.startsWith("{")) continue
			try {
				yield JSON.parse(line) as ClaudeEvent
			} catch {}
		}
	}
}

const STREAM = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
]

// ---- account ---------------------------------------------------------------------------------

export type ClaudeAccount = {
	/** Their Claude plan, or their API key. */
	method: "plan" | "key"
	email: string | null
	/** pro, max, team, enterprise… (plans only). */
	plan: string | null
}

const key = (user: TurnUser) => `${user.teamId}-${user.userId}`
const ACCOUNT_MS = 10 * 60_000
const accounts = new Map<
	string,
	{ account: Promise<ClaudeAccount | null>; at: number }
>()

/** How they're connected to Claude, or null; cached for a few minutes. */
export function claudeAccount(
	config: BotConfig,
	user: TurnUser,
): Promise<ClaudeAccount | null> {
	const cached = accounts.get(key(user))
	if (cached && Date.now() - cached.at < ACCOUNT_MS) return cached.account
	const account = (async () => {
		const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
		const { proc, container } = await startClaude(
			config,
			user,
			["auth", "status"],
			{ LADDU_TURN: turnId },
		)
		proc.stdin.end()
		const [output] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]).finally(() => stopRun(container, turnId))
		const status = JSON.parse(output) as {
			loggedIn: boolean
			authMethod?: string
			email?: string | null
			subscriptionType?: string | null
		}
		if (!status.loggedIn) return null
		return {
			method: status.authMethod === "claude.ai" ? "plan" : "key",
			email: status.email ?? null,
			plan: status.subscriptionType ?? null,
		} satisfies ClaudeAccount
	})()
	accounts.set(key(user), { account, at: Date.now() })
	account.catch(() => accounts.delete(key(user)))
	return account
}

/** Forgets what's cached about their Claude connection (after it changes). */
export function forgetClaude(user: TurnUser) {
	accounts.delete(key(user))
	models.delete(key(user))
}

/** A sign-in waiting in their container: its link, and where the code they paste goes. */
type SignIn = {
	link: string
	/** Hands Claude Code the code; true once it's signed them in. */
	paste: (code: string) => Promise<boolean>
	stop: () => Promise<void>
}

/** Sign-ins waiting for the person, by person. */
const signingIn = new Map<string, Promise<SignIn>>()

/** They connected another way (their API key): a sign-in still waiting ends quietly. */
export async function connectedClaude(user: TurnUser): Promise<void> {
	const waiting = signingIn.get(key(user))
	signingIn.delete(key(user))
	forgetClaude(user)
	await (await waiting?.catch(() => null))?.stop()
}

/** How long a sign-in waits for them. */
const SIGN_IN_MINUTES = 15

/**
 * Claude Code's own sign-in, with its paste-code step: `claude auth login` runs in their container
 * and gives the sign-in link (the one waiting already, if there is one). They sign in in their own
 * browser, Claude's page shows a code, and they paste it in the Connect Claude form (slack/home.ts),
 * which goes straight to Claude Code's prompt: Claude Code exchanges it and keeps the login in their
 * container. laddu keeps nothing.
 */
export function claudeSignIn(
	config: BotConfig,
	user: TurnUser,
): Promise<SignIn> {
	const id = key(user)
	const waiting = signingIn.get(id)
	if (waiting) return waiting
	const started = (async (): Promise<SignIn> => {
		const turnId = `signin-${crypto.randomUUID().slice(0, 8)}`
		// No browser to open (LADDU_BROWSER): Claude Code prints its paste-code link instead.
		const { proc, container } = await startClaude(
			config,
			user,
			["auth", "login", "--claudeai"],
			{ LADDU_TURN: turnId, LADDU_BROWSER: "true" },
		)
		const stop = async () => {
			if (signingIn.get(id) === started) signingIn.delete(id)
			proc.kill()
			await stopRun(container, turnId)
		}
		const expiry = setTimeout(() => void stop(), SIGN_IN_MINUTES * 60_000)
		try {
			return {
				link: await signInLink(proc.stdout),
				paste: async code => {
					// One try: Claude Code ends either way, and `docker exec` only notices once stdin
					// closes. The next sign-in starts afresh.
					signingIn.delete(id)
					clearTimeout(expiry)
					proc.stdin.write(`${code}\n`)
					await proc.stdin.flush()
					proc.stdin.end()
					const exit = await Promise.race([
						proc.exited,
						Bun.sleep(30_000).then(() => null),
					])
					await stop()
					forgetClaude(user)
					return exit === 0
				},
				stop: async () => {
					clearTimeout(expiry)
					await stop()
				},
			}
		} catch (error) {
			clearTimeout(expiry)
			await stop()
			throw error
		}
	})()
	signingIn.set(id, started)
	started.catch(() => {
		if (signingIn.get(id) === started) signingIn.delete(id)
	})
	return started
}

/**
 * A turn needs them signed in: a private message where they asked (`where`; null: their DM) with
 * Connect Claude, which opens the form (slack/home.ts), and the API key option.
 */
export async function signInClaude(
	client: WebClient,
	user: TurnUser,
	where: Where,
): Promise<void> {
	await sendNotice(client, user, where, {
		icon: ":key:",
		title: "Connect Claude",
		text: `${systemName()} runs Claude Code on your own Claude plan, or on an API key.`,
		buttons: [
			{
				label: "Connect Claude",
				action: "home_claude_connect",
				value: "connect",
				primary: true,
			},
			{
				label: "Use an API key",
				action: "home_claude_key",
				value: "key",
			},
		],
		footer: "Only you can see this.",
	})
}

/** The paste-code sign-in link `claude auth login` prints (Anthropic's page shows the code). */
async function signInLink(
	stdout: Bun.Subprocess<"pipe", "pipe", "pipe">["stdout"],
): Promise<string> {
	let text = ""
	const reading = (async () => {
		for await (const chunk of stdout.pipeThrough(new TextDecoderStream())) {
			text += chunk
			const link = text.match(
				/https:\/\/\S*oauth\/authorize\S*code=true\S*/,
			)?.[0]
			if (link) return link
		}
		throw new Error(
			`Claude Code didn't give a sign-in link: ${text.trim().slice(-300)}`,
		)
	})()
	return Promise.race([
		reading,
		Bun.sleep(30_000).then(() => {
			throw new Error("Claude Code didn't give a sign-in link in time")
		}),
	])
}

/** Signs them out of Claude (and removes their API key, if that's how they connected). */
export async function signOutClaude(
	config: BotConfig,
	user: TurnUser,
): Promise<void> {
	const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
	const { proc, container } = await startClaude(
		config,
		user,
		["auth", "logout"],
		{ LADDU_TURN: turnId },
	)
	proc.stdin.end()
	await proc.exited.finally(() => stopRun(container, turnId))
	await runTool(config, user, ["connections", "key", "remove", CLAUDE_KEY])
	forgetClaude(user)
}

// ---- models ----------------------------------------------------------------------------------

const MODELS_MS = 6 * 3600_000
const models = new Map<string, { list: Promise<ModelOption[]>; at: number }>()

/**
 * The models Claude Code offers them, with each one's effort levels, cached for a few hours.
 * Empty if they aren't connected or the list can't be read.
 */
export function listClaudeModels(
	config: BotConfig,
	user: TurnUser,
): Promise<ModelOption[]> {
	const cached = models.get(key(user))
	if (cached && Date.now() - cached.at < MODELS_MS) return cached.list
	const list = (async () => {
		if (!(await claudeAccount(config, user))) {
			models.delete(key(user))
			return []
		}
		const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
		const { proc, container } = await startClaude(config, user, STREAM, {
			LADDU_TURN: turnId,
		})
		try {
			proc.stdin.write(
				`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
			)
			await proc.stdin.flush()
			for await (const event of events(proc.stdout)) {
				if (event.type !== "control_response") continue
				const listed = (event.response?.response?.models ??
					[]) as ClaudeModel[]
				return listed.map(model => {
					const efforts = model.supportsEffort
						? (model.supportedEffortLevels ?? [])
						: []
					return {
						id: model.value,
						name: model.displayName,
						// Without its per-token price: that's for API keys, not plans.
						description: model.description.replace(
							/\s*·\s*\$.*$/,
							"",
						),
						efforts: efforts.map(id => ({ id, description: "" })),
						defaultEffort: efforts.includes("high")
							? "high"
							: (efforts[0] ?? ""),
						fast: false,
						images: true,
						...(model.value === "default"
							? { isDefault: true }
							: {}),
					}
				})
			}
			throw new Error("Claude Code didn't list its models")
		} finally {
			proc.kill()
			await stopRun(container, turnId)
		}
	})().catch(error => {
		console.warn("[claude] couldn't list models:", error)
		models.delete(key(user))
		return []
	})
	models.set(key(user), { list, at: Date.now() })
	return list
}

type ClaudeModel = {
	value: string
	displayName: string
	description: string
	supportsEffort?: boolean
	supportedEffortLevels?: string[]
}

// ---- turns -----------------------------------------------------------------------------------

/** What Claude Code writes on stdout in stream-json (the parts laddu reads). */
type ClaudeEvent = {
	type: string
	subtype?: string
	session_id?: string
	/** Set on a sub-agent's messages: those aren't the turn's own steps. */
	parent_tool_use_id?: string | null
	/** Why an assistant message is an error instead (authentication_failed, rate_limit…). */
	error?: string
	message?: { content?: ContentBlock[] | string }
	// result
	is_error?: boolean
	result?: string
	errors?: string[]
	queued_turn_count?: number
	user_message_uuids?: string[]
	// control_response
	response?: { response?: Record<string, unknown> }
}

type ContentBlock = {
	type: string
	text?: string
	id?: string
	name?: string
	input?: Record<string, unknown>
	tool_use_id?: string
	is_error?: boolean
	content?: unknown
}

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
}

export async function runClaudeTurn(options: TurnOptions): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, user } = options
	const track = stepTracker(
		step => options.onStep?.(step),
		todos => options.onTodos?.(todos),
	)
	const turnId = newTurnId()
	const container = await ensureContainer(config, user.teamId, user.userId)
	const { outbox, saveFile, listOutbox } = await containerWorkspace(
		container,
		turnId,
	)
	options.signal?.throwIfAborted()

	// Images go in as data; every file is also saved in the workspace.
	const attach = async (files: TurnFile[]) => {
		const { note, images } = await saveAttachments(files, saveFile, true)
		return {
			note,
			images: images.flatMap(({ file }) => {
				const type =
					IMAGE_TYPES[
						file.fileName.split(".").pop()?.toLowerCase() ?? ""
					]
				return type
					? [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: type,
									data: file.data.toBase64(),
								},
							},
						]
					: []
			}),
		}
	}
	// Loaded once per conversation, like a system prompt; resumed ones already have it.
	const memory = options.threadId
		? null
		: await loadMemory(() => runTool(config, user, ["memory", "show"]))
	const { note, images } = await attach(options.files ?? [])

	const mcp = [`${CONTAINER_HOME}/.laddu/claude-mcp.json`]
	if (config.desktop)
		mcp.push(
			JSON.stringify({
				mcpServers: {
					desktop: {
						command: `${CONTAINER_TOOLS_DIR}/desktop`,
						args: ["mcp"],
					},
				},
			}),
		)
	const args = [
		...STREAM,
		"--mcp-config",
		...mcp,
		...(config.model && config.model !== "default"
			? ["--model", config.model]
			: []),
		...(config.reasoningEffort ? ["--effort", config.reasoningEffort] : []),
		...(options.threadId ? ["--resume", options.threadId] : []),
	]
	const { proc, stderr } = await startClaude(config, user, args, {
		...turnEnv(turnId, user, options.slack),
	})
	const send = async (message: object) => {
		proc.stdin.write(`${JSON.stringify(message)}\n`)
		await proc.stdin.flush()
	}
	// Each message laddu sends, until a result says Claude Code took it.
	const waiting = new Set<string>()
	const say = (content: unknown[]) => {
		const uuid = crypto.randomUUID()
		waiting.add(uuid)
		return send({
			type: "user",
			uuid,
			session_id: "",
			parent_tool_use_id: null,
			message: { role: "user", content },
		})
	}
	const text = (value: string) => ({ type: "text", text: value })

	let finished = false
	// Stop: Claude Code ends the turn with a result; if it doesn't soon, the run is ended.
	const onAbort = () => {
		void send({
			type: "control_request",
			request_id: "stop",
			request: { subtype: "interrupt" },
		}).catch(() => {})
		setTimeout(() => {
			proc.kill()
			void stopRun(container, turnId)
		}, 3000)
	}
	options.signal?.addEventListener("abort", onAbort, { once: true })
	try {
		await say([
			text(
				[memoryNote(memory), options.input, note, outboxNote(outbox)]
					.filter(Boolean)
					.join("\n\n"),
			),
			...images,
		])
		options.onSteerable?.(async (more, files = []) => {
			if (finished || options.signal?.aborted) return false
			const { note, images } = await attach(files)
			if (finished) return false
			await say([
				text([more, note].filter(Boolean).join("\n\n")),
				...images,
			])
			return true
		})

		const tools = new Tools(track)
		let sessionId = options.threadId ?? ""
		let failure: string | undefined
		let result: ClaudeEvent | undefined
		for await (const event of events(proc.stdout)) {
			if (event.session_id) sessionId = event.session_id
			if (event.parent_tool_use_id) continue
			if (event.type === "assistant") {
				if (event.error) failure = event.error
				for (const block of blocks(event))
					if (block.type === "text" && block.text?.trim())
						tools.message(block.text.trim())
					else if (block.type === "tool_use") tools.start(block)
			} else if (event.type === "user") {
				for (const block of blocks(event))
					if (block.type === "tool_result") tools.end(block)
			} else if (event.type === "result") {
				for (const uuid of event.user_message_uuids ?? [])
					waiting.delete(uuid)
				result = event
				// More of laddu's messages still to answer (steering that came in late).
				if (event.queued_turn_count || waiting.size) continue
				break
			}
		}
		finished = true
		options.onSteerable?.(null)
		options.signal?.throwIfAborted()
		if (!result) {
			const detail = stderr().trim().split("\n").at(-1)
			if (detail && /no conversation found/i.test(detail))
				throw new LostSessionError(detail)
			throw new Error(
				`Claude Code stopped${detail ? `: ${detail}` : " without an answer"}`,
			)
		}
		if (result.is_error) {
			const detail = [result.result, ...(result.errors ?? [])]
				.filter(Boolean)
				.join("; ")
			if (
				failure === "authentication_failed" ||
				/not logged in|invalid api key|please run \/login/i.test(detail)
			)
				throw new NotSignedInError("claude")
			if (failure === "rate_limit") throw new ClaudeLimitError(detail)
			if (/no conversation found/i.test(`${detail}\n${stderr()}`))
				throw new LostSessionError(detail)
			throw new Error(detail || "Claude Code couldn't finish the turn")
		}
		const { files, skipped } = await collectOutbox(await listOutbox())
		return {
			threadId: sessionId,
			text:
				result.result?.trim() ||
				(files.length
					? ""
					: "_(Claude Code finished without a reply.)_"),
			files,
			skipped,
		}
	} finally {
		finished = true
		options.onSteerable?.(null)
		options.signal?.removeEventListener("abort", onAbort)
		proc.stdin.end()
		await Promise.race([proc.exited, Bun.sleep(3000)])
		proc.kill()
		await stopRun(container, turnId)
	}
}

const blocks = (event: ClaudeEvent): ContentBlock[] =>
	Array.isArray(event.message?.content) ? event.message.content : []

const basename = (path: string) => path.replace(/\/+$/, "").replace(/^.*\//, "")

/**
 * Claude Code's messages and tool calls as the items steps.ts knows, and its task list (TodoWrite,
 * or TaskCreate/TaskUpdate) as the turn's to-do list.
 */
class Tools {
	private running = new Map<string, ContentBlock>()
	private count = 0
	private tasks = new Map<string, Todos["items"][number]>()
	/** TaskCreate calls waiting for the id their result gives. */
	private creating = new Map<string, string>()
	constructor(private onItem: (item: AgentItem, done: boolean) => void) {}

	message(text: string) {
		this.onItem(
			{ id: `message-${++this.count}`, type: "agent_message", text },
			true,
		)
	}

	start(tool: ContentBlock) {
		const input = tool.input ?? {}
		if (tool.name === "TodoWrite") {
			const todos = Array.isArray(input.todos)
				? (input.todos as { content?: string; status?: string }[])
				: []
			return this.plan(
				todos.map(todo => ({
					text: String(todo.content ?? ""),
					status: status(todo.status),
				})),
			)
		}
		if (tool.name === "TaskCreate") {
			this.creating.set(tool.id!, String(input.subject ?? ""))
			return
		}
		if (tool.name === "TaskUpdate") {
			const id = String(input.taskId ?? "")
			const task = this.tasks.get(id)
			if (input.status === "deleted") this.tasks.delete(id)
			else if (task)
				this.tasks.set(id, {
					text: String(input.subject ?? task.text),
					status: input.status ? status(input.status) : task.status,
				})
			return this.plan([...this.tasks.values()])
		}
		this.running.set(tool.id!, tool)
		const item = toItem(tool, "in_progress")
		if (item) this.onItem(item, false)
	}

	end(result: ContentBlock) {
		const id = result.tool_use_id ?? ""
		const subject = this.creating.get(id)
		if (subject !== undefined) {
			this.creating.delete(id)
			const created = resultText(result).match(/#(\d+)/)?.[1]
			if (created && !result.is_error) {
				this.tasks.set(created, { text: subject, status: "pending" })
				this.plan([...this.tasks.values()])
			}
			return
		}
		const tool = this.running.get(id)
		if (!tool) return
		this.running.delete(id)
		const item = toItem(tool, result.is_error ? "failed" : "completed")
		if (item) this.onItem(item, true)
	}

	private plan(items: Todos["items"]) {
		this.onItem({ type: "plan", items }, false)
	}
}

const status = (value: unknown): Todos["items"][number]["status"] =>
	value === "completed" || value === "in_progress" ? value : "pending"

const resultText = (result: ContentBlock): string =>
	typeof result.content === "string"
		? result.content
		: Array.isArray(result.content)
			? (result.content as ContentBlock[])
					.map(block => block.text ?? "")
					.join("\n")
			: ""

/** A Claude Code tool call as one of the items steps.ts knows; null for ones not worth a step. */
function toItem(
	tool: ContentBlock,
	state: "in_progress" | "completed" | "failed",
): AgentItem | null {
	const id = tool.id!
	const name = tool.name ?? ""
	const input = tool.input ?? {}
	const path = [input.file_path, input.notebook_path, input.path].find(
		(value): value is string => typeof value === "string",
	)
	const desktop = name.match(/^mcp__desktop__([a-z_]+)$/)
	if (desktop)
		return {
			id,
			type: "mcp_tool_call",
			server: "desktop",
			tool: desktop[1]!,
			arguments: input,
			status: state,
		} as ThreadItem
	const titled = (title: string): AgentItem => ({
		id,
		type: "tool",
		title,
		status: state,
	})
	switch (name) {
		case "Bash":
			return {
				id,
				type: "command_execution",
				command: String(input.command ?? ""),
				aggregated_output: "",
				status: state,
			} as ThreadItem
		case "WebFetch":
			return {
				id,
				type: "command_execution",
				command: `webfetch ${String(input.url ?? "")}`,
				aggregated_output: "",
				status: state,
			} as ThreadItem
		case "WebSearch":
			return {
				id,
				type: "web_search",
				query: String(input.query ?? ""),
			} as ThreadItem
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return {
				id,
				type: "file_change",
				changes: [{ path: path ?? "a file", kind: "update" }],
				status: state,
			} as ThreadItem
		case "Read":
			return titled(path ? `Reading ${basename(path)}` : "Reading a file")
		case "Glob":
		case "Grep":
			return titled("Looking through files")
		case "Task":
		case "Agent":
			return titled(
				input.description
					? `Asking a helper: ${String(input.description)}`
					: "Asking a helper",
			)
		case "Skill":
			return titled(
				input.skill
					? `Using the ${String(input.skill)} skill`
					: "Using a skill",
			)
		// Its own bookkeeping: finding tools, reading its task list.
		case "ToolSearch":
		case "TaskList":
		case "TaskGet":
		case "TaskOutput":
			return null
		default: {
			const mcp = name.match(/^mcp__(.+?)__(.+)$/)
			return titled(mcp ? `Using ${mcp[1]} (${mcp[2]})` : `Using ${name}`)
		}
	}
}
