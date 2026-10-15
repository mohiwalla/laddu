/**
 * Slack → Codex → Slack. Every Slack thread maps to one Codex thread; replies always go in-thread.
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { runTurn, type TurnResult } from "../agent/codex"
import {
	classify,
	pauseForUsageLimit,
	usagePause,
	type Failure,
} from "../agent/errors"
import { afterTurn } from "../agent/learning"
import {
	deleteSession,
	getSession,
	saveSession,
	serialize,
	sessionKey,
} from "../sessions"
import {
	buildTurnInput,
	userName,
	userTimezone,
	type Trigger,
	type TurnInput,
} from "./context"
import { downloadAttachments, uploadFiles } from "./attachments"
import { closeInterrupted, openReply, type Reply } from "./reply"
import { sendDesktopLinks } from "../agent/desktop"
import type { Step } from "../agent/steps"
import { markDone, markReply, markStarted, takeInterrupted } from "../inflight"
import { chunkMarkdown } from "./reply"
import {
	describeWhen,
	willRetry,
	type Job,
	type RunOutcome,
} from "../scheduler"

type WebClient = App["client"]

/** Interrupted turns younger than this are retried after a restart; older ones just get a note. */
const RESUME_WITHIN_MS = 30 * 60 * 1000
const DEDUPE_MS = 10 * 60 * 1000
/** A turn is tried at most this many times when its failure is worth retrying (see errors.ts). */
const MAX_ATTEMPTS = 2

/** A turn that failed for good, already classified and logged. */
class TurnFailed extends Error {
	constructor(readonly failure: Failure) {
		super(failure.message)
	}
}

/** One request: a message, or someone's reaction, /dot or shortcut on it. */
const triggerKey = (trigger: Trigger) =>
	trigger.via
		? `${trigger.channel}:${trigger.ts}:${trigger.via}:${trigger.userId}`
		: `${trigger.channel}:${trigger.ts}`

/** Slack can deliver an event twice (e.g. after a socket reconnect); answer each request once. */
const handled = new Map<string, number>()
function firstDelivery(trigger: Trigger): boolean {
	const now = Date.now()
	for (const [id, at] of handled) if (now - at > DEDUPE_MS) handled.delete(id)
	const id = triggerKey(trigger)
	if (handled.has(id)) return false
	handled.set(id, now)
	return true
}

/** Adds a reaction; false if Slack refused it (unknown emoji, no access). */
async function react(
	client: WebClient,
	channel: string,
	ts: string,
	name: string,
): Promise<boolean> {
	return client.reactions.add({ channel, timestamp: ts, name }).then(
		() => true,
		() => false,
	)
}

async function handle(
	client: WebClient,
	config: BotConfig,
	botUserId: string,
	trigger: Trigger,
) {
	if (!firstDelivery(trigger)) return
	const threadTs = trigger.threadTs ?? trigger.ts
	// Per user: each person in a shared thread has their own Codex thread, in their own container.
	const key = sessionKey(trigger.channel, threadTs, trigger.userId)
	// Keyed by request, not session: several can be queued for one thread.
	const inflightKey = triggerKey(trigger)
	await markStarted(inflightKey, trigger).catch(() => {})

	await serialize(key, async () => {
		let reply: Reply | undefined
		try {
			reply = await openReply(client, {
				channel: trigger.channel,
				threadTs,
				userId: trigger.userId,
				teamId: trigger.teamId,
			})
			await markReply(inflightKey, {
				ts: reply.ts,
				streaming: reply.streaming,
			}).catch(() => {})
			const paused = usagePause()
			if (paused)
				throw new TurnFailed({
					...classify(new Error("usage limit")),
					message: paused,
				})

			const user = { teamId: trigger.teamId, userId: trigger.userId }
			// The first time this turn uses dot's computer, the person gets their watch link.
			let linkSent = false
			const onStep = (step: Step) => {
				reply!.step(step)
				if (!step.computer || linkSent) return
				linkSent = true
				sendDesktopLinks(client, config, {
					...user,
					channel: trigger.channel,
					threadTs,
				}).catch(error =>
					console.warn(
						`[${key}] couldn't send the desktop link`,
						error,
					),
				)
			}
			let session = await getSession(key)
			let turn: TurnInput
			let result: TurnResult
			for (let attempt = 1; ; attempt++) {
				try {
					// Rebuilt each attempt: after a thread reset the fresh thread needs the whole conversation.
					turn = await buildTurnInput({
						client,
						trigger,
						session,
						botUserId,
						contextMessages: config.contextMessages,
					})
					const files = await downloadAttachments(
						config.slackBotToken,
						turn.attachments,
					)
					result = await runTurn({
						config,
						user,
						threadId: session?.codexThreadId,
						input: turn.text,
						files,
						slack: {
							channel: trigger.channel,
							threadTs,
							timezone: await userTimezone(
								client,
								trigger.userId,
							),
						},
						onStep,
					})
					break
				} catch (error) {
					const failure = classify(error, {
						utcClock: config.runtime === "docker",
					})
					console.error(
						`[${key}] attempt ${attempt} failed (${failure.kind}):`,
						error,
					)
					if (failure.resetThread && session) {
						await deleteSession(key)
						session = undefined
					}
					if (!failure.retry || attempt >= MAX_ATTEMPTS)
						throw new TurnFailed(failure)
					reply.step({
						id: `retry-${attempt}`,
						title: `${failure.message} Trying again…`,
						status: "error",
					})
					await Bun.sleep(failure.retryAfterMs)
				}
			}
			await saveSession(key, {
				codexThreadId: result.threadId,
				lastSeenTs: trigger.ts,
				linked: [
					...new Set([...(session?.linked ?? []), ...turn.linked]),
				],
			})
			// Nothing to say (e.g. "thanks"): Codex answers with just [REACT:emoji] and dot only reacts.
			const reaction = result.files.length
				? undefined
				: result.text.trim().match(/^\[REACT:([a-z0-9_+'-]+)\]$/i)?.[1]
			if (reaction) {
				await reply.discard()
				if (
					!(await react(
						client,
						trigger.channel,
						trigger.ts,
						reaction.toLowerCase(),
					))
				)
					await react(client, trigger.channel, trigger.ts, "+1")
			} else await reply.finish(result.text)
			void afterTurn(
				config,
				{ teamId: trigger.teamId, userId: trigger.userId },
				{
					place: turn.place,
					thread: `${trigger.channel}:${threadTs}`,
					messages: turn.transcript,
					reply: reaction
						? `(reacted :${reaction}:)`
						: result.text ||
							`(sent files: ${result.files.map(file => file.name).join(", ")})`,
				},
			).catch(error =>
				console.warn(`[${key}] after-turn work failed`, error),
			)

			// After the answer is posted, so a failed upload doesn't replace it with an error.
			const problems: string[] = []
			await uploadFiles(
				client,
				trigger.channel,
				threadTs,
				result.files,
			).catch(error => {
				console.error(`[${key}] upload failed`, error)
				problems.push(
					`Couldn't upload ${result.files.map(file => file.name).join(", ")}: ${error instanceof Error ? error.message : error}`,
				)
			})
			if (result.skipped.length)
				problems.push(
					`Not uploaded (empty, over 50 MB, or past 10 files): ${result.skipped.join(", ")}`,
				)
			for (const problem of problems) {
				await client.chat.postMessage({
					channel: trigger.channel,
					thread_ts: threadTs,
					markdown_text: `:warning: ${problem}`,
				})
			}
		} catch (error) {
			const failure =
				error instanceof TurnFailed
					? error.failure
					: classify(error, { utcClock: config.runtime === "docker" })
			if (!(error instanceof TurnFailed)) console.error(`[${key}]`, error)
			if (failure.kind === "usage_limit") pauseForUsageLimit(failure)
			const message = failure.resetThread
				? `${failure.message} I've started our conversation in this thread over; please ask again.`
				: failure.message
			if (reply)
				await reply
					.fail(message)
					.catch(failed =>
						console.error(
							`[${key}] couldn't report the error`,
							failed,
						),
					)
			// Couldn't even post there (e.g. not in that channel): tell them directly.
			else await notifyDirectly(client, trigger, message)
			await react(client, trigger.channel, trigger.ts, "x")
		} finally {
			await markDone(inflightKey).catch(() => {})
		}
	})
}

async function notifyDirectly(
	client: WebClient,
	trigger: Trigger,
	message: string,
) {
	const notInChannel = /not_in_channel|channel_not_found/.test(message)
	const text = notInChannel
		? `I couldn't answer in <#${trigger.channel}> because I'm not in it. Add me with \`/invite @dot\`, or ask me here.`
		: `I couldn't answer in <#${trigger.channel}>: ${message}`
	const { channel } = await client.conversations
		.open({ users: trigger.userId })
		.catch(() => ({ channel: undefined }))
	if (channel?.id)
		await client.chat
			.postMessage({ channel: channel.id, markdown_text: text })
			.catch(() => {})
}

/**
 * Picks up turns a previous bot process didn't finish (it was restarted or crashed mid-answer):
 * closes their half-done reply and answers again. Call after stopping orphaned Codex runs.
 */
export async function resumeInterrupted(
	client: WebClient,
	config: BotConfig,
	botUserId: string,
): Promise<void> {
	for (const { trigger, startedAt, reply } of await takeInterrupted()) {
		const retry = Date.now() - startedAt < RESUME_WITHIN_MS
		const note = retry
			? "_I was restarted mid-answer, so I'm starting over below._"
			: "_I was restarted mid-answer. Please ask again._"
		if (reply)
			await closeInterrupted(
				client,
				{
					channel: trigger.channel,
					threadTs: trigger.threadTs ?? trigger.ts,
				},
				reply,
				note,
			).catch(error =>
				console.warn("[resume] couldn't close reply:", error),
			)
		console.log(
			`[resume] ${retry ? "retrying" : "dropping"} ${trigger.channel}:${trigger.ts}`,
		)
		if (retry) void handle(client, config, botUserId, trigger)
		else await react(client, trigger.channel, trigger.ts, "x")
	}
}

export function registerHandlers(
	app: App,
	config: BotConfig,
	botUserId: string,
) {
	const isAllowed = (userId: string | undefined): userId is string =>
		userId !== undefined &&
		userId !== botUserId &&
		(config.allowedUsers === "*" || config.allowedUsers.has(userId))

	// @mentions in channels (and in threads inside channels).
	app.event("app_mention", async ({ event, client, context }) => {
		if (!isAllowed(event.user)) return
		void handle(client, config, botUserId, {
			channel: event.channel,
			ts: event.ts,
			threadTs: event.thread_ts,
			isDm: false,
			teamId: context.teamId!,
			userId: event.user,
		})
	})

	// Every message in a DM with the bot (no mention needed), and mentions in group DMs, where
	// Slack sends no app_mention.
	app.message(async ({ message, client, context }) => {
		// Plain messages and ones with attachments ("file_share"); edits, joins etc. carry other subtypes.
		if (message.subtype !== undefined && message.subtype !== "file_share")
			return
		const groupMention =
			message.channel_type === "mpim" &&
			(message.text ?? "").includes(`<@${botUserId}>`)
		if (message.channel_type !== "im" && !groupMention) return
		if (!isAllowed(message.user)) return
		void handle(client, config, botUserId, {
			channel: message.channel,
			ts: message.ts,
			threadTs: message.thread_ts,
			isDm: message.channel_type === "im",
			teamId: context.teamId!,
			userId: message.user,
		})
	})

	// Reacting with the trigger emoji to any message asks dot to handle that message.
	app.event("reaction_added", async ({ event, client, context }) => {
		if (
			event.reaction !== config.triggerEmoji ||
			event.item.type !== "message"
		)
			return
		if (!isAllowed(event.user)) return
		const { channel, ts } = event.item
		// Answer in the message's thread: find out whether it's a reply.
		const found = await client.conversations
			.replies({ channel, ts, limit: 1 })
			.catch(() => null)
		const message = found?.messages?.find(candidate => candidate.ts === ts)
		const threadTs =
			message?.thread_ts && message.thread_ts !== ts
				? message.thread_ts
				: undefined
		void handle(client, config, botUserId, {
			channel,
			ts,
			threadTs,
			isDm: channel.startsWith("D"),
			teamId: context.teamId!,
			userId: event.user,
			via: "reaction",
			request: event.reaction,
		})
	})

	// `/dot <request>`: dot posts the request where it was typed and answers in its thread.
	app.command("/dot", async ({ command, ack, respond, client, context }) => {
		await ack()
		if (!isAllowed(command.user_id)) {
			await respond({
				response_type: "ephemeral",
				text: "Sorry, I'm not set up to answer you.",
			})
			return
		}
		const request = command.text.trim()
		if (!request) {
			await respond({
				response_type: "ephemeral",
				text: "Tell me what you need, e.g. `/dot summarize this channel's last week`.",
			})
			return
		}
		const echo = await client.chat
			.postMessage({
				channel: command.channel_id,
				markdown_text: `<@${command.user_id}> asked: ${request}`,
			})
			.catch(() => null)
		if (!echo?.ts) {
			await respond({
				response_type: "ephemeral",
				text: "I can't post here. Add me with `/invite @dot`, or use `/dot` in our DM.",
			})
			return
		}
		void handle(client, config, botUserId, {
			channel: command.channel_id,
			ts: echo.ts,
			isDm: command.channel_id.startsWith("D"),
			teamId: context.teamId!,
			userId: command.user_id,
			via: "command",
			request,
		})
	})

	// Message shortcut "Ask dot": asks what to do with the message, then answers in its thread.
	app.shortcut("ask_dot", async ({ shortcut, ack, client }) => {
		await ack()
		if (shortcut.type !== "message_action") return
		await client.views.open({
			trigger_id: shortcut.trigger_id,
			view: {
				type: "modal",
				callback_id: "ask_dot",
				title: { type: "plain_text", text: "Ask dot" },
				submit: { type: "plain_text", text: "Ask" },
				close: { type: "plain_text", text: "Cancel" },
				private_metadata: JSON.stringify({
					channel: shortcut.channel.id,
					ts: shortcut.message.ts,
					threadTs: shortcut.message.thread_ts,
				}),
				blocks: [
					{
						type: "input",
						block_id: "question",
						optional: true,
						label: {
							type: "plain_text",
							text: "What should I do with this message?",
						},
						element: {
							type: "plain_text_input",
							action_id: "text",
							multiline: true,
							placeholder: {
								type: "plain_text",
								text: "Leave empty and I'll work out how to help.",
							},
						},
					},
				],
			},
		})
	})
	app.view("ask_dot", async ({ ack, view, body, client, context }) => {
		await ack()
		if (!isAllowed(body.user.id)) return
		const { channel, ts, threadTs } = JSON.parse(view.private_metadata) as {
			channel: string
			ts: string
			threadTs?: string
		}
		void handle(client, config, botUserId, {
			channel,
			ts,
			threadTs: threadTs && threadTs !== ts ? threadTs : undefined,
			isDm: channel.startsWith("D"),
			teamId: context.teamId!,
			userId: body.user.id,
			via: "shortcut",
			request: view.state.values.question?.text?.value ?? "",
		})
	})
}

/** Where a scheduled task's answer goes. */
async function jobTarget(
	client: WebClient,
	job: Job,
): Promise<{ channel: string; threadTs?: string }> {
	if (job.post === "thread")
		return { channel: job.channel, threadTs: job.threadTs }
	if (job.post === "channel") return { channel: job.channel }
	const { channel } = await client.conversations.open({ users: job.userId })
	return { channel: channel!.id! }
}

async function postTo(
	client: WebClient,
	target: { channel: string; threadTs?: string },
	text: string,
) {
	for (const part of chunkMarkdown(text)) {
		await client.chat.postMessage({
			channel: target.channel,
			...(target.threadTs ? { thread_ts: target.threadTs } : {}),
			markdown_text: part,
		})
	}
}

/**
 * Runs scheduled tasks (see scheduler.ts): a fresh Codex turn for the person who set the task up,
 * with their memory, posted where they asked unless it replies [SILENT].
 */
export function scheduledRunner(client: WebClient, config: BotConfig) {
	const run = async (job: Job): Promise<RunOutcome> => {
		const user = { teamId: job.teamId, userId: job.userId }
		const label = `_:alarm_clock: ${job.name}_`
		const target = await jobTarget(client, job)
		const where =
			job.post === "dm"
				? "to them in a direct message"
				: job.post === "channel"
					? "in the channel"
					: "in the thread where it was set up"
		const requester = await userName(client, job.userId)
		const input = [
			`Scheduled task "${job.name}", set up by ${requester} (<@${job.userId}>) on ${job.createdAt.slice(0, 10)}; ${describeWhen(job)}.`,
			"",
			`Task: ${job.task}`,
			"",
			`Do it now. Your reply is posted ${where} as-is${job.post === "dm" ? "" : `; mention <@${job.userId}> if it's a reminder or needs their attention`}. If there's nothing worth posting this time (e.g. nothing changed), reply exactly [SILENT].`,
		].join("\n")
		try {
			const usage = usagePause()
			if (usage)
				throw new TurnFailed({
					...classify(new Error("usage limit")),
					message: usage,
				})
			const result = await runTurn({
				config,
				user,
				input,
				slack: {
					channel: job.channel,
					threadTs: job.threadTs,
					timezone: job.timezone,
					scheduled: true,
				},
			})
			const silent =
				result.text.trim() === "[SILENT]" && !result.files.length
			console.log(
				`[scheduler] ${job.id} "${job.name}" ran${silent ? " (silent)" : ""}`,
			)
			if (silent) return "done"
			await postTo(client, target, `${label}\n\n${result.text}`)
			await uploadFiles(
				client,
				target.channel,
				target.threadTs,
				result.files,
			).catch(error =>
				console.error(`[scheduler] ${job.id} upload failed`, error),
			)
			void afterTurn(config, user, {
				place: `scheduled task "${job.name}"`,
				thread: `${job.channel}:${job.threadTs}`,
				messages: `[scheduled] ${job.task}`,
				reply: result.text,
			}).catch(() => {})
			return "done"
		} catch (error) {
			const failure =
				error instanceof TurnFailed
					? error.failure
					: classify(error, { utcClock: config.runtime === "docker" })
			console.error(
				`[scheduler] ${job.id} "${job.name}" failed (${failure.kind}):`,
				error,
			)
			if (failure.kind === "usage_limit") pauseForUsageLimit(failure)
			if (!willRetry(job))
				await postTo(
					client,
					target,
					`${label}\n\n:warning: This scheduled task failed: ${failure.message}`,
				).catch(() => {})
			return "failed"
		}
	}

	const missed = async (job: Job) => {
		const target = await jobTarget(client, job)
		const due = new Intl.DateTimeFormat("en-GB", {
			timeZone: job.timezone,
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(job.at!))
		await postTo(
			client,
			target,
			`_:alarm_clock: ${job.name}_\n\n:warning: I was offline when this was due (${due}), so it didn't run. Ask me again if you still need it.`,
		)
	}

	return { run, missed }
}
