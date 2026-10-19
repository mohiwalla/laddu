import { expect, mock, test } from "bun:test"
import type { App } from "@slack/bolt"
import { AgentSessions } from "./agent-sessions"

const target = {
	channel: "C_ONE",
	threadTs: "1.001",
	userId: "U_ONE",
	teamId: "T_ONE",
}
const clientWith = (apiCall: ReturnType<typeof mock>) =>
	({ apiCall }) as unknown as App["client"]

test("native status stays processing until everyone's work in the thread ends", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const first = sessions.track(client, target)
	const second = sessions.track(client, { ...target, userId: "U_TWO" })
	await first.start()
	await second.start()
	await first.finish()
	expect(apiCall.mock.calls.map(call => (call as unknown[])[1])).toEqual([
		expect.objectContaining({
			status: "processing",
			initiator_user_id: "U_ONE",
		}),
		expect.objectContaining({
			status: "processing",
			initiator_user_id: "U_TWO",
		}),
		expect.objectContaining({ status: "processing" }),
	])
	await second.finish()
	expect(apiCall).toHaveBeenLastCalledWith("agents.sessions.setStatus", {
		channel_id: target.channel,
		thread_ts: target.threadTs,
		status: "active",
	})
})

test("Stop cancels one person's active and queued requests, only in the selected thread", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const running = sessions.track(client, target)
	const queued = sessions.track(client, target)
	const someoneElse = sessions.track(client, { ...target, userId: "U_TWO" })
	const other = sessions.track(client, { ...target, threadTs: "2.002" })
	await running.start()
	expect(sessions.stop(target.channel, target.threadTs, target.userId)).toBe(2)
	expect(running.signal.aborted).toBe(true)
	expect(queued.signal.aborted).toBe(true)
	expect(someoneElse.signal.aborted).toBe(false)
	expect(other.signal.aborted).toBe(false)
	// Nothing left of theirs to stop.
	expect(sessions.stop(target.channel, target.threadTs, target.userId)).toBe(0)
	await expect(queued.start()).rejects.toThrow()
	await queued.finish()
	await running.finish()
	await someoneElse.finish()
	await other.finish()
	expect(apiCall).toHaveBeenCalledTimes(2)
	// A new request after Stop can run normally.
	const next = sessions.track(client, target)
	await next.start()
	expect(next.signal.aborted).toBe(false)
	await next.finish()
})

test("status failure does not prevent a normal reply or cleanup", async () => {
	const apiCall = mock(async () => {
		throw { data: { error: "feature_disabled" } }
	})
	const sessions = new AgentSessions()
	const run = sessions.track(clientWith(apiCall), target)
	await run.start()
	expect(run.signal.aborted).toBe(false)
	await run.finish()
	await run.finish()
	expect(apiCall).toHaveBeenCalledTimes(2)
})

test("status transitions are ordered even when requests overlap an API response", async () => {
	let release!: () => void
	const pending = new Promise<void>(resolve => {
		release = resolve
	})
	const apiCall = mock(async () => {
		await pending
		return { ok: true }
	})
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const first = sessions.track(client, target)
	const starting = first.start()
	const finishing = first.finish()
	const second = sessions.track(client, target)
	const next = second.start()
	release()
	await Promise.all([starting, finishing, next])
	expect(
		apiCall.mock.calls.map(
			call => ((call as unknown[])[1] as { status: string }).status,
		),
	).toEqual(["processing", "active", "processing"])
	await second.finish()
})
