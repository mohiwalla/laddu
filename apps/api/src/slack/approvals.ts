/**
 * The person's OK before laddu does something risky as them (agent/actions.ts says which): a
 * message in the thread with Allow and Don't allow, for them only. The request isn't sent until
 * they allow it; then the bot sends it itself, exactly once, and their decision with the result
 * comes back to laddu as a turn, like an answer to `slack ask`. Tools are otherwise approved
 * automatically, so this is what stands between a prompt injection and their accounts.
 * Kept in memory: a restart drops open requests (their buttons then say so).
 */
import type { App, types } from "@slack/bolt"
import { postAs } from "../appearance"
import { sessionKey } from "../sessions"
import type { Asker } from "./questions"
import { systemName } from "./system"
import type { Risky } from "../agent/actions"

type WebClient = App["client"]
type Outcome = { ok: boolean; text: string }

type Approval = Asker &
	Risky & {
		id: string
		key: string
		ts: string
		askedAt: number
		run: () => Promise<Outcome>
	}

/** How long a request stays open. */
const OPEN_MS = 24 * 3600_000

const approvals = new Map<string, Approval>()

type Decided = (approval: Asker & { ts: string }, request: string) => void
let decided: Decided = () => {}

function prune() {
	const now = Date.now()
	for (const [id, approval] of approvals)
		if (approval.askedAt + OPEN_MS < now) approvals.delete(id)
}

const plain = (text: string) => ({ type: "plain_text" as const, text })
const heading = (approval: Approval) =>
	`:raised_hand: *Needs your OK.* ${systemName()} wants to:\n${approval.detail}`

function openBlocks(approval: Approval): types.KnownBlock[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text: heading(approval) } },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "laddu_ok_allow",
					text: plain("Allow"),
					style: "primary",
					value: approval.id,
				},
				{
					type: "button",
					action_id: "laddu_ok_deny",
					text: plain("Don't allow"),
					value: approval.id,
				},
			],
		},
		{
			type: "context",
			elements: [
				{ type: "mrkdwn", text: `For <@${approval.userId}> only` },
			],
		},
	]
}

/** The request with its outcome in place of the buttons. */
async function close(client: WebClient, approval: Approval, outcome: string) {
	await client.chat
		.update({
			channel: approval.channel,
			ts: approval.ts,
			text: approval.label,
			blocks: [
				{
					type: "section",
					text: { type: "mrkdwn", text: heading(approval) },
				},
				{
					type: "context",
					elements: [{ type: "mrkdwn", text: outcome }],
				},
			],
		})
		.catch(error =>
			console.warn("[approval] couldn't update the request", error),
		)
}

/**
 * Posts the request in the thread; `run` sends it once they allow it. Returns what the turn is
 * told meanwhile.
 */
export async function requestOk(
	client: WebClient,
	asker: Asker,
	risky: Risky,
	run: () => Promise<Outcome>,
): Promise<string> {
	prune()
	const approval: Approval = {
		...asker,
		...risky,
		id: crypto.randomUUID(),
		key: sessionKey(asker.channel, asker.threadTs, asker.userId),
		ts: "",
		askedAt: Date.now(),
		run,
	}
	const posted = await client.chat.postMessage({
		channel: asker.channel,
		thread_ts: asker.threadTs,
		text: `Needs your OK: ${risky.label}`,
		blocks: openBlocks(approval),
		...(await postAs(asker)),
	})
	approval.ts = posted.ts!
	approvals.set(approval.id, approval)
	console.log(
		`[approval] ${asker.teamId}-${asker.userId}: asked to ${risky.label}`,
	)
	return `Not done yet: this needs their OK, so Allow / Don't allow buttons are in the thread now. Don't retry it or do it another way. End your turn now, replying with just [REACT:hourglass_flowing_sand]: the request in the thread is your message, so don't say it's waiting or repeat it. Their decision (and the result, if they allow it) comes back to you as their next message.`
}

/** They stopped laddu's work in this thread: its open requests there are withdrawn. Whether any were open. */
export function withdrawApprovals(client: WebClient, key: string): boolean {
	let any = false
	for (const approval of approvals.values()) {
		if (approval.key !== key) continue
		approvals.delete(approval.id)
		void close(client, approval, ":no_entry_sign: Stopped; not sent")
		any = true
	}
	return any
}

export function registerApprovals(app: App, onDecision: Decided) {
	decided = onDecision
	/** The request behind a click, taken so a double click can't run it twice; null after telling the clicker why not. */
	const take = async (
		client: WebClient,
		id: string,
		user: string,
		channel: string | undefined,
	) => {
		const approval = approvals.get(id)
		const tell = (text: string) =>
			channel &&
			client.chat
				.postEphemeral({
					channel,
					user,
					text,
					...(approval ? { thread_ts: approval.threadTs } : {}),
				})
				.catch(() => {})
		if (!approval) {
			await tell(
				`This request isn't open any more (it expired, or ${systemName()} restarted). Ask again if you still want it.`,
			)
			return null
		}
		if (approval.userId !== user) {
			await tell(`Only <@${approval.userId}> can answer this one.`)
			return null
		}
		approvals.delete(id)
		return approval
	}

	app.action("laddu_ok_allow", async ({ ack, body, action, client }) => {
		await ack()
		if (body.type !== "block_actions" || !("value" in action)) return
		const approval = await take(
			client,
			action.value ?? "",
			body.user.id,
			body.channel?.id,
		)
		if (!approval) return
		await close(
			client,
			approval,
			`:hourglass_flowing_sand: Allowed by <@${approval.userId}>; doing it…`,
		)
		const outcome = await approval
			.run()
			.catch(error => ({ ok: false, text: String(error) }))
		console.log(
			`[approval] ${approval.teamId}-${approval.userId}: allowed ${approval.label} → ${outcome.ok ? "done" : "failed"}`,
		)
		await close(
			client,
			approval,
			outcome.ok
				? `:white_check_mark: Allowed by <@${approval.userId}> and done`
				: `:warning: Allowed by <@${approval.userId}>, but it failed`,
		)
		decided(
			approval,
			`They allowed you to ${approval.label}. ${outcome.ok ? "Done" : "It failed"}: ${outcome.text}`,
		)
	})

	app.action("laddu_ok_deny", async ({ ack, body, action, client }) => {
		await ack()
		if (body.type !== "block_actions" || !("value" in action)) return
		const approval = await take(
			client,
			action.value ?? "",
			body.user.id,
			body.channel?.id,
		)
		if (!approval) return
		console.log(
			`[approval] ${approval.teamId}-${approval.userId}: refused ${approval.label}`,
		)
		await close(
			client,
			approval,
			`:no_entry_sign: Not allowed by <@${approval.userId}>`,
		)
		decided(
			approval,
			`They didn't allow you to ${approval.label}. It wasn't done; don't do it another way. Ask what they'd like instead if it isn't clear.`,
		)
	})
}

/** For tests. */
export function clearApprovals() {
	approvals.clear()
}
