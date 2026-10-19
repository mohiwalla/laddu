import type { App } from "@slack/bolt"
import type { ReplyTarget } from "./reply"

type Run = { controller: AbortController; started: boolean }
type Session = { runs: Set<Run>; updates: Promise<void> }

/** Slack has one agent status per thread, even when several people ask dot at once. */
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
		const run: Run = { controller: new AbortController(), started: false }
		current.runs.add(run)
		const update = (status: "processing" | "active") => {
			current.updates = current.updates.then(async () => {
				try {
					await client.apiCall("agents.sessions.setStatus", {
						channel_id: target.channel,
						thread_ts: target.threadTs,
						status,
						...(status === "processing"
							? { initiator_user_id: target.userId }
							: {}),
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
			async start() {
				run.controller.signal.throwIfAborted()
				run.started = true
				await update("processing")
				run.controller.signal.throwIfAborted()
			},
			finish: async () => {
				if (!current.runs.delete(run)) return
				if (run.started)
					await update(
						[...current.runs].some(other => other.started)
							? "processing"
							: "active",
					)
				else await current.updates
				if (!current.runs.size && this.sessions.get(key) === current)
					this.sessions.delete(key)
			},
		}
	}

	/** Cancel active and already queued requests for this thread, leaving other threads alone. */
	stop(channel: string, threadTs: string) {
		for (const run of this.sessions.get(`${channel}:${threadTs}`)?.runs ??
			[])
			run.controller.abort()
	}
}
