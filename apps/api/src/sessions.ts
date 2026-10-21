/**
 * Maps (Slack thread, user) to the agent's conversation that answers that user there.
 * The agent keeps the conversation itself (Codex in CODEX_HOME/sessions, OpenCode in its data
 * dir); we only keep the pointer and the newest Slack message ts already sent to it, so follow-ups
 * only send new messages.
 */
import type { AgentId } from "./agent/agents"
import { paths } from "./config"
import { readJson, writeJsonPrivate } from "./files"

export type Session = {
	/** Whose conversation it is; after switching agents, the thread starts over with the new one. */
	agent: AgentId
	threadId: string
	/** ts of the newest Slack message already included in a turn. */
	lastSeenTs: string
	/** Linked Slack conversations already given to the agent in this thread ("channel:ts"). */
	linked?: string[]
}

let sessions: Record<string, Session> | null = null

async function all(): Promise<Record<string, Session>> {
	sessions ??= (await readJson<Record<string, Session>>(paths.sessions)) ?? {}
	return sessions
}

export const sessionKey = (channel: string, threadTs: string, userId: string) =>
	`${channel}:${threadTs}:${userId}`

export async function getSession(key: string): Promise<Session | undefined> {
	return (await all())[key]
}

export async function saveSession(
	key: string,
	session: Session,
): Promise<void> {
	const store = await all()
	store[key] = session
	await writeJsonPrivate(paths.sessions, store)
}

export async function deleteSession(key: string): Promise<void> {
	const store = await all()
	delete store[key]
	await writeJsonPrivate(paths.sessions, store)
}

const queues = new Map<string, Promise<unknown>>()

/** Run `task` after any earlier task for the same key, so one Slack thread never has two turns at once. */
export function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve()
	const next = previous.catch(() => {}).then(task)
	queues.set(key, next)
	next.finally(() => queues.get(key) === next && queues.delete(key)).catch(
		() => {},
	)
	return next
}
