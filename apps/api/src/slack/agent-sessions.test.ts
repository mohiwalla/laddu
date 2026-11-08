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
		username: "laddu",
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
	expect(sessions.stop(target.channel, target.threadTs, target.userId)).toBe(
		2,
	)
	expect(running.signal.aborted).toBe(true)
	expect(queued.signal.aborted).toBe(true)
	expect(someoneElse.signal.aborted).toBe(false)
	expect(other.signal.aborted).toBe(false)
	// Nothing left of theirs to stop.
	expect(sessions.stop(target.channel, target.threadTs, target.userId)).toBe(
		0,
	)
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
		// Each call sends the state when its turn comes: the second request had started by then.
	).toEqual(["processing", "processing", "processing"])
	await second.finish()
	expect(apiCall).toHaveBeenLastCalledWith(
		"agents.sessions.setStatus",
		expect.objectContaining({ status: "active" }),
	)
})

test("the status wears the look of whoever it's working for, laddu's own for several", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const kanha = { username: "kanha", icon_url: "https://x/kanha.png" }
	const first = sessions.track(client, target)
	const second = sessions.track(client, { ...target, userId: "U_TWO" })
	const third = sessions.track(client, { ...target, userId: "U_THREE" })
	await first.start(kanha)
	// Slack's Stop reads "Stop <name>" and stops only the clicker's work: one person's name on it
	// while it works for several would read as theirs alone.
	await second.start(kanha)
	await third.start()
	await third.finish()
	await first.finish()
	await second.finish()
	expect(
		apiCall.mock.calls.map(call => {
			const { status, username, icon_url } = (call as unknown[])[1] as {
				status: string
				username?: string
				icon_url?: string
			}
			return { status, username, icon_url }
		}),
	).toEqual([
		{ status: "processing", ...kanha },
		// Same look for both: still theirs.
		{ status: "processing", ...kanha },
		// A different look joins: laddu's own name, which clears the picture too.
		{ status: "processing", username: "laddu", icon_url: undefined },
		{ status: "processing", ...kanha },
		{ status: "processing", ...kanha },
		{ status: "active", ...kanha },
	])
})

test("a Stop that stopped nothing sets the status again, so Slack's Stopping… goes back to working", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const run = sessions.track(client, target)
	await sessions.resume(target.channel, target.threadTs)
	// Not started yet: no status to set again.
	expect(apiCall).not.toHaveBeenCalled()
	await run.start()
	expect(sessions.stop(target.channel, target.threadTs, "U_OTHER")).toBe(0)
	await sessions.resume(target.channel, target.threadTs)
	// Setting processing again isn't a change Slack acts on: active for a moment first.
	expect(statuses(apiCall)).toEqual(["processing", "active", "processing"])
	await run.finish()
	await sessions.resume(target.channel, target.threadTs)
	expect(statuses(apiCall)).toEqual([
		"processing",
		"active",
		"processing",
		"active",
	])
})

test("someone's Stop while laddu still works for another turns Stopping… back to working", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const mine = sessions.track(client, target)
	const theirs = sessions.track(client, { ...target, userId: "U_TWO" })
	await mine.start()
	await theirs.start()
	expect(sessions.stop(target.channel, target.threadTs, target.userId)).toBe(
		1,
	)
	await sessions.resume(target.channel, target.threadTs)
	await mine.finish()
	expect(statuses(apiCall)).toEqual([
		"processing",
		"processing",
		"active",
		"processing",
		"processing",
	])
	await theirs.finish()
	expect(statuses(apiCall).at(-1)).toBe("active")
})

test("a Stop that only withdrew a queued request still turns Stopping… back to working", async () => {
	const apiCall = mock(async () => ({ ok: true }))
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const running = sessions.track(client, target)
	const queued = sessions.track(client, { ...target, userId: "U_TWO" })
	await running.start()
	expect(sessions.stop(target.channel, target.threadTs, "U_TWO")).toBe(1)
	await sessions.resume(target.channel, target.threadTs)
	await queued.finish()
	expect(statuses(apiCall)).toEqual(["processing", "active", "processing"])
})

test("work that ends while Stopping… is cleared leaves the status active", async () => {
	let release!: () => void
	const gate = new Promise<void>(resolve => (release = resolve))
	const apiCall = mock(async (_method: string, args: { status: string }) => {
		if (args.status === "active" && apiCall.mock.calls.length === 2)
			await gate
		return { ok: true }
	})
	const client = clientWith(apiCall)
	const sessions = new AgentSessions()
	const run = sessions.track(client, target)
	await run.start()
	const resumed = sessions.resume(target.channel, target.threadTs)
	// The recovery's active call is slow; the work ends meanwhile.
	await Bun.sleep(0)
	const finished = run.finish()
	release()
	await Promise.all([resumed, finished])
	expect(statuses(apiCall)).toEqual(["processing", "active", "active"])
})

function statuses(apiCall: ReturnType<typeof mock>) {
	return apiCall.mock.calls.map(
		call => ((call as unknown[])[1] as { status: string }).status,
	)
}
