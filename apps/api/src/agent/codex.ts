/**
 * Runs Codex turns on each person's own ChatGPT plan. Everyone signs in with their own account
 * (account.ts), and the login stays in their container, in Codex's own `auth.json`: Codex calls
 * the model and refreshes the login itself, so all of Codex works, sub-agents included.
 *
 * Each turn starts a `codex app-server` in the person's container (scripts/codex-docker.sh stands
 * in for the codex binary); unlike `codex exec` it takes more input mid-turn (steering) and stops
 * a turn cleanly (app-server.ts).
 */
import type { BotConfig } from "../config"
import {
	CODEX_DOCKER_WRAPPER,
	CONTAINER_WORKDIR,
	ensureContainer,
	stopRun,
} from "./containers"
import { AppServer, asThreadItem } from "./app-server"
import { NotSignedInError } from "./errors"
import { stepTracker } from "./steps"
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
	turnEnv as makeTurnEnv,
	type ModelOption,
	type TurnFile,
	type TurnOptions,
	type TurnResult,
	type TurnUser,
} from "./turn"

/** Config overrides as `-c key=value` arguments (values in TOML), nested keys dotted. */
function configArgs(config: Record<string, unknown>, prefix = ""): string[] {
	const toml = (value: unknown): string =>
		Array.isArray(value)
			? `[${value.map(toml).join(", ")}]`
			: typeof value === "string"
				? JSON.stringify(value)
				: String(value)
	return Object.entries(config).flatMap(([key, value]) => {
		if (value === undefined) return []
		const path = prefix ? `${prefix}.${key}` : key
		return value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
			? configArgs(value as Record<string, unknown>, path)
			: ["-c", `${path}=${toml(value)}`]
	})
}

/**
 * A Codex app-server in this person's container, initialized. `env` is the turn's (turnEnv());
 * its LADDU_TURN names the process, so stopRun() ends exactly this one.
 */
export async function openCodex(
	config: BotConfig,
	user: TurnUser,
	env: Record<string, string>,
	overrides: Record<string, unknown> = {},
): Promise<{ server: AppServer; container: string }> {
	const container = await ensureContainer(config, user.teamId, user.userId)
	const server = new AppServer(
		[CODEX_DOCKER_WRAPPER, "app-server", ...configArgs(overrides)],
		childEnv({ LADDU_CONTAINER: container, ...env }),
	)
	try {
		await Promise.race([
			server.request("initialize", {
				clientInfo: {
					name: "codex_sdk_ts",
					title: "laddu",
					version: "1",
				},
				capabilities: null,
			}),
			Bun.sleep(30_000).then(() => {
				throw new Error("Codex didn't start in time")
			}),
		])
		server.notify("initialized")
	} catch (error) {
		server.close()
		throw error
	}
	return { server, container }
}

/** A short-lived app-server for one question (models, account), closed after. */
export async function askCodex<T>(
	config: BotConfig,
	user: TurnUser,
	ask: (server: AppServer) => Promise<T>,
): Promise<T> {
	const { server } = await openCodex(config, user, {
		LADDU_TURN: `ask-${crypto.randomUUID().slice(0, 8)}`,
	})
	try {
		return await Promise.race([
			ask(server),
			Bun.sleep(20_000).then(() => {
				throw new Error("Codex didn't answer in time")
			}),
		])
	} finally {
		server.close()
	}
}

const MODELS_MS = 6 * 3600_000
const models = new Map<string, { list: Promise<ModelOption[]>; at: number }>()

/**
 * The models Codex offers this person, as `model/list` reports them for their plan (Codex
 * fetches the live list once they're signed in), cached for a few hours. Empty if it can't be read.
 */
export function listCodexModels(
	config: BotConfig,
	user: TurnUser,
): Promise<ModelOption[]> {
	const key = `${user.teamId}-${user.userId}`
	const cached = models.get(key)
	if (cached && Date.now() - cached.at < MODELS_MS) return cached.list
	const list = askCodex(config, user, async server => {
		const listed = await server.request<{
			data: Record<string, unknown>[]
		}>("model/list", {})
		return listed.data
			.filter(model => !model.hidden)
			.map(model => ({
				id: String(model.model ?? model.id),
				name: String(model.displayName ?? model.id),
				description: String(model.description ?? ""),
				efforts: (
					(model.supportedReasoningEfforts as {
						reasoningEffort: string
						description: string
					}[]) ?? []
				).map(effort => ({
					id: effort.reasoningEffort,
					description: effort.description,
				})),
				defaultEffort: String(model.defaultReasoningEffort ?? "medium"),
				fast: ((model.serviceTiers as unknown[]) ?? []).length > 0,
				images: true,
				...(model.isDefault ? { isDefault: true } : {}),
			}))
	}).catch(error => {
		console.warn("[codex] couldn't list models:", error)
		models.delete(key)
		return []
	})
	models.set(key, { list, at: Date.now() })
	return list
}

/** Forgets their model list (after they sign in or out, the plan's list may differ). */
export const forgetCodexModels = (user: TurnUser) =>
	models.delete(`${user.teamId}-${user.userId}`)

export async function runCodexTurn(options: TurnOptions): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, input, slack } = options
	const track = stepTracker(
		step => options.onStep?.(step),
		todos => options.onTodos?.(todos),
	)

	const turnId = newTurnId()
	const { server, container } = await openCodex(
		config,
		options.user,
		makeTurnEnv(turnId, options.user, slack),
		{
			...(config.fast ? { service_tier: "fast" } : {}),
			model_reasoning_effort: config.reasoningEffort,
			// Nobody is around to approve commands mid-turn.
			approval_policy: "never",
		},
	)
	// Closing the app-server only ends `docker exec` on the host; the run inside needs ending too.
	const stop = () => stopRun(container, turnId)
	let workspace: Awaited<ReturnType<typeof containerWorkspace>>
	try {
		const account = await server.request<{ account: unknown }>(
			"account/read",
			{},
		)
		if (!account.account) throw new NotSignedInError()
		workspace = await containerWorkspace(container, turnId)
		options.signal?.throwIfAborted()
	} catch (error) {
		server.close()
		await stop()
		throw error
	}
	const { saveFile, outbox, listOutbox } = workspace

	// The CLI reads image paths itself, so files must exist where it runs (inside the container).
	const attach = async (files: TurnFile[]) => {
		const { note, images } = await saveAttachments(files, saveFile, true)
		return {
			note,
			images: images.map(({ path }) => ({ type: "localImage", path })),
		}
	}
	const text = (value: string) => ({
		type: "text",
		text: value,
		text_elements: [],
	})

	let threadId = options.threadId ?? null
	let activeTurn: string | null = null
	let finished = false
	// Stopping: ask Codex to end the turn (it reports it as interrupted), then end the process.
	let stopping: Promise<void> | undefined
	const onAbort = () => {
		stopping = (async () => {
			if (threadId && activeTurn)
				await Promise.race([
					server.request("turn/interrupt", {
						threadId,
						turnId: activeTurn,
					}),
					Bun.sleep(3000),
				]).catch(() => {})
			server.close()
			await stop()
		})().catch(() => {})
	}
	options.signal?.addEventListener("abort", onAbort, { once: true })
	try {
		const threadParams = {
			// Unset: Codex's default model for their plan.
			...(config.model ? { model: config.model } : {}),
			cwd: CONTAINER_WORKDIR,
			// The container is the boundary (network is set on the container), so no nested sandbox.
			sandbox: "danger-full-access",
			approvalPolicy: "never",
		}
		const opened = await server.request<{ thread: { id: string } }>(
			options.threadId ? "thread/resume" : "thread/start",
			options.threadId
				? {
						threadId: options.threadId,
						...threadParams,
						excludeTurns: true,
					}
				: threadParams,
		)
		threadId = opened.thread.id
		options.signal?.throwIfAborted()

		// Loaded once per Codex thread, like a system prompt; resumed threads already have it.
		const memory = options.threadId
			? null
			: await loadMemory(() =>
					runTool(config, options.user, ["memory", "show"]),
				)
		const { note, images } = await attach(options.files ?? [])
		const recalled = memoryNote(memory)
		const notes = [note, outboxNote(outbox)].filter(Boolean)

		let answer = ""
		let lastError: string | null = null
		// Subscribed before the turn starts, so no event is missed.
		const outcome = new Promise<{ status: string; error: string | null }>(
			resolve => {
				server.listen(({ method, params }) => {
					if (
						params.threadId !== undefined &&
						params.threadId !== threadId
					)
						return
					switch (method) {
						case "item/started":
						case "item/completed": {
							const item = asThreadItem(
								params.item as Record<string, unknown>,
							)
							if (!item) return
							// The last message is the answer; earlier ones are notes before actions (see steps.ts).
							if (
								method === "item/completed" &&
								item.type === "agent_message"
							)
								answer = item.text
							track(item, method === "item/completed")
							return
						}
						case "turn/plan/updated": {
							const plan =
								(params.plan as
									| { step: string; status: string }[]
									| undefined) ?? []
							track(
								{
									type: "plan",
									title:
										typeof params.explanation === "string"
											? params.explanation
											: undefined,
									items: plan.map(todo => ({
										text: todo.step,
										status:
											todo.status === "completed"
												? "completed"
												: todo.status === "inProgress"
													? "in_progress"
													: "pending",
									})),
								},
								false,
							)
							return
						}
						case "error": {
							const message =
								(params.error as { message?: string })
									?.message ?? null
							// Also used for retry notices ("Reconnecting... 1/5"), which aren't the cause of
							// anything, unless it's a usage limit: Codex would retry it for minutes in silence.
							if (!params.willRetry) lastError = message
							else if (message && /usage limit/i.test(message)) {
								if (threadId && activeTurn)
									void server
										.request("turn/interrupt", {
											threadId,
											turnId: activeTurn,
										})
										.catch(() => {})
								resolve({ status: "failed", error: message })
							}
							return
						}
						case "turn/completed": {
							const turn = params.turn as {
								id: string
								status: string
								error: { message: string } | null
							}
							if (activeTurn && turn.id !== activeTurn) return
							resolve({
								status: turn.status,
								error: turn.error?.message ?? null,
							})
						}
					}
				})
			},
		)
		const started = await server.request<{ turn: { id: string } }>(
			"turn/start",
			{
				threadId,
				input: [
					text(
						[recalled, input, ...notes]
							.filter(Boolean)
							.join("\n\n"),
					),
					...images,
				],
			},
		)
		activeTurn = started.turn.id
		options.onSteerable?.(async (more, files = []) => {
			if (finished || options.signal?.aborted) return false
			try {
				const { note, images } = await attach(files)
				if (finished) return false
				await server.request("turn/steer", {
					threadId,
					expectedTurnId: activeTurn,
					input: [
						text([more, note].filter(Boolean).join("\n\n")),
						...images,
					],
				})
				return true
			} catch (error) {
				console.warn("[codex] couldn't steer the turn:", error)
				return false
			}
		})

		const ended = await Promise.race([
			outcome,
			server.exited.then(() => null),
		])
		finished = true
		options.onSteerable?.(null)
		options.signal?.throwIfAborted()
		if (!ended)
			throw new Error(
				lastError ?? "Codex stopped before finishing the turn",
			)
		if (ended.status === "failed")
			throw new Error(ended.error ?? lastError ?? "Codex failed the turn")
		if (ended.status !== "completed")
			throw new Error(
				ended.error ?? `Codex ended the turn (${ended.status})`,
			)
		const { files, skipped } = await collectOutbox(await listOutbox())
		return {
			threadId,
			text:
				answer ||
				(files.length ? "" : "_(Codex finished without a reply.)_"),
			files,
			skipped,
		}
	} finally {
		finished = true
		options.onSteerable?.(null)
		options.signal?.removeEventListener("abort", onAbort)
		await stopping
		server.close()
	}
}
