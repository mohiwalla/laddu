/**
 * Runs a turn on any agent that speaks the Agent Client Protocol (https://agentclientprotocol.com)
 * over stdio: OpenCode today, and the others in the ACP registry (Claude, Antigravity, Gemini…)
 * the same way. This is the only file that knows the SDK; agents (opencode.ts) say how to start
 * theirs, and get back laddu's steps, steering and Stop.
 *
 * ACP has no way to add to a prompt that's running, so steering cancels it and sends the new
 * message as the next prompt in the same session, as T3 Code does.
 */
import * as acp from "@agentclientprotocol/sdk"
import type { ThreadItem } from "@openai/codex-sdk"
import type { AgentItem } from "./steps"

export type AcpContentBlock = acp.ContentBlock
export type AcpMcpServer = acp.McpServer

export type AcpProcess = {
	/** Starts the agent with ACP on stdin and stdout (wherever it runs). */
	command: string[]
	env: Record<string, string>
	/** The session's working directory, as the agent sees it. */
	cwd: string
	mcpServers: acp.McpServer[]
	/** ACP auth method to invoke before opening a session (e.g. "gemini-api-key"). */
	authMethod?: string
	/** A value of the session's model option; left as it is when the agent doesn't offer it. */
	model?: string
	/** A value of the model's reasoning option (thought_level); left as it is when not offered. */
	effort?: string
	/** Ends the run wherever it runs (closing stdin only ends the local end of `docker exec`). */
	stop: () => Promise<void>
}

export type AcpSessionInfo = {
	sessionId: string
	configOptions?: acp.SessionConfigOption[] | null
	models?: {
		availableModels?: {
			modelId: string
			name?: string
			description?: string | null
		}[]
		currentModelId?: string
	} | null
	/** Whether the agent accepts inline image content blocks. */
	images: boolean
}

/** The agent doesn't have the conversation any more (errors.ts starts a fresh one). */
export class LostSessionError extends Error {}

/** The agent refused the session because the person isn't signed in (JSON-RPC -32000). */
export class AuthRequiredError extends Error {}

const isAuthRequired = (error: unknown): boolean => {
	if (!error || typeof error !== "object") return false
	const code = (error as { code?: unknown }).code
	const message = error instanceof Error ? error.message : String(error)
	return (
		code === -32000 ||
		/authentication required|not authenticated/i.test(message)
	)
}

export async function runAcpTurn(
	agent: AcpProcess,
	options: {
		sessionId?: string
		prompt: acp.ContentBlock[]
		signal?: AbortSignal
		onItem: (item: AgentItem, done: boolean) => void
		/** A way to add a message to the turn once it runs, and null once it can't any more. */
		onSteerable?: (
			steer: ((prompt: acp.ContentBlock[]) => boolean) | null,
		) => void
	},
): Promise<{ sessionId: string; text: string }> {
	const proc = Bun.spawn(agent.command, {
		env: agent.env,
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
	const exited = proc.exited.then(code => {
		const detail = stderr.trim().split("\n").at(-1)
		throw new Error(
			`The agent stopped (exit ${code})${detail ? `: ${detail}` : ""}`,
		)
	})
	exited.catch(() => {})

	let sessionId = options.sessionId
	// session/load replays the conversation as updates; those aren't this turn's.
	let replaying = false
	const messages = new Messages(options.onItem)
	const tools = new Map<string, acp.ToolCallUpdate>()

	const connection = acp
		.client({ name: "laddu" })
		// Nobody is around to approve actions mid-turn; the container is the boundary.
		.onRequest("session/request_permission", async ({ params }) => {
			const option =
				params.options.find(option => option.kind === "allow_always") ??
				params.options.find(option => option.kind === "allow_once") ??
				params.options[0]
			return option
				? {
						outcome: {
							outcome: "selected",
							optionId: option.optionId,
						},
					}
				: { outcome: { outcome: "cancelled" } }
		})
		.onNotification("session/update", async ({ params }) => {
			if (replaying || params.sessionId !== sessionId) return
			const update = params.update
			switch (update.sessionUpdate) {
				case "agent_message_chunk":
					if (update.content.type === "text")
						messages.add(update.content.text)
					return
				case "plan":
					options.onItem(
						{
							type: "plan",
							items: update.entries.map(entry => ({
								text: entry.content,
								status: entry.status,
							})),
						},
						false,
					)
					return
				case "tool_call":
				case "tool_call_update": {
					messages.finish()
					const tool = {
						...tools.get(update.toolCallId),
						...withoutNulls(update),
					} as acp.ToolCallUpdate
					tools.set(update.toolCallId, tool)
					const item = toItem(tool)
					if (item)
						options.onItem(
							item,
							tool.status === "completed" ||
								tool.status === "failed",
						)
				}
			}
		})
		.connect(
			acp.ndJsonStream(
				new WritableStream<Uint8Array>({
					write: async chunk => {
						proc.stdin.write(chunk)
						await proc.stdin.flush()
					},
					close: () => {
						proc.stdin.end()
					},
				}),
				proc.stdout as ReadableStream<Uint8Array>,
			),
		)
	const call = <T>(request: Promise<T>) => Promise.race([request, exited])
	const peer = connection.agent

	let finished = false
	let stopping: Promise<void> | undefined
	const onAbort = () => {
		stopping = (async () => {
			if (sessionId)
				await peer
					.notify("session/cancel", { sessionId })
					.catch(() => {})
			await Promise.race([prompting, Bun.sleep(3000)]).catch(() => {})
			connection.close()
			proc.kill()
			await agent.stop()
		})().catch(() => {})
	}
	let prompting: Promise<unknown> = Promise.resolve()
	options.signal?.addEventListener("abort", onAbort, { once: true })
	try {
		const { agentCapabilities: can } = await call(
			peer.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: { name: "laddu", version: "1" },
			}),
		)
		if (agent.authMethod)
			await call(
				peer.request("authenticate", { methodId: agent.authMethod }),
			).catch(error => {
				if (isAuthRequired(error))
					throw new AuthRequiredError(
						error instanceof Error ? error.message : String(error),
					)
				throw error
			})
		const session = { cwd: agent.cwd, mcpServers: agent.mcpServers }
		let configOptions: acp.SessionConfigOption[] | null | undefined
		if (sessionId) {
			const resumed = sessionId
			const lost = (error: unknown) => {
				if (isAuthRequired(error))
					throw new AuthRequiredError(
						error instanceof Error ? error.message : String(error),
					)
				throw new LostSessionError(
					`The agent no longer has this conversation (${error instanceof Error ? error.message : String(error)})`,
				)
			}
			if (can?.sessionCapabilities?.resume)
				({ configOptions } = await call(
					peer.request("session/resume", {
						sessionId: resumed,
						...session,
					}),
				).catch(lost))
			else if (can?.loadSession) {
				replaying = true
				;({ configOptions } = await call(
					peer.request("session/load", {
						sessionId: resumed,
						...session,
					}),
				)
					.catch(lost)
					.finally(() => (replaying = false)))
			} else lost(new Error("it can't resume conversations"))
		} else {
			const created = await call(
				peer.request<acp.NewSessionResponse>("session/new", session),
			).catch(error => {
				if (isAuthRequired(error))
					throw new AuthRequiredError(
						error instanceof Error ? error.message : String(error),
					)
				throw error
			})
			sessionId = created.sessionId
			configOptions = created.configOptions
		}
		const id = sessionId!
		options.signal?.throwIfAborted()

		// The model first: the reasoning option depends on it (OpenCode lists its variants).
		for (const [category, value] of [
			["model", agent.model],
			["thought_level", agent.effort],
		] as const) {
			const option = configOptions?.find(
				option =>
					option.category === category && option.type === "select",
			)
			if (
				value &&
				option?.type === "select" &&
				option.currentValue !== value &&
				selectValues(option).includes(value)
			)
				({ configOptions } = await call(
					peer.request<acp.SetSessionConfigOptionResponse>(
						"session/set_config_option",
						{ sessionId: id, configId: option.id, value },
					),
				))
		}

		options.signal?.throwIfAborted()
		// Steering: what to send once the running prompt has been cancelled.
		let queued: acp.ContentBlock[] = []
		let cancelling = false
		options.onSteerable?.(prompt => {
			if (finished || options.signal?.aborted) return false
			queued.push(...prompt)
			if (!cancelling) {
				cancelling = true
				void peer
					.notify("session/cancel", { sessionId: id })
					.catch(() => {})
			}
			return true
		})
		let prompt = options.prompt
		for (;;) {
			options.signal?.throwIfAborted()
			const request = call(
				peer.request("session/prompt", { sessionId: id, prompt }),
			)
			prompting = request
			const { stopReason } = await request
			options.signal?.throwIfAborted()
			if (queued.length) {
				// Steered: cancelled for the new message (or it came in just as the prompt ended).
				messages.finish()
				prompt = queued
				queued = []
				cancelling = false
				continue
			}
			if (stopReason === "cancelled")
				throw new Error("The agent cancelled the turn")
			break
		}
		finished = true
		options.onSteerable?.(null)
		messages.finish()
		return { sessionId: id, text: messages.answer }
	} finally {
		finished = true
		options.onSteerable?.(null)
		options.signal?.removeEventListener("abort", onAbort)
		await stopping
		connection.close()
		proc.kill()
		await agent.stop().catch(() => {})
	}
}

/**
 * Starts an ACP agent briefly to open a fresh session (for listing models and checking sign-in)
 * without running a prompt. Throws AuthRequiredError if the agent refuses the session for auth.
 */
export async function probeAcpSession(
	agent: Pick<AcpProcess, "command" | "env" | "cwd" | "authMethod" | "stop">,
): Promise<AcpSessionInfo> {
	const proc = Bun.spawn(agent.command, {
		env: agent.env,
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
	const exited = proc.exited.then(code => {
		const detail = stderr.trim().split("\n").at(-1)
		throw new Error(
			`The agent stopped (exit ${code})${detail ? `: ${detail}` : ""}`,
		)
	})
	exited.catch(() => {})
	const connection = acp
		.client({ name: "laddu" })
		.onNotification("session/update", async () => {})
		.connect(
			acp.ndJsonStream(
				new WritableStream<Uint8Array>({
					write: async chunk => {
						proc.stdin.write(chunk)
						await proc.stdin.flush()
					},
					close: () => {
						proc.stdin.end()
					},
				}),
				proc.stdout as ReadableStream<Uint8Array>,
			),
		)
	const call = <T>(request: Promise<T>) => Promise.race([request, exited])
	const peer = connection.agent
	try {
		const init = await call(
			peer.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: { name: "laddu", version: "1" },
			}),
		)
		if (agent.authMethod)
			await call(
				peer.request("authenticate", { methodId: agent.authMethod }),
			).catch(error => {
				if (isAuthRequired(error))
					throw new AuthRequiredError(
						error instanceof Error ? error.message : String(error),
					)
				throw error
			})
		const created = (await call(
			peer.request<acp.NewSessionResponse>("session/new", {
				cwd: agent.cwd,
				mcpServers: [],
			}),
		).catch(error => {
			if (isAuthRequired(error))
				throw new AuthRequiredError(
					error instanceof Error ? error.message : String(error),
				)
			throw error
		})) as acp.NewSessionResponse & { models?: AcpSessionInfo["models"] }
		return {
			sessionId: created.sessionId,
			configOptions: created.configOptions,
			models: created.models,
			images: init.agentCapabilities?.promptCapabilities?.image === true,
		}
	} finally {
		connection.close()
		proc.kill()
		await agent.stop().catch(() => {})
	}
}

/** Signs out an ACP agent that supports the `logout` method (e.g. Antigravity). */
export async function logoutAcp(
	agent: Pick<AcpProcess, "command" | "env" | "stop">,
): Promise<void> {
	const proc = Bun.spawn(agent.command, {
		env: agent.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	})
	const connection = acp.client({ name: "laddu" }).connect(
		acp.ndJsonStream(
			new WritableStream<Uint8Array>({
				write: async chunk => {
					proc.stdin.write(chunk)
					await proc.stdin.flush()
				},
				close: () => {
					proc.stdin.end()
				},
			}),
			proc.stdout as ReadableStream<Uint8Array>,
		),
	)
	const peer = connection.agent
	try {
		await peer.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "laddu", version: "1" },
		})
		await peer.request("logout", {})
	} finally {
		connection.close()
		proc.kill()
		await agent.stop().catch(() => {})
	}
}

/** The agent's text, streamed in chunks; a message ends where an action starts. */
class Messages {
	private text = ""
	private count = 0
	/** The last whole message: the answer, once the turn ends. */
	answer = ""
	constructor(private onItem: (item: AgentItem, done: boolean) => void) {}
	add(chunk: string) {
		this.text += chunk
	}
	finish() {
		const text = this.text.trim()
		this.text = ""
		if (!text) return
		this.answer = text
		this.onItem(
			{ id: `message-${++this.count}`, type: "agent_message", text },
			true,
		)
	}
}

function selectValues(option: acp.SessionConfigOption): string[] {
	if (option.type !== "select") return []
	return (option.options as unknown[]).flatMap(entry =>
		entry && typeof entry === "object" && "options" in entry
			? (entry.options as { value: string }[]).map(choice => choice.value)
			: [(entry as { value: string }).value],
	)
}

const withoutNulls = (update: object) =>
	Object.fromEntries(
		Object.entries(update).filter(([, value]) => value != null),
	)

const basename = (path: string) => path.replace(/\/+$/, "").replace(/^.*\//, "")

const stringOf = (...values: unknown[]): string | undefined =>
	values.find((value): value is string => typeof value === "string")

const WEB_SEARCH = /(?:web[ _]?search|search[ _]?web)/i

/**
 * An ACP tool call as one of the items steps.ts knows. Held back until its input is known: the
 * first title it shows is the one kept.
 */
export function toItem(tool: acp.ToolCallUpdate): AgentItem | null {
	const input = (tool.rawInput ?? {}) as Record<string, unknown>
	const done = tool.status === "completed" || tool.status === "failed"
	const title = tool.title ?? ""
	// What makes its title: a command's command, a search's query, a fetch's URL.
	const command = stringOf(input.command, input.CommandLine, input.cmd)
	const url = stringOf(input.url, input.Url, input.uri)
	const query = stringOf(input.query, input.Query)
	const missing =
		tool.kind === "execute"
			? command === undefined
			: tool.kind === "fetch"
				? url === undefined
				: WEB_SEARCH.test(title)
					? query === undefined
					: !Object.keys(input).length && !tool.locations?.length
	if (!done && missing) return null
	const id = tool.toolCallId
	const status =
		tool.status === "failed"
			? "failed"
			: tool.status === "completed"
				? "completed"
				: "in_progress"
	const paths = [
		...(tool.locations ?? []).map(location => location.path),
		...[
			input.filePath,
			input.file_path,
			input.path,
			input.Path,
			input.TargetFile,
			input.AbsolutePath,
		].filter((path): path is string => typeof path === "string"),
	]
	const desktop = title.match(/^(?:mcp__?desktop__?|desktop[_.:/])([a-z_]+)$/)
	if (desktop)
		return {
			id,
			type: "mcp_tool_call",
			server: "desktop",
			tool: desktop[1]!,
			arguments: input,
			status,
		} as ThreadItem
	if (WEB_SEARCH.test(title))
		return {
			id,
			type: "web_search",
			query: query ?? "",
		} as ThreadItem
	switch (tool.kind) {
		case "execute": {
			const metadata = (
				tool.rawOutput as { metadata?: { exit?: number } }
			)?.metadata
			return {
				id,
				type: "command_execution",
				command: command ?? title,
				aggregated_output: "",
				...(typeof metadata?.exit === "number"
					? { exit_code: metadata.exit }
					: {}),
				status,
			} as ThreadItem
		}
		case "fetch":
			return {
				id,
				type: "command_execution",
				command: `webfetch ${url ?? title}`,
				aggregated_output: "",
				status,
			} as ThreadItem
		case "edit":
		case "delete":
		case "move":
			return {
				id,
				type: "file_change",
				changes: (paths.length ? paths : [title]).map(path => ({
					path,
					kind: "update",
				})),
				status,
			} as ThreadItem
		case "read":
			return {
				id,
				type: "tool",
				title: paths[0]
					? `Reading ${basename(paths[0])}`
					: "Reading a file",
				status,
			}
		case "search":
			return { id, type: "tool", title: "Looking through files", status }
		case "think":
			return { id, type: "tool", title: "Planning", status }
		default:
			// Writing its to-do list: the plan update shows the list itself.
			if (/^todo/i.test(title)) return null
			return {
				id,
				type: "tool",
				title: `Using ${title || "a tool"}`,
				status,
			}
	}
}
