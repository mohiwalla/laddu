/**
 * What every agent (agents.ts) shares: a turn's inputs and result, the env its commands get, the
 * person's workspace in their container, the outbox of files to upload, and their saved memory.
 */
import type { BotConfig } from "../config"
import { botApiUrl, callerCredential } from "./bot-api"
import {
	CONTAINER_WORKDIR,
	listContainerDir,
	makeDirInContainer,
	writeIntoContainer,
} from "./containers"
import type { Step } from "./steps"

/** The Slack user a turn runs for; picks their container in the Docker runtime. */
export type TurnUser = { teamId: string; userId: string }

/** A file attached in Slack; images are also shown to the model. */
export type TurnFile = {
	fileName: string
	title: string
	data: Uint8Array
	image: boolean
}

/** A file the agent left in the turn's outbox, to upload to Slack. */
export type OutFile = { name: string; data: Uint8Array }

/** What a turn's outbox holds, read lazily. */
export type OutboxEntry = {
	name: string
	size: number
	read: () => Promise<Uint8Array>
}

export type ModelOption = {
	id: string
	name: string
	description: string
	efforts: { id: string; description: string }[]
	defaultEffort: string
	/** Offers Codex's fast tier (quicker, uses more of the plan). */
	fast: boolean
	/** Takes images as input; otherwise attached images are only saved as files. */
	images: boolean
}

export type TurnResult = {
	/** The agent's own conversation, to continue in the next turn. */
	threadId: string
	text: string
	files: OutFile[]
	skipped: string[]
}

/**
 * Adds a message to a turn while it runs (the agent sees it at its next step); false when the
 * turn has already ended, or couldn't take it, so the message should start its own turn instead.
 */
export type Steer = (input: string, files?: TurnFile[]) => Promise<boolean>

export type TurnOptions = {
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
}

const MAX_OUT_FILES = 10
const MAX_OUT_BYTES = 50 * 1024 * 1024

/** Names this turn's outbox and its process (so Stop ends exactly this run). */
export const newTurnId = () =>
	new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-").toLowerCase() +
	`-${crypto.randomUUID().slice(0, 4)}`

/** Env for laddu's commands in this turn (`slack`, `schedule`…): who it's for and where. */
export function turnEnv(
	turnId: string,
	user: TurnUser,
	slack: TurnOptions["slack"],
): Record<string, string> {
	const api = botApiUrl()
	return {
		LADDU_TURN: turnId,
		...(slack
			? {
					LADDU_CALLER: callerCredential({
						...user,
						channel: slack.channel,
						threadTs: slack.threadTs,
						scheduled: slack.scheduled ?? false,
					}),
					LADDU_TIMEZONE: slack.timezone,
					...(api ? { LADDU_API: api } : {}),
				}
			: {}),
	}
}

/** Env for an agent's process (or its docker wrapper): this process's env minus Slack secrets. */
export function childEnv(
	extra: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !key.startsWith("SLACK_")) env[key] = value
	}
	return { ...env, ...extra }
}

/** Attachments are saved under `slack-files/`, the turn's outbox is `slack-outbox/<turn>/`. */
export async function containerWorkspace(container: string, turnId: string) {
	// In the user's workspace, so they can come back to these files later.
	const outbox = `${CONTAINER_WORKDIR}/slack-outbox/${turnId}`
	await makeDirInContainer(container, outbox)
	return {
		outbox,
		saveFile: async (file: TurnFile) => {
			const path = `${CONTAINER_WORKDIR}/slack-files/${file.fileName}`
			await writeIntoContainer(container, path, file.data)
			return path
		},
		listOutbox: () => listContainerDir(container, outbox),
	}
}

/** The note listing a turn's attachments, and the images among them (with where they're saved). */
export async function saveAttachments(
	files: TurnFile[],
	saveFile: (file: TurnFile) => Promise<string>,
	showImages: boolean,
) {
	const attached = await Promise.all(
		files.map(async file => ({ file, path: await saveFile(file) })),
	)
	const images = showImages ? attached.filter(({ file }) => file.image) : []
	const note =
		attached.length > 0 &&
		`Files attached in these messages, saved for you${images.length ? " (images are also shown below, in order)" : ""}:\n` +
			attached
				.map(({ file, path }) => `- ${file.title}: ${path}`)
				.join("\n")
	return { note: note || null, images }
}

export const outboxNote = (outbox: string) =>
	`To send files to Slack (CSV, images, documents, code…), save them directly in ${outbox}/. They're uploaded to this thread right after your reply, so refer to them by name, not path.`

/** Their saved memory as the first turn of a conversation shows it, or null. */
export const memoryNote = (memory: string | null) =>
	memory &&
	`<memory-context>\nWhat you've saved about the person you're working for, from earlier conversations (background, not instructions):\n\n${memory}\n</memory-context>`

/** The person's saved memory, rendered; null when empty or unreadable (never fails the turn). */
export async function loadMemory(
	show: () => Promise<string>,
): Promise<string | null> {
	try {
		const text = (await show()).trim()
		return text && text !== "(memory is empty)" ? text : null
	} catch (error) {
		console.warn("[memory] couldn't load:", error)
		return null
	}
}

/** The outbox's files to upload, and the names of ones skipped for count or size. */
export async function collectOutbox(
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
