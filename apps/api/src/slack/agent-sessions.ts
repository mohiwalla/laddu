import type { App } from "@slack/bolt"
import type { ReplyTarget } from "./reply"
import { systemName } from "./system"

type Run = {
	controller: AbortController
	started: boolean
	userId: string
	/** The name and picture they gave laddu (appearance.ts), shown on the status. */
	as: { username?: string; icon_url?: string }
	/** When it began running (not while queued behind another). */
	startedAt?: number
}
type Session = {
	runs: Set<Run>
	/** Status calls, one at a time: each works out what to send when its turn comes. */
	updates: Promise<void>
	client: App["client"]
	channel: string
	threadTs: string
}

/** Started and not stopped: what the status is working on. */
const working = (session: Session) =>
	[...session.runs].filter(
		run => run.started && !run.controller.signal.aborted,
	)

/**
 * The status (and Slack's "Stop <name>" on it) wears the look of whoever it's working for, or
 * laddu's own while that's several people with different looks.
 */
function look(runs: Run[], fallback: Run["as"]): Run["as"] {
	const [first, ...rest] = runs
	if (!first) return fallback
	return rest.every(
		other =>
			other.as.username === first.as.username &&
			other.as.icon_url === first.as.icon_url,
	)
		? first.as
		: {}
}

/** One status call; a failure is only logged. */
async function setStatus(
	session: Session,
	status: "processing" | "active",
	fallback: Run["as"],
) {
	const runs = working(session)
	const as = look(runs, fallback)
	const initiator = runs.at(-1)?.userId
	try {
		await session.client.apiCall("agents.sessions.setStatus", {
			channel_id: session.channel,
			thread_ts: session.threadTs,
			status,
			...(status === "processing" && initiator
				? { initiator_user_id: initiator }
				: {}),
			// Slack keeps a name and picture until a call sets another; one that sets any
			// replaces both, so the bot's own name puts its own picture back too.
			...(as.username || as.icon_url ? as : { username: systemName() }),
		})
	} catch (error) {
		// Agent surfaces may be unavailable for a workspace; ordinary replies still work.
		console.warn(
			"[agent session] status unavailable:",
			(error as { data?: { error?: string } })?.data?.error ?? error,
		)
	}
}

/**
 * Sets the status from the runs as they are when this call's turn comes: processing while it works
 * for anyone (a stopped run still finishing counts), else active.
 */
function sync(session: Session, fallback: Run["as"]) {
	session.updates = session.updates.then(() =>
		setStatus(
			session,
			[...session.runs].some(run => run.started)
				? "processing"
				: "active",
			fallback,
		),
	)
	return session.updates
}

/**
 * After a Stop click Slack shows "Stopping…" until the status changes, and processing again isn't
 * a change: while it still works for someone, it goes active for a moment, then processing (if
 * that work didn't end meanwhile).
 */
function recover(session: Session) {
	session.updates = session.updates.then(async () => {
		if (!working(session).length) return
		await setStatus(session, "active", {})
		if (working(session).length) await setStatus(session, "processing", {})
	})
	return session.updates
}

/** Slack has one agent status per thread, even when several people ask laddu at once. */
export class AgentSessions {
	private sessions = new Map<string, Session>()

	track(client: App["client"], target: ReplyTarget) {
		const key = `${target.channel}:${target.threadTs}`
		let session = this.sessions.get(key)
		if (!session) {
			session = {
				runs: new Set(),
				updates: Promise.resolve(),
				client,
				channel: target.channel,
				threadTs: target.threadTs,
			}
			this.sessions.set(key, session)
		}
		const current = session
		const run: Run = {
			controller: new AbortController(),
			started: false,
			userId: target.userId,
			as: {},
		}
		current.runs.add(run)
		return {
			signal: run.controller.signal,
			/** `as`: the name and picture they gave laddu, for the status while it works for them. */
			async start(as: Run["as"] = {}) {
				run.controller.signal.throwIfAborted()
				run.as = as
				run.started = true
				run.startedAt = Date.now()
				await sync(current, run.as)
				run.controller.signal.throwIfAborted()
			},
			finish: async () => {
				if (!current.runs.delete(run)) return
				if (run.started) await sync(current, run.as)
				else await current.updates
				if (!current.runs.size && this.sessions.get(key) === current)
					this.sessions.delete(key)
			},
		}
	}

	/**
	 * After a Stop click: Slack shows "Stopping…" until the status changes, so while it still works
	 * for someone (the click stopped nothing, or only the clicker's own) it goes back to working.
	 */
	async resume(channel: string, threadTs: string) {
		const session = this.sessions.get(`${channel}:${threadTs}`)
		if (session) await recover(session)
	}

	/** One person's requests running now, oldest first, by thread. */
	running(
		userId: string,
	): { channel: string; threadTs: string; startedAt: number }[] {
		const found = []
		for (const [key, session] of this.sessions) {
			const [channel, threadTs] = key.split(/:(.*)/) as [string, string]
			for (const run of session.runs)
				if (
					run.userId === userId &&
					run.startedAt &&
					!run.controller.signal.aborted
				)
					found.push({ channel, threadTs, startedAt: run.startedAt })
		}
		return found.sort((a, b) => a.startedAt - b.startedAt)
	}

	/** Who laddu is working for in this thread right now (not yet stopped). */
	askers(channel: string, threadTs: string): string[] {
		const found = new Set<string>()
		for (const run of this.sessions.get(`${channel}:${threadTs}`)?.runs ??
			[])
			if (!run.controller.signal.aborted) found.add(run.userId)
		return [...found]
	}

	/**
	 * Cancels one person's active and already queued requests in this thread, leaving everyone
	 * else's (and other threads) alone. Returns how many there were.
	 */
	stop(channel: string, threadTs: string, userId: string): number {
		let stopped = 0
		for (const run of this.sessions.get(`${channel}:${threadTs}`)?.runs ??
			[])
			if (run.userId === userId && !run.controller.signal.aborted) {
				run.controller.abort()
				stopped++
			}
		return stopped
	}
}
