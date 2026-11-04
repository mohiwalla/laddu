/**
 * Why a turn failed and what to do about it, in the spirit of Hermes Agent's error classifier
 * (MIT, Nous Research): each kind gets a plain message and a recovery instead of a raw error.
 * Codex retries dropped model connections itself, so a turn-level retry is a second line.
 */
import { systemName } from "../slack/system"
import { LostSessionError } from "./acp"

/** A Codex turn for someone who hasn't signed in to ChatGPT yet (see account.ts). */
export class NotSignedInError extends Error {
	constructor() {
		super("Not signed in to ChatGPT")
	}
}

export type Failure = {
	kind:
		| "auth"
		| "usage_limit"
		| "free_limit"
		| "context_full"
		| "lost_thread"
		| "transient"
		| "workspace"
		| "unknown"
	/** What the person sees, without the "Something went wrong" boilerplate. */
	message: string
	/** Try the turn again (after `retryAfterMs`). */
	retry: boolean
	retryAfterMs: number
	/** Start a fresh conversation with the agent; resuming this one would fail the same way. */
	resetThread: boolean
}

const fail = (
	kind: Failure["kind"],
	message: string,
	options: Partial<Failure> = {},
): Failure => ({
	kind,
	message,
	retry: false,
	retryAfterMs: 0,
	resetThread: false,
	...options,
})

const firstLine = (text: string) => text.trim().split("\n")[0]!.slice(0, 300)

export function classify(error: unknown): Failure {
	if (error instanceof NotSignedInError)
		return fail(
			"auth",
			`ChatGPT isn't connected. Connect it under Settings on ${systemName()}'s Home tab, then send your message again.`,
		)
	if (error instanceof LostSessionError)
		return fail("lost_thread", `${systemName()} lost track of this conversation.`, {
			retry: true,
			resetThread: true,
		})
	if (error instanceof Bun.$.ShellError) {
		// Docker commands (creating the container, copying files in): usually a hiccup worth one retry.
		const detail = firstLine(error.stderr.toString() || error.message)
		return fail(
			"workspace",
			`Couldn't start your workspace (${detail}). Send your message again.`,
			{ retry: true, retryAfterMs: 5_000 },
		)
	}

	const text = error instanceof Error ? error.message : String(error)
	// OpenCode's free models; only those who picked OpenCode are held up, so no pause for everyone.
	if (/free usage limit/i.test(text))
		return fail(
			"free_limit",
			`OpenCode's free models hit their usage limit. Try again later, or switch to Codex under Settings on ${systemName()}'s Home tab.`,
		)
	if (/usage limit/i.test(text)) {
		const when = text.match(/try again at\s+([^.\n]+?)\s*\.?\s*$/im)?.[1]
		return fail(
			"usage_limit",
			when
				? `Your ChatGPT plan hit its usage limit. It resets at ${when} UTC.`
				: "Your ChatGPT plan hit its usage limit. Try again later.",
		)
	}
	if (/ran out of room|context window/i.test(text)) {
		return fail(
			"context_full",
			"This thread got too long.",
			{ retry: true, resetThread: true },
		)
	}
	if (
		/stream disconnected|connection failed|exceeded retry limit|unexpected status (429|5\d\d)|overloaded|timed? ?out|ECONNRESET|socket hang up/i.test(
			text,
		)
	) {
		return fail("transient", "Lost the connection to the model. Send your message again.", {
			retry: true,
			retryAfterMs: 15_000,
		})
	}
	return fail("unknown", `Something went wrong: ${firstLine(text)}`)
}

/**
 * After a usage-limit failure, skip Codex for that person for a while instead of failing every
 * request slowly. Per person: each runs on their own plan.
 */
const PAUSE_MS = 10 * 60 * 1000
const paused = new Map<string, { until: number; message: string }>()
const personKey = (person: { teamId: string; userId: string }) =>
	`${person.teamId}-${person.userId}`

export function pauseForUsageLimit(
	person: { teamId: string; userId: string },
	failure: Failure,
) {
	paused.set(personKey(person), {
		until: Date.now() + (failure.retryAfterMs || PAUSE_MS),
		message: failure.message,
	})
}

/** Their usage-limit message while paused, else null. */
export function usagePause(person: {
	teamId: string
	userId: string
}): string | null {
	const pause = paused.get(personKey(person))
	if (pause && Date.now() > pause.until) paused.delete(personKey(person))
	return paused.get(personKey(person))?.message ?? null
}
