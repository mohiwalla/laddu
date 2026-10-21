/**
 * Why a turn failed and what to do about it, in the spirit of Hermes Agent's error classifier
 * (MIT, Nous Research): each kind gets a plain message and a recovery instead of a raw error.
 * Codex retries dropped model connections itself, so a turn-level retry is a second line.
 */
import { AuthError } from "../auth/siwc"
import { LostSessionError } from "./acp"

export type Failure = {
	kind:
		| "auth"
		| "usage_limit"
		| "context_full"
		| "unsupported"
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

/** `docker` runtime: times in Codex's messages come from the container's clock, which is UTC. */
export function classify(error: unknown, { utcClock = false } = {}): Failure {
	if (error instanceof AuthError) return fail("auth", error.message)
	if (error instanceof LostSessionError)
		return fail("lost_thread", "I lost track of this conversation.", {
			retry: true,
			resetThread: true,
		})
	if (error instanceof Bun.$.ShellError) {
		// Docker commands (creating the container, copying files in): usually a hiccup worth one retry.
		const detail = firstLine(error.stderr.toString() || error.message)
		return fail(
			"workspace",
			`I couldn't get your workspace ready (${detail}).`,
			{ retry: true, retryAfterMs: 5_000 },
		)
	}

	const text = error instanceof Error ? error.message : String(error)
	if (/usage limit/i.test(text)) {
		const when = text.match(/try again at\s+([^.\n]+?)\s*\.?\s*$/im)?.[1]
		return fail(
			"usage_limit",
			when
				? `The ChatGPT plan I run on has hit its usage limit; it resets at ${when}${utcClock ? " UTC" : ""}. Please try again then.`
				: "The ChatGPT plan I run on has hit its usage limit. Please try again later.",
		)
	}
	if (/ran out of room|context window/i.test(text)) {
		return fail(
			"context_full",
			"This thread got too long for me to hold.",
			{ retry: true, resetThread: true },
		)
	}
	if (text.includes("subscription_sharing_unsupported_capability")) {
		return fail(
			"unsupported",
			"That hit something the ChatGPT plan can't run.",
			{ retry: true, resetThread: true },
		)
	}
	if (
		/stream disconnected|connection failed|exceeded retry limit|unexpected status (429|5\d\d)|overloaded|timed? ?out|ECONNRESET|socket hang up/i.test(
			text,
		)
	) {
		return fail("transient", "I lost the connection to the model.", {
			retry: true,
			retryAfterMs: 15_000,
		})
	}
	return fail("unknown", `Something went wrong: ${firstLine(text)}`)
}

/** After a usage-limit failure, skip Codex for a while instead of failing every request slowly. */
const PAUSE_MS = 10 * 60 * 1000
let paused: { until: number; message: string } | null = null

export function pauseForUsageLimit(failure: Failure) {
	paused = { until: Date.now() + PAUSE_MS, message: failure.message }
}

/** The usage-limit message while paused, else null. */
export function usagePause(): string | null {
	if (paused && Date.now() > paused.until) paused = null
	return paused?.message ?? null
}
