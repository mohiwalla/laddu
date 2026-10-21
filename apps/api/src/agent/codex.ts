/**
 * Runs Codex turns billed to the owner's ChatGPT plan via Sign in with ChatGPT.
 *
 * Each turn spawns a `codex app-server` with a freshly refreshed access token, so token renewal
 * needs no long-lived process; the app-server, unlike `codex exec`, takes more input mid-turn
 * (steering) and stops a turn cleanly (app-server.ts). Provider setup follows
 * https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
 *
 * Docker runtime (default): scripts/codex-docker.sh is run instead of codex, which runs codex
 * inside the requesting user's container. Host runtime: codex runs here.
 */
import { Codex } from "@openai/codex-sdk"
import type { BotConfig } from "../config"
import { paths } from "../config"
import { getAccessToken } from "../auth/siwc"
import { writePrivate } from "../files"
import { codexConfig } from "./codex-config"
import {
	CODEX_DOCKER_WRAPPER,
	CONTAINER_WORKDIR,
	TOOLS_DIR,
	ensureContainer,
	stopRun,
	writeModelCatalog,
} from "./containers"
import { startModelProxy } from "./model-proxy"
import { AppServer, asThreadItem } from "./app-server"
import { stepTracker } from "./steps"
import { hostToolEnv, runTool } from "./tools"
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
	type OutboxEntry,
	type TurnFile,
	type TurnOptions,
	type TurnResult,
	type TurnUser,
} from "./turn"

/** Host runtime: writes the bot's own CODEX_HOME/config.toml and links in the shared skills. */
export async function prepareCodexHome(
	workdir: string,
	localDir: string,
): Promise<void> {
	const modelCatalog = `${paths.codexHome}/models.json`
	await writeModelCatalog(modelCatalog)
	await writePrivate(
		`${paths.codexHome}/config.toml`,
		codexConfig({ modelCatalog }),
	)
	const skills = `${paths.codexHome}/skills`
	await Bun.$`mkdir -p ${skills}`.quiet()
	for (const [link, dir] of [
		["dot", `${workdir}/skills`],
		["team", `${localDir}/skills.local`],
	] as const) {
		const stat = await Bun.file(dir)
			.stat()
			.catch(() => null)
		if (stat?.isDirectory())
			await Bun.$`ln -sfn ${dir} ${skills}/${link}`.quiet()
		else await Bun.$`rm -f ${skills}/${link}`.quiet()
	}
}

/** Where the host runtime's codex is: the SDK's own bundled binary (it finds it on construction). */
function hostCodex(): { executablePath: string; pathDirs: string[] } {
	return (
		new Codex() as unknown as {
			exec: { executablePath: string; pathDirs: string[] }
		}
	).exec
}

let catalog: { models: Promise<ModelOption[]>; at: number } | null = null
const CATALOG_MS = 6 * 3600_000

/**
 * The models Codex offers, as `model/list` reports them (its built-in catalog, the same version
 * as the containers'), cached for a few hours. Empty if it can't be read.
 */
export function listCodexModels(): Promise<ModelOption[]> {
	if (catalog && Date.now() - catalog.at < CATALOG_MS) return catalog.models
	const models = (async () => {
		const home = (await Bun.$`mktemp -d`.text()).trim()
		const codex = hostCodex()
		const server = new AppServer(
			[codex.executablePath, "app-server"],
			childEnv({
				CODEX_HOME: home,
				PATH: [...codex.pathDirs, Bun.env.PATH ?? ""].join(":"),
			}),
		)
		try {
			await server.request("initialize", {
				clientInfo: {
					name: "codex_sdk_ts",
					title: "dot",
					version: "1",
				},
				capabilities: null,
			})
			server.notify("initialized")
			const listed = await Promise.race([
				server.request<{ data: Record<string, unknown>[] }>(
					"model/list",
					{},
				),
				Bun.sleep(15_000).then(() => {
					throw new Error("model/list timed out")
				}),
			])
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
					)
						// "ultra" hands work to sub-agents, which dot switches off (writeModelCatalog).
						.filter(effort => effort.reasoningEffort !== "ultra")
						.map(effort => ({
							id: effort.reasoningEffort,
							description: effort.description,
						})),
					defaultEffort: String(
						model.defaultReasoningEffort ?? "medium",
					),
					fast: ((model.serviceTiers as unknown[]) ?? []).length > 0,
					images: true,
				}))
		} finally {
			server.close()
			await Bun.$`rm -rf ${home}`.quiet().nothrow()
		}
	})().catch(error => {
		console.warn("[codex] couldn't list models:", error)
		catalog = null
		return []
	})
	catalog = { models, at: Date.now() }
	return models
}

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

/** Attachments are saved under `slack-files/`, the turn's outbox is `slack-outbox/<turn>/`. */
async function createCodex(
	config: BotConfig,
	user: TurnUser,
	turnId: string,
	turnEnv: Record<string, string>,
) {
	// Passed to every codex run as `-c` overrides.
	const overrides: Record<string, unknown> = {
		...(config.fast ? { service_tier: "fast" } : {}),
		model_reasoning_effort: config.reasoningEffort,
		// Nobody is around to approve commands mid-turn.
		approval_policy: "never",
	}
	if (config.runtime === "host") {
		// Outside the workdir, which is the persona folder.
		const owner = `${user.teamId}-${user.userId}`
		const outbox = `${paths.dataDir}/slack-outbox/${owner}/${turnId}`
		const toolEnv = hostToolEnv(user)
		// Codex reads the persona from the workdir; the private additions go in as its global
		// instructions (CODEX_HOME/AGENTS.md), refreshed each turn like the persona.
		const privateNotes = Bun.file(`${config.localDir}/AGENTS.local.md`)
		if (await privateNotes.exists())
			await writePrivate(
				`${paths.codexHome}/AGENTS.md`,
				await privateNotes.text(),
			)
		else
			await Bun.file(`${paths.codexHome}/AGENTS.md`)
				.delete()
				.catch(() => {})
		await Bun.$`mkdir -p ${outbox} ${toolEnv.DOT_MEMORY_DIR} ${toolEnv.DOT_HISTORY_DIR} ${toolEnv.DOT_CODE_DIR}`.quiet()
		const codex = hostCodex()
		return {
			command: [codex.executablePath],
			env: childEnv({
				CODEX_HOME: paths.codexHome,
				ACCESS_TOKEN: await getAccessToken(),
				...toolEnv,
				...turnEnv,
				PATH: [...codex.pathDirs, TOOLS_DIR, Bun.env.PATH ?? ""].join(
					":",
				),
			}),
			overrides: {
				...overrides,
				sandbox_workspace_write: {
					network_access: config.network,
					writable_roots: [
						outbox,
						toolEnv.DOT_MEMORY_DIR,
						toolEnv.DOT_HISTORY_DIR,
						toolEnv.DOT_CODE_DIR,
					],
				},
			},
			thread: { cwd: config.workdir, sandbox: config.sandbox },
			saveFile: async (file: TurnFile) => {
				const path = `${paths.dataDir}/slack-files/${owner}/${file.fileName}`
				await Bun.write(path, file.data, { createPath: true })
				return path
			},
			outbox,
			// Closing the app-server ends codex itself.
			stop: async () => {},
			listOutbox: async (): Promise<OutboxEntry[]> => {
				const names = await Array.fromAsync(
					new Bun.Glob("*").scan({ cwd: outbox, onlyFiles: true }),
				)
				return names.map(name => {
					const file = Bun.file(`${outbox}/${name}`)
					return { name, size: file.size, read: () => file.bytes() }
				})
			},
		}
	}

	const [container, proxy] = await Promise.all([
		ensureContainer(config, user.teamId, user.userId),
		startModelProxy(),
	])
	const workspace = await containerWorkspace(container, turnId)
	return {
		...workspace,
		command: [CODEX_DOCKER_WRAPPER],
		env: childEnv({
			DOT_CONTAINER: container,
			DOT_PROXY_KEY: proxy.key,
			...turnEnv,
		}),
		overrides: {
			...overrides,
			// This process's proxy, per run: the shared config.toml can't pin one, since another
			// bot process (a second workspace, a test) may have rewritten it with its own.
			model_providers: {
				openai_chatgpt_plan: { base_url: proxy.baseUrl },
			},
		},
		// The container is the boundary (network is set on the container), so no nested sandbox.
		thread: {
			cwd: CONTAINER_WORKDIR,
			sandbox: "danger-full-access" as const,
		},
		// Closing the app-server only ends `docker exec` on the host; the run inside needs ending too.
		stop: () => stopRun(container, turnId),
	}
}

export async function runCodexTurn(options: TurnOptions): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, input, slack } = options
	const track = stepTracker(step => options.onStep?.(step))

	const turnId = newTurnId()
	const turnEnv = makeTurnEnv(turnId, options.user, slack)
	const {
		command,
		env,
		overrides,
		thread,
		saveFile,
		outbox,
		listOutbox,
		stop,
	} = await createCodex(config, options.user, turnId, turnEnv)
	options.signal?.throwIfAborted()

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

	const server = new AppServer(
		[...command, "app-server", ...configArgs(overrides)],
		env,
	)
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
		await server.request("initialize", {
			clientInfo: { name: "codex_sdk_ts", title: "dot", version: "1" },
			capabilities: null,
		})
		server.notify("initialized")
		const threadParams = {
			model: config.model,
			cwd: thread.cwd,
			sandbox: thread.sandbox,
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
						case "error":
							// Also used for retry notices ("Reconnecting... 1/5"), which aren't the cause of anything.
							if (!params.willRetry)
								lastError =
									(params.error as { message?: string })
										?.message ?? null
							return
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
