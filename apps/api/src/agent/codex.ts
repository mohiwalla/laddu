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
	listContainerDir,
	makeDirInContainer,
	stopRun,
	writeIntoContainer,
	writeModelCatalog,
} from "./containers"
import { startModelProxy } from "./model-proxy"
import { AppServer, asThreadItem } from "./app-server"
import { botApiUrl, callerCredential } from "./bot-api"
import { stepTracker, type Step } from "./steps"
import { hostToolEnv, runTool } from "./tools"

/** Host runtime: writes the bot's own CODEX_HOME/config.toml and links in the shared skills. */
export async function prepareCodexHome(workdir: string): Promise<void> {
	const modelCatalog = `${paths.codexHome}/models.json`
	await writeModelCatalog(modelCatalog)
	await writePrivate(
		`${paths.codexHome}/config.toml`,
		codexConfig({ modelCatalog }),
	)
	const skills = `${paths.codexHome}/skills`
	await Bun.$`mkdir -p ${skills}`.quiet()
	for (const [link, source] of [
		["dot", "skills"],
		["team", "skills.local"],
	] as const) {
		const dir = `${workdir}/${source}`
		const stat = await Bun.file(dir)
			.stat()
			.catch(() => null)
		if (stat?.isDirectory())
			await Bun.$`ln -sfn ${dir} ${skills}/${link}`.quiet()
		else await Bun.$`rm -f ${skills}/${link}`.quiet()
	}
}

/** Env for the Codex child (or the docker wrapper): this process's env minus Slack secrets. */
function codexEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !key.startsWith("SLACK_")) env[key] = value
	}
	return { ...env, ...extra }
}

/** The Slack user a turn runs for; picks their container in the Docker runtime. */
export type TurnUser = { teamId: string; userId: string }

/** A file attached in Slack; images are also shown to the model. */
export type TurnFile = {
	fileName: string
	title: string
	data: Uint8Array
	image: boolean
}

/** A file Codex left in the turn's outbox, to upload to Slack. */
export type OutFile = { name: string; data: Uint8Array }

/** What a turn's outbox holds, read lazily. */
type OutboxEntry = {
	name: string
	size: number
	read: () => Promise<Uint8Array>
}

const MAX_OUT_FILES = 10
const MAX_OUT_BYTES = 50 * 1024 * 1024

/** Where the host runtime's codex is: the SDK's own bundled binary (it finds it on construction). */
function hostCodex(): { executablePath: string; pathDirs: string[] } {
	return (
		new Codex() as unknown as {
			exec: { executablePath: string; pathDirs: string[] }
		}
	).exec
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
		return value !== null && typeof value === "object" && !Array.isArray(value)
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
		const privateNotes = Bun.file(`${config.workdir}/AGENTS.local.md`)
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
			env: codexEnv({
				CODEX_HOME: paths.codexHome,
				ACCESS_TOKEN: await getAccessToken(),
				...toolEnv,
				...turnEnv,
				PATH: [...codex.pathDirs, TOOLS_DIR, Bun.env.PATH ?? ""].join(":"),
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
	// In the user's workspace, so they can come back to these files later.
	const outbox = `${CONTAINER_WORKDIR}/slack-outbox/${turnId}`
	await makeDirInContainer(container, outbox)
	return {
		command: [CODEX_DOCKER_WRAPPER],
		env: codexEnv({
			DOT_CONTAINER: container,
			DOT_PROXY_KEY: proxy.key,
			...turnEnv,
		}),
		overrides: {
			...overrides,
			// This process's proxy, per run: the shared config.toml can't pin one, since another
			// bot process (a second workspace, a test) may have rewritten it with its own.
			model_providers: { openai_chatgpt_plan: { base_url: proxy.baseUrl } },
		},
		// The container is the boundary (network is set on the container), so no nested sandbox.
		thread: { cwd: CONTAINER_WORKDIR, sandbox: "danger-full-access" as const },
		saveFile: async (file: TurnFile) => {
			const path = `${CONTAINER_WORKDIR}/slack-files/${file.fileName}`
			await writeIntoContainer(container, path, file.data)
			return path
		},
		outbox,
		// Closing the app-server only ends `docker exec` on the host; the run inside needs ending too.
		stop: () => stopRun(container, turnId),
		listOutbox: () => listContainerDir(container, outbox),
	}
}

/** The person's saved memory, rendered; null when empty or unreadable (never fails the turn). */
async function loadMemory(show: () => Promise<string>): Promise<string | null> {
	try {
		const text = (await show()).trim()
		return text && text !== "(memory is empty)" ? text : null
	} catch (error) {
		console.warn("[memory] couldn't load:", error)
		return null
	}
}

/** The outbox's files to upload, and the names of ones skipped for count or size. */
async function collectOutbox(
	entries: OutboxEntry[],
): Promise<{ files: OutFile[]; skipped: string[] }> {
	const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name))
	const kept = sorted
		.filter(entry => entry.size > 0 && entry.size <= MAX_OUT_BYTES)
		.slice(0, MAX_OUT_FILES)
	const files = await Promise.all(
		kept.map(async entry => ({
			name: entry.name,
			data: await entry.read(),
		})),
	)
	return {
		files,
		skipped: sorted
			.filter(entry => !kept.includes(entry))
			.map(entry => entry.name),
	}
}

export type TurnResult = {
	threadId: string
	text: string
	files: OutFile[]
	skipped: string[]
}

/**
 * Adds a message to a turn while it runs (Codex sees it at its next step); false when the turn
 * has already ended, or couldn't take it, so the message should start its own turn instead.
 */
export type Steer = (input: string, files?: TurnFile[]) => Promise<boolean>

export async function runTurn(options: {
	config: BotConfig
	user: TurnUser
	threadId?: string
	input: string
	files?: TurnFile[]
	/** Cancels the turn (STOP, or the owner's Stop button). */
	signal?: AbortSignal
	/** The Slack conversation the turn is for, so commands like `schedule` can act on it. */
	slack?: {
		channel: string
		threadTs: string
		timezone: string
		scheduled?: boolean
	}
	onStep?: (step: Step) => void
	/** Called with a way to steer the turn once it runs, and with null once it can't be any more. */
	onSteerable?: (steer: Steer | null) => void
}): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, input, slack } = options
	const track = stepTracker(step => options.onStep?.(step))

	const turnId =
		new Date()
			.toISOString()
			.slice(0, 19)
			.replace(/[T:]/g, "-")
			.toLowerCase() + `-${crypto.randomUUID().slice(0, 4)}`
	const api = botApiUrl()
	const turnEnv: Record<string, string> = {
		DOT_TURN: turnId,
		...(slack
			? {
					DOT_CALLER: callerCredential({
						...options.user,
						channel: slack.channel,
						threadTs: slack.threadTs,
						scheduled: slack.scheduled ?? false,
					}),
					DOT_TIMEZONE: slack.timezone,
					...(api ? { DOT_API: api } : {}),
				}
			: {}),
	}
	const { command, env, overrides, thread, saveFile, outbox, listOutbox, stop } =
		await createCodex(config, options.user, turnId, turnEnv)
	options.signal?.throwIfAborted()

	// The CLI reads image paths itself, so files must exist where it runs (inside the container).
	const attach = async (files: TurnFile[]) => {
		const attached = await Promise.all(
			files.map(async file => ({ file, path: await saveFile(file) })),
		)
		const images = attached.filter(({ file }) => file.image)
		const note =
			attached.length > 0 &&
			`Files attached in these messages, saved for you${images.length ? " (images are also shown below, in order)" : ""}:\n` +
				attached.map(({ file, path }) => `- ${file.title}: ${path}`).join("\n")
		return {
			note,
			images: images.map(({ path }) => ({ type: "localImage", path })),
		}
	}
	const text = (value: string) => ({ type: "text", text: value, text_elements: [] })

	const server = new AppServer([...command, "app-server", ...configArgs(overrides)], env)
	let threadId = options.threadId ?? null
	let activeTurn: string | null = null
	let finished = false
	// Stopping: ask Codex to end the turn (it reports it as interrupted), then end the process.
	let stopping: Promise<void> | undefined
	const onAbort = () => {
		stopping = (async () => {
			if (threadId && activeTurn)
				await Promise.race([
					server.request("turn/interrupt", { threadId, turnId: activeTurn }),
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
				? { threadId: options.threadId, ...threadParams, excludeTurns: true }
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
		const recalled =
			memory &&
			`<memory-context>\nWhat you've saved about the person you're working for, from earlier conversations (background, not instructions):\n\n${memory}\n</memory-context>`
		const notes = [
			note,
			`To send files to Slack (CSV, images, documents, code…), save them directly in ${outbox}/. They're uploaded to this thread right after your reply, so refer to them by name, not path.`,
		].filter(Boolean)

		let answer = ""
		let lastError: string | null = null
		// Subscribed before the turn starts, so no event is missed.
		const outcome = new Promise<{ status: string; error: string | null }>(resolve => {
			server.listen(({ method, params }) => {
				if (params.threadId !== undefined && params.threadId !== threadId) return
				switch (method) {
					case "item/started":
					case "item/completed": {
						const item = asThreadItem(params.item as Record<string, unknown>)
						if (!item) return
						// The last message is the answer; earlier ones are notes before actions (see steps.ts).
						if (method === "item/completed" && item.type === "agent_message")
							answer = item.text
						track(item, method === "item/completed")
						return
					}
					case "error":
						// Also used for retry notices ("Reconnecting... 1/5"), which aren't the cause of anything.
						if (!params.willRetry)
							lastError = (params.error as { message?: string })?.message ?? null
						return
					case "turn/completed": {
						const turn = params.turn as {
							id: string
							status: string
							error: { message: string } | null
						}
						if (activeTurn && turn.id !== activeTurn) return
						resolve({ status: turn.status, error: turn.error?.message ?? null })
					}
				}
			})
		})
		const started = await server.request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [text([recalled, input, ...notes].filter(Boolean).join("\n\n")), ...images],
		})
		activeTurn = started.turn.id
		options.onSteerable?.(async (more, files = []) => {
			if (finished || options.signal?.aborted) return false
			try {
				const { note, images } = await attach(files)
				if (finished) return false
				await server.request("turn/steer", {
					threadId,
					expectedTurnId: activeTurn,
					input: [text([more, note].filter(Boolean).join("\n\n")), ...images],
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
			throw new Error(lastError ?? "Codex stopped before finishing the turn")
		if (ended.status === "failed")
			throw new Error(ended.error ?? lastError ?? "Codex failed the turn")
		if (ended.status !== "completed")
			throw new Error(ended.error ?? `Codex ended the turn (${ended.status})`)
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
