/**
 * A Codex app-server, one per turn: JSON-RPC over the child's stdio, one JSON object per line.
 * Unlike `codex exec`, it takes more input while a turn runs (`turn/steer`) and ends a turn
 * cleanly (`turn/interrupt`). The protocol is Codex's own (`codex app-server generate-ts`); only
 * the parts laddu uses are typed here.
 */
import type { ThreadItem } from "@openai/codex-sdk"

type Incoming = {
	id?: number | string
	method?: string
	params?: unknown
	result?: unknown
	error?: { code: number; message: string }
}

export type Notification = { method: string; params: Record<string, unknown> }

export class AppServer {
	private child: Bun.Subprocess<"pipe", "pipe", "pipe">
	private nextId = 1
	private pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>()
	private listeners = new Set<(notification: Notification) => void>()
	private stderr = ""
	/** Resolves when the process ends; pending requests fail then. */
	readonly exited: Promise<number>

	constructor(command: string[], env: Record<string, string>) {
		this.child = Bun.spawn(command, {
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})
		void this.readLines()
		void this.readStderr()
		this.exited = this.child.exited.then(code => {
			const error = new Error(
				`Codex app-server exited (${code})${this.stderr ? `: ${this.stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`,
			)
			for (const { reject } of this.pending.values()) reject(error)
			this.pending.clear()
			return code
		})
	}

	request<T>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++
		const result = new Promise<T>((resolve, reject) =>
			this.pending.set(id, {
				resolve: value => resolve(value as T),
				reject,
			}),
		)
		this.send({ id, method, params })
		return result
	}

	notify(method: string, params?: unknown) {
		this.send(params === undefined ? { method } : { method, params })
	}

	/** Every notification; returns a function that stops listening. */
	listen(listener: (notification: Notification) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	close() {
		this.child.kill()
	}

	private send(message: object) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`)
		this.child.stdin.flush()
	}

	private async readLines() {
		let rest = ""
		const decoder = new TextDecoder()
		for await (const chunk of this.child.stdout) {
			rest += decoder.decode(chunk, { stream: true })
			const lines = rest.split("\n")
			rest = lines.pop() ?? ""
			for (const line of lines) if (line.trim()) this.receive(line)
		}
	}

	private async readStderr() {
		const decoder = new TextDecoder()
		for await (const chunk of this.child.stderr)
			// Kept short: only the end matters, for the exit error.
			this.stderr = (this.stderr + decoder.decode(chunk)).slice(-4000)
	}

	private receive(line: string) {
		let message: Incoming
		try {
			message = JSON.parse(line)
		} catch {
			return
		}
		if (message.method !== undefined && message.id !== undefined) {
			const result = approve(
				message.method,
				(message.params ?? {}) as Record<string, unknown>,
			)
			this.send(
				result === undefined
					? {
							id: message.id,
							error: { code: -32601, message: "not supported by laddu" },
						}
					: { id: message.id, result },
			)
			return
		}
		if (message.method !== undefined) {
			const notification = {
				method: message.method,
				params: (message.params ?? {}) as Record<string, unknown>,
			}
			for (const listener of this.listeners) listener(notification)
			return
		}
		const waiting = this.pending.get(Number(message.id))
		if (!waiting) return
		this.pending.delete(Number(message.id))
		if (message.error) waiting.reject(new Error(message.error.message))
		else waiting.resolve(message.result)
	}
}

/**
 * Its requests to us. laddu has full access, so every approval is granted (the thread asks for
 * none, "never", but MCP tools can still ask to confirm a call). Questions for the person get no
 * answer (undefined): nobody is there mid-turn.
 */
function approve(method: string, params: Record<string, unknown>): unknown {
	switch (method) {
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			return { decision: "accept" }
		case "execCommandApproval":
		case "applyPatchApproval":
			return { decision: "approved" }
		case "item/permissions/requestApproval": {
			const asked = (params.permissions ?? {}) as Record<string, unknown>
			return {
				permissions: Object.fromEntries(
					Object.entries(asked).filter(([, value]) => value != null),
				),
				scope: "turn",
			}
		}
		case "mcpServer/elicitation/request":
			return { action: "accept", content: {}, _meta: null }
	}
}

/** The app-server's camelCase status, as the SDK's (which steps.ts reads). */
const status = (value: unknown) =>
	value === "inProgress"
		? "in_progress"
		: value === "completed"
			? "completed"
			: "failed"

/** An app-server item as the SDK's ThreadItem, for the step tracker; null for kinds it ignores. */
export function asThreadItem(item: Record<string, unknown>): ThreadItem | null {
	const id = String(item.id)
	switch (item.type) {
		case "agentMessage":
			return { id, type: "agent_message", text: String(item.text ?? "") }
		case "reasoning":
			return {
				id,
				type: "reasoning",
				text: ((item.summary as string[] | undefined) ?? []).join("\n"),
			}
		case "commandExecution":
			return {
				id,
				type: "command_execution",
				command: String(item.command ?? ""),
				aggregated_output: String(item.aggregatedOutput ?? ""),
				exit_code: (item.exitCode as number | null) ?? undefined,
				status: status(item.status) as "in_progress" | "completed" | "failed",
			}
		case "fileChange":
			return {
				id,
				type: "file_change",
				changes: (
					(item.changes as { path: string; kind: { type: string } }[]) ?? []
				).map(change => ({
					path: change.path,
					kind: change.kind.type as "add" | "delete" | "update",
				})),
				status: item.status === "completed" ? "completed" : "failed",
			}
		case "mcpToolCall":
			return {
				id,
				type: "mcp_tool_call",
				server: String(item.server ?? ""),
				tool: String(item.tool ?? ""),
				arguments: item.arguments,
				status: status(item.status) as "in_progress" | "completed" | "failed",
			}
		case "webSearch":
			return { id, type: "web_search", query: String(item.query ?? "") }
		default:
			return null
	}
}
