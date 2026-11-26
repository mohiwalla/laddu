/**
 * Detects when an agent ends a Slack turn prematurely with unfinished work and no run-wide
 * blocker, so handlers.ts can automatically continue the same thread before posting a partial
 * reply. Applies across all agents (Codex, Claude Code, Antigravity, OpenCode).
 */
import type { Todos } from "./steps"

/** Maximum automatic continuations within one user request (prevents runaway loops). */
export const MAX_CONTINUATIONS = 4

export type ContinuationCheck = {
	/** The agent's final reply text for the sub-turn that just ended. */
	text: string
	/** How many tool/action steps the agent executed in that sub-turn. */
	steps: number
	/** Latest to-do list state (from `slack todo` or an agent plan), if any. */
	todos?: Todos
	/** The user's own typed request text, if any. */
	request?: string
	/** True when the turn is waiting on human input (question, approval, or key form). */
	waitingOnUser: boolean
	/** Number of automatic continuations already run for this request. */
	continuations: number
}

export type Continuation = {
	/** Short diagnostic label for logs. */
	reason: "unfinished_todos" | "incomplete_reply"
	/** Prompt sent to resume the same agent thread. */
	prompt: string
}

const SPECIAL_REPLY = /^(?:\[SKIP\]|\[SILENT\]|\[REACT:[a-z0-9_+'-]+\])$/i

const REQUESTED_PARTIAL =
	/\b(?:partial|sample|first\s+\d+|only\s+(?:the\s+)?first\s+\d+|stop\s+after|just\s+\d+|check\s+\d+\s+(?:leads?|rows?|companies?|items?))\b/i

/** Natural exhaustion of the input set (valid reason to stop short of a numeric target). */
const EXHAUSTED_INPUT =
	/\b(?:no\s+more\s+(?:candidates|results|leads|rows|pages|items)|candidates?\s+(?:are\s+)?exhausted|ran\s+out\s+of\s+(?:candidates|results|leads|credits|quota))\b/i

/** Clauses that negate a blocker ("No LinkedIn CAPTCHA or rate limit appeared"). */
const NEGATED_CLAUSE =
	/\b(?:no|without|neither|nor|none\s+of|didn['’]t|did\s+not|wasn['’]t|was\s+not|weren['’]t|were\s+not|isn['’]t|is\s+not|aren['’]t|are\s+not|not\s+(?:a|any|blocked|forced|caused|due\s+to))\b/i

/** Genuine run-wide blockers that legitimately stop further progress. */
const RUN_WIDE_BLOCKER =
	/\b(?:(?:hit|reached|exceeded|exhausted|out\s+of)\s+(?:its\s+|the\s+|my\s+|your\s+)?(?:(?:monthly|daily|hourly|weekly|api|search|rate|usage|credit)\s+)*(?:limit|quota|credits?)|rate[- ]limit(?:ed|s)?|too\s+many\s+requests|http\s+429|\b429\b|captcha|verify\s+you\s+are\s+human|logged\s+out|session\s+expired|sign\s+in\s+(?:again|first|to\s+continue)|reauthorize|re-?authenticate|lacks?\s+[\w-]+\s+(?:billing\s+)?access|requires?\s+the\s+\w+\s+plan|permission\s+denied|access\s+denied|stopped\s+responding|browser\s+crashed|couldn['’]t\s+reopen)\b/i

/** Explicit self-reports that the agent stopped mid-task with remaining work. */
const SELF_REPORTED_INCOMPLETE: RegExp[] = [
	/\b(?:the\s+)?(?:research|batch|run|work|task|verification|search|screening|enrichment|check|audit|workbook)\s+is\s+(?:still\s+)?incomplete\b/i,
	/\b(?:i|we)\s+(?:didn['’]t|did\s+not|couldn['’]t|could\s+not|haven['’]t|have\s+not)\s+(?:finish|complete)\b/i,
	/\b(?:this|the)\s+(?:run|turn)\s+ended\s+(?:before|early)\b/i,
	/\b(?:i|we)\s+(?:ended|stopped)\s+(?:the\s+)?(?:run|turn|search|work)\s+(?:before|early|too\s+early)\b/i,
	/\b(?:partial\s+(?:workbook|batch|csv|export|results?|file|output|progress|deliverable)|-partial\.(?:xlsx|csv|json|md))\b/i,
	/\b(?:still\s+need(?:s)?\s+(?:public\s+|further\s+)?(?:checks?|research|verification|validation)|marked\s+\*{0,2}research\s+pending\*{0,2}|remaining\s+(?:results?|leads?|rows?|companies?|items?)\s+(?:haven['’]t|have\s+not|weren['’]t|were\s+not|still\s+need))\b/i,
	/\b(?:no\s+(?:\d+-lead\s+|csv\s+)?batch(?:es)?\s+(?:sent|finalized|ready))\b/i,
]

/** True when the reply reports a genuine run-wide blocker rather than a voluntary early stop. */
export function reportsBlocker(text: string): boolean {
	const clauses = text
		.split(/[.!?\n;]+/)
		.map(clause => clause.trim())
		.filter(Boolean)
	for (const clause of clauses) {
		if (EXHAUSTED_INPUT.test(clause)) return true
		if (NEGATED_CLAUSE.test(clause)) continue
		if (RUN_WIDE_BLOCKER.test(clause)) return true
	}
	return false
}

/**
 * Returns a continuation prompt if the agent appears to have stopped early without finishing the
 * requested work or hitting a genuine run-wide blocker; null when the turn should finish as-is.
 */
export function earlyStopContinuation(
	check: ContinuationCheck,
): Continuation | null {
	if (check.continuations >= MAX_CONTINUATIONS) return null
	if (check.waitingOnUser) return null
	// Zero tool steps means a conversational answer (or a continuation confirming completion/blocker).
	if (check.steps <= 0) return null
	const trimmed = check.text.trim()
	if (!trimmed || SPECIAL_REPLY.test(trimmed)) return null
	if (reportsBlocker(trimmed)) return null

	const unfinished =
		check.todos?.items.filter(item => item.status !== "completed") ?? []
	if (unfinished.length > 0) {
		const listed = unfinished
			.slice(0, 6)
			.map(item => `- ${item.text}`)
			.join("\n")
		return {
			reason: "unfinished_todos",
			prompt: [
				"Your previous reply was not sent to Slack yet (and any files in its outbox were not uploaded yet) because your to-do list still has unfinished items:",
				listed,
				"",
				"Do not stop early with incomplete work. Keep working in this thread until every requested item is finished, mark the to-do list complete, and save the final deliverables in this turn's outbox. If the work is already complete as asked, or a genuine run-wide blocker stops further progress, update the to-do list and reply clearly with the final answer.",
			].join("\n"),
		}
	}

	if (check.request && REQUESTED_PARTIAL.test(check.request)) return null

	if (SELF_REPORTED_INCOMPLETE.some(pattern => pattern.test(trimmed))) {
		return {
			reason: "incomplete_reply",
			prompt: [
				"Your previous reply was not sent to Slack yet (and any files in its outbox were not uploaded yet) because it reports incomplete work without a run-wide blocker.",
				"",
				"Do not end the turn with a partial batch or unresearched pending items — ending the turn stops all work in Slack. Keep working in this thread until the full requested scope is finished (checkpoint progress to disk, script or parallelize large batches, and use `slack post` only for agreed milestones while continuing). Save the final deliverables in this turn's outbox once done. If the request is actually complete as asked, or a genuine run-wide blocker prevents continuing, reply clearly with that final answer.",
			].join("\n"),
		}
	}

	return null
}
