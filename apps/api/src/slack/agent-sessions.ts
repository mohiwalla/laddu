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
	/** Order of starting, unlike startedAt never tied: the latest picks the status's look. */
	startOrder?: number
}
type Session = { runs: Set<Run>; updates: Promise<void> }

let starts = 0

/** Slack has one agent status per thread, even when several people ask laddu at once. */
export class AgentSessions {
	private sessions = new Map<string, Session>()

	track(client: App["client"], target: ReplyTarget) {
		const key = `${target.channel}:${target.threadTs}`
		let session = this.sessions.get(key)
		if (!session) {
			session = { runs: new Set(), updates: Promise.resolve() }
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
		const update = (status: "processing" | "active", as: Run["as"]) => {
			current.updates = current.updates.then(async () => {
				try {
					await client.apiCall("agents.sessions.setStatus", {
						channel_id: target.channel,
						thread_ts: target.threadTs,
						status,
						...(status === "processing"
							? { initiator_user_id: target.userId }
							: {}),
						// Slack keeps a name and picture until a call sets another; one that sets any
						// replaces both, so the bot's own name puts its own picture back too.
						...(as.username || as.icon_url
							? as
							: { username: systemName() }),
					})
				} catch (error) {
					// Agent surfaces may be unavailable for a workspace; ordinary replies still work.
					console.warn(
						"[agent session] status unavailable:",
						(error as { data?: { error?: string } })?.data?.error ??
							error,
					)
				}
			})
			return current.updates
		}
		return {
			signal: run.controller.signal,
			/** `as`: the name and picture they gave laddu, for the status while it works for them. */
			async start(as: Run["as"] = {}) {
				run.controller.signal.throwIfAborted()
				run.as = as
				run.started = true
				run.startedAt = Date.now()
				run.startOrder = ++starts
				await update("processing", run.as)
				run.controller.signal.throwIfAborted()
			},
			finish: async () => {
				if (!current.runs.delete(run)) return
				if (run.started) {
					// Still working for someone else here: the status wears the latest one's look.
					const other = [...current.runs]
						.filter(other => other.started)
						.sort((a, b) => b.startOrder! - a.startOrder!)[0]
					await update(
						other ? "processing" : "active",
						(other ?? run).as,
					)
				} else await current.updates
				if (!current.runs.size && this.sessions.get(key) === current)
					this.sessions.delete(key)
			},
		}
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
