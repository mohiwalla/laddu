/**
 * Google Antigravity CLI (`agy`) as laddu's agent, on each person's own Google account (or their
 * own Gemini API key). It's Google's own `agy`, unmodified, run over ACP inside the person's
 * container (scripts/agy-docker.sh, acp.ts) with the same persona, commands, skills and computer
 * as Codex.
 *
 * Sign-in uses `agy acp --login` (paste-code OAuth): the person signs in in their own browser,
 * copies the code (or callback URL) Antigravity shows, and pastes it in the Connect Antigravity
 * form (slack/home.ts). `agy` exchanges it and keeps the login in their container; laddu keeps
 * nothing. Or they bring a Gemini API key (`GEMINI_API_KEY` in `connections`).
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { sendNotice, systemName, type Where } from "../slack/system"
import {
	AuthRequiredError,
	logoutAcp,
	probeAcpSession,
	runAcpTurn,
	type AcpContentBlock,
	type AcpMcpServer,
	type AcpSessionInfo,
} from "./acp"
import {
	AGY_DOCKER_WRAPPER,
	CONTAINER_TOOLS_DIR,
	CONTAINER_WORKDIR,
	ensureContainer,
	stopRun,
} from "./containers"
import { AgyLimitError, NotSignedInError } from "./errors"
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
	turnEnv,
	type ModelOption,
	type TurnFile,
	type TurnOptions,
	type TurnResult,
	type TurnUser,
} from "./turn"

type WebClient = App["client"]

/** The API key Antigravity takes instead of a Google account, as `connections` keeps it. */
export const AGY_KEY = "GEMINI_API_KEY"

const ACP_ARGS = [
	"acp",
	"--dangerously-skip-permissions",
	"--disable-telemetry",
]

const key = (user: TurnUser) => `${user.teamId}-${user.userId}`

// ---- account ---------------------------------------------------------------------------------

export type AgyAccount = {
	/** Their Google account (OAuth), or their Gemini API key. */
	method: "plan" | "key"
	email: string | null
}

const ACCOUNT_MS = 10 * 60_000
const accounts = new Map<
	string,
	{ account: Promise<AgyAccount | null>; at: number }
>()

const MODELS_MS = 6 * 3600_000
const models = new Map<string, { list: Promise<ModelOption[]>; at: number }>()

/** Checks quickly inside the container whether an OAuth token or GEMINI_API_KEY is stored. */
async function storedCredentials(container: string): Promise<{
	oauth: boolean
	key: boolean
	email: string | null
}> {
	const out =
		await Bun.$`docker exec ${container} sh -c ${'oauth=0; [ -s "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] && oauth=1; key=0; [ -s "$HOME/.laddu/keys/GEMINI_API_KEY" ] && key=1; email=""; if [ -f "$HOME/.gemini/google_accounts.json" ]; then email="$(jq -r ".active // empty" "$HOME/.gemini/google_accounts.json" 2>/dev/null || true)"; fi; printf "%s %s %s\n" "$oauth" "$key" "$email"'}`
			.quiet()
			.nothrow()
			.text()
	const [oauth, hasKey, ...rest] = out.trim().split(" ")
	const email = rest.join(" ").trim() || null
	return { oauth: oauth === "1", key: hasKey === "1", email }
}

/** How they're connected to Antigravity, or null; cached for a few minutes. */
export function agyAccount(
	config: BotConfig,
	user: TurnUser,
): Promise<AgyAccount | null> {
	const cached = accounts.get(key(user))
	if (cached && Date.now() - cached.at < ACCOUNT_MS) return cached.account
	const account = (async (): Promise<AgyAccount | null> => {
		const container = await ensureContainer(
			config,
			user.teamId,
			user.userId,
		)
		const stored = await storedCredentials(container)
		if (!stored.oauth && !stored.key) return null
		if (stored.oauth) {
			const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
			try {
				const session = await probeAcpSession({
					command: [AGY_DOCKER_WRAPPER, ...ACP_ARGS],
					env: childEnv({
						LADDU_CONTAINER: container,
						LADDU_TURN: turnId,
					}),
					cwd: CONTAINER_WORKDIR,
					stop: () => stopRun(container, turnId),
				})
				const parsed = parseAgyModels(session)
				if (parsed.length)
					models.set(key(user), {
						list: Promise.resolve(parsed),
						at: Date.now(),
					})
				return { method: "plan", email: stored.email }
			} catch (error) {
				if (!(error instanceof AuthRequiredError)) throw error
				if (!stored.key) return null
			}
		}
		return stored.key ? { method: "key", email: null } : null
	})()
	accounts.set(key(user), { account, at: Date.now() })
	account.catch(() => accounts.delete(key(user)))
	return account
}

/** Forgets what's cached about their Antigravity connection (after it changes). */
export function forgetAgy(user: TurnUser) {
	accounts.delete(key(user))
	models.delete(key(user))
}

/** A sign-in waiting in their container: its link, and where the code they paste goes. */
type SignIn = {
	link: string
	/** Hands Antigravity the code (or callback URL); true once it's signed them in. */
	paste: (code: string) => Promise<boolean>
	stop: () => Promise<void>
}

/** Sign-ins waiting for the person, by person. */
const signingIn = new Map<string, Promise<SignIn>>()
/** Live sign-in processes (waiting or exchanging a pasted code), so Disconnect can stop them. */
const activeSignIns = new Map<string, Set<() => Promise<void>>>()
/** Incremented on sign-out/reconnect so an in-flight sign-in cannot restore credentials. */
const signInEpoch = new Map<string, number>()

async function cancelAgySignIn(user: TurnUser): Promise<void> {
	const id = key(user)
	signInEpoch.set(id, (signInEpoch.get(id) ?? 0) + 1)
	const waiting = signingIn.get(id)
	signingIn.delete(id)
	const active = [...(activeSignIns.get(id) ?? [])]
	await Promise.all([
		...active.map(abort => abort().catch(() => {})),
		waiting?.then(
			signIn => signIn.stop().catch(() => {}),
			() => {},
		),
	])
}

/** They connected another way (their Gemini API key): a sign-in still waiting ends quietly. */
export async function connectedAgy(user: TurnUser): Promise<void> {
	await cancelAgySignIn(user)
	forgetAgy(user)
}

/** How long a sign-in waits for them. */
const SIGN_IN_MINUTES = 15

/**
 * Antigravity's own paste-code sign-in (`agy acp --login`): runs in their container and gives the
 * Google OAuth sign-in link (the one waiting already, if there is one). They sign in in their own
 * browser, copy the code or redirect URL Antigravity shows, and paste it in the Connect Antigravity
 * form (slack/home.ts), which goes straight to `agy`'s prompt. laddu keeps nothing.
 */
export function agySignIn(config: BotConfig, user: TurnUser): Promise<SignIn> {
	const id = key(user)
	const waiting = signingIn.get(id)
	if (waiting) return waiting
	const epoch = signInEpoch.get(id) ?? 0
	const started = (async (): Promise<SignIn> => {
		const turnId = `signin-${crypto.randomUUID().slice(0, 8)}`
		const container = await ensureContainer(
			config,
			user.teamId,
			user.userId,
		)
		if ((signInEpoch.get(id) ?? 0) !== epoch)
			throw new Error("Antigravity sign-in was cancelled")
		const proc = Bun.spawn([AGY_DOCKER_WRAPPER, "acp", "--login"], {
			env: childEnv({ LADDU_CONTAINER: container, LADDU_TURN: turnId }),
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
		let cancelled = false
		let expiry: ReturnType<typeof setTimeout> | undefined
		let stopPromise: Promise<void> | undefined
		const stop = () => {
			stopPromise ??= (async () => {
				cancelled = true
				clearTimeout(expiry)
				if (signingIn.get(id) === started) signingIn.delete(id)
				proc.kill()
				await stopRun(container, turnId).catch(() => {})
				await proc.exited.catch(() => {})
			})()
			return stopPromise
		}
		const track = activeSignIns.get(id) ?? new Set()
		activeSignIns.set(id, track)
		track.add(stop)
		const untrack = () => {
			track.delete(stop)
			if (track.size === 0 && activeSignIns.get(id) === track)
				activeSignIns.delete(id)
		}
		expiry = setTimeout(() => {
			void stop().finally(untrack)
		}, SIGN_IN_MINUTES * 60_000)
		try {
			const link = await agySignInLink(proc.stdout)
			if (cancelled || (signInEpoch.get(id) ?? 0) !== epoch)
				throw new Error("Antigravity sign-in was cancelled")
			return {
				link,
				paste: async code => {
					if (signingIn.get(id) === started) signingIn.delete(id)
					if (cancelled || (signInEpoch.get(id) ?? 0) !== epoch) {
						await stop()
						untrack()
						return false
					}
					clearTimeout(expiry)
					try {
						try {
							proc.stdin.write(`${code}\n`)
							await proc.stdin.flush()
							proc.stdin.end()
						} catch {
							await stop()
							forgetAgy(user)
							return false
						}
						const exit = await Promise.race([
							proc.exited,
							Bun.sleep(30_000).then(() => null),
						])
						const aborted =
							cancelled || (signInEpoch.get(id) ?? 0) !== epoch
						await stop()
						forgetAgy(user)
						if (aborted) return false
						if (exit !== 0)
							console.warn(
								`[agy] sign-in ${exit === null ? "didn't finish in time" : `ended with exit ${exit}`}: ${stderr.trim().slice(-300)}`,
							)
						return exit === 0
					} finally {
						untrack()
					}
				},
				stop: async () => {
					await stop()
					untrack()
				},
			}
		} catch (error) {
			await stop()
			untrack()
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
 * Connect Antigravity, which opens the form (slack/home.ts), and the API key option.
 */
export async function signInAgy(
	client: WebClient,
	user: TurnUser,
	where: Where,
): Promise<void> {
	await sendNotice(client, user, where, {
		icon: ":key:",
		title: "Connect Antigravity",
		text: `${systemName()} runs Antigravity on your own Google account, or on a Gemini API key.`,
		buttons: [
			{
				label: "Connect Antigravity",
				action: "home_agy_connect",
				value: "connect",
				primary: true,
			},
			{
				label: "Use an API key",
				action: "home_agy_key",
				value: "key",
			},
		],
		footer: "Only you can see this.",
	})
}

/**
 * The paste-code sign-in link `agy acp --login` prints. Stdout is read to its end, not just to the
 * link: once nobody reads it, post-login output can end `docker exec` with SIGPIPE.
 */
export async function agySignInLink(
	stdout: Bun.Subprocess<"pipe", "pipe", "pipe">["stdout"],
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>()
	void (async () => {
		let text = ""
		let found = false
		for await (const chunk of stdout.pipeThrough(new TextDecoderStream())) {
			if (found) continue
			text += chunk
			// Wait for whitespace after the URL so a chunk split mid-URL never resolves truncated.
			const link = text.match(
				/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+)\s/,
			)?.[1]
			if (!link) continue
			found = true
			resolve(link)
		}
		if (!found) {
			const link = text.match(
				/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/,
			)?.[0]
			if (link) {
				found = true
				resolve(link)
				return
			}
			throw new Error(
				`Antigravity didn't give a sign-in link: ${text.trim().slice(-300)}`,
			)
		}
	})().catch(reject)
	return Promise.race([
		promise,
		Bun.sleep(30_000).then(() => {
			throw new Error("Antigravity didn't give a sign-in link in time")
		}),
	])
}

/** Signs them out of Antigravity (and removes their Gemini API key, if that's how they connected). */
export async function signOutAgy(
	config: BotConfig,
	user: TurnUser,
): Promise<void> {
	await cancelAgySignIn(user)
	const container = await ensureContainer(config, user.teamId, user.userId)
	const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
	await logoutAcp({
		command: [AGY_DOCKER_WRAPPER, ...ACP_ARGS],
		env: childEnv({ LADDU_CONTAINER: container, LADDU_TURN: turnId }),
		stop: () => stopRun(container, turnId),
	}).catch(() => {})
	await Bun.$`docker exec ${container} rm -f ${"/home/laddu/.gemini/antigravity-cli/antigravity-oauth-token"}`
		.quiet()
		.nothrow()
	await runTool(config, user, [
		"connections",
		"key",
		"remove",
		AGY_KEY,
	]).catch(() => {})
	forgetAgy(user)
}

// ---- models ----------------------------------------------------------------------------------

const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]

const sortEfforts = (efforts: string[]) =>
	efforts.toSorted((a, b) => {
		const ai = EFFORT_ORDER.indexOf(a)
		const bi = EFFORT_ORDER.indexOf(b)
		if (ai !== -1 && bi !== -1) return ai - bi
		if (ai !== -1) return -1
		if (bi !== -1) return 1
		return a.localeCompare(b)
	})

type SelectChoice = {
	value: string
	name?: string
	description?: string | null
}

function selectChoices(
	option: NonNullable<AcpSessionInfo["configOptions"]>[number],
): SelectChoice[] {
	if (option.type !== "select") return []
	return (option.options as unknown[]).flatMap(entry =>
		entry && typeof entry === "object" && "options" in entry
			? (entry.options as SelectChoice[])
			: [entry as SelectChoice],
	)
}

/** Parses Antigravity's ACP `session/new` response into laddu's model options. */
export function parseAgyModels(session: AcpSessionInfo): ModelOption[] {
	const modelConfig = session.configOptions?.find(
		option => option.category === "model" && option.type === "select",
	)
	const thoughtConfig = session.configOptions?.find(
		option =>
			option.category === "thought_level" && option.type === "select",
	)
	if (!modelConfig || modelConfig.type !== "select") return []
	const availableIds = (session.models?.availableModels ?? []).map(
		entry => entry.modelId,
	)
	const currentModel = modelConfig.currentValue
	const currentThought =
		thoughtConfig?.type === "select" ? thoughtConfig.currentValue : ""
	return selectChoices(modelConfig).map(choice => {
		const prefix = `${choice.value}-`
		const matched = sortEfforts([
			...new Set(
				availableIds
					.filter(id => id.startsWith(prefix))
					.map(id => id.slice(prefix.length))
					.filter(Boolean),
			),
		])
		const efforts =
			matched.length > 0
				? matched
				: choice.value === currentModel &&
					  thoughtConfig?.type === "select"
					? sortEfforts(
							selectChoices(thoughtConfig).map(c => c.value),
						)
					: []
		const defaultEffort =
			choice.value === currentModel && efforts.includes(currentThought)
				? currentThought
				: (["high", "medium", "low"].find(id => efforts.includes(id)) ??
					efforts[0] ??
					"")
		return {
			id: choice.value,
			name: choice.name || choice.value,
			description: choice.description ?? "",
			efforts: efforts.map(id => ({ id, description: "" })),
			defaultEffort,
			fast: false,
			images: session.images,
			...(choice.value === currentModel ? { isDefault: true } : {}),
		}
	})
}

/**
 * The models Antigravity offers them, with each one's thinking levels, cached for a few hours.
 * Empty if they aren't connected or the list can't be read.
 */
export function listAgyModels(
	config: BotConfig,
	user: TurnUser,
): Promise<ModelOption[]> {
	const cached = models.get(key(user))
	if (cached && Date.now() - cached.at < MODELS_MS) return cached.list
	const entry: { list: Promise<ModelOption[]>; at: number } = {
		list: Promise.resolve([]),
		at: Date.now(),
	}
	entry.list = (async (): Promise<ModelOption[]> => {
		const account = await agyAccount(config, user)
		if (!account) {
			if (models.get(key(user)) === entry) models.delete(key(user))
			return []
		}
		// agyAccount() already populated the cache when it verified an OAuth session.
		const warmed = models.get(key(user))
		if (warmed && warmed !== entry && Date.now() - warmed.at < MODELS_MS)
			return warmed.list
		const container = await ensureContainer(
			config,
			user.teamId,
			user.userId,
		)
		const turnId = `ask-${crypto.randomUUID().slice(0, 8)}`
		const session = await probeAcpSession({
			command: [AGY_DOCKER_WRAPPER, ...ACP_ARGS],
			env: childEnv({ LADDU_CONTAINER: container, LADDU_TURN: turnId }),
			cwd: CONTAINER_WORKDIR,
			authMethod: account.method === "key" ? "gemini-api-key" : undefined,
			stop: () => stopRun(container, turnId),
		})
		return parseAgyModels(session)
	})().catch(error => {
		console.warn("[agy] couldn't list models:", error)
		if (models.get(key(user)) === entry) models.delete(key(user))
		return []
	})
	models.set(key(user), entry)
	return entry.list
}

// ---- turns -----------------------------------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
}

export async function runAgyTurn(options: TurnOptions): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, user } = options
	const account = await agyAccount(config, user)
	if (!account) throw new NotSignedInError("agy")

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
			images: images.flatMap(({ file }): AcpContentBlock[] => {
				const mimeType =
					IMAGE_TYPES[
						file.fileName.split(".").pop()?.toLowerCase() ?? ""
					]
				return mimeType
					? [
							{
								type: "image",
								mimeType,
								data: file.data.toBase64(),
							},
						]
					: []
			}),
		}
	}
	const text = (value: string): AcpContentBlock => ({
		type: "text",
		text: value,
	})

	// Loaded once per conversation, like a system prompt; resumed ones already have it.
	const memory = options.threadId
		? null
		: await loadMemory(() => runTool(config, user, ["memory", "show"]))
	const { note, images } = await attach(options.files ?? [])
	const mcpServers: AcpMcpServer[] = config.desktop
		? [
				{
					name: "desktop",
					command: `${CONTAINER_TOOLS_DIR}/desktop`,
					args: ["mcp"],
					env: [],
				},
			]
		: []

	const result = await runAcpTurn(
		{
			command: [AGY_DOCKER_WRAPPER, ...ACP_ARGS],
			env: childEnv({
				LADDU_CONTAINER: container,
				...turnEnv(turnId, user, options.slack),
			}),
			cwd: CONTAINER_WORKDIR,
			mcpServers,
			authMethod: account.method === "key" ? "gemini-api-key" : undefined,
			model: config.model || undefined,
			effort: config.reasoningEffort || undefined,
			stop: () => stopRun(container, turnId),
		},
		{
			sessionId: options.threadId,
			prompt: [
				text(
					[
						memoryNote(memory),
						options.input,
						note,
						outboxNote(outbox),
					]
						.filter(Boolean)
						.join("\n\n"),
				),
				...images,
			],
			signal: options.signal,
			onItem: track,
			onSteerable: steer =>
				options.onSteerable?.(
					steer &&
						(async (more, files = []) => {
							const { note, images } = await attach(files)
							return steer([
								text([more, note].filter(Boolean).join("\n\n")),
								...images,
							])
						}),
				),
		},
	).catch(error => {
		if (error instanceof AuthRequiredError) {
			forgetAgy(user)
			throw new NotSignedInError("agy")
		}
		const message = error instanceof Error ? error.message : String(error)
		if (
			/authentication required|invalid api key|api key not valid|unauthenticated/i.test(
				message,
			)
		) {
			forgetAgy(user)
			throw new NotSignedInError("agy")
		}
		if (/resource_exhausted|quota exceeded|usage limit/i.test(message))
			throw new AgyLimitError(message)
		throw error
	})
	const { files, skipped } = await collectOutbox(await listOutbox())
	return {
		threadId: result.sessionId,
		text:
			result.text ||
			(files.length ? "" : "_(Antigravity finished without a reply.)_"),
		files,
		skipped,
	}
}
