/**
 * Detects when an agent ends a Slack turn prematurely with unfinished work and no run-wide
 * blocker, so handlers.ts can automatically continue the same thread before posting a partial
 * reply. Applies across all agents (Codex, Claude Code, Antigravity, OpenCode).
 */
import type { Todos } from "./steps"
import type { OutFile } from "./turn"

/** Maximum automatic continuations within one user request (prevents runaway loops). */
export const MAX_CONTINUATIONS = 4

export type ContinuationCheck = {
	/** The agent's final reply text for the sub-turn that just ended. */
	text: string
	/** How many tool/action steps the agent executed in that sub-turn. */
	steps: number
	/** Latest to-do list state (from `slack todo` or an agent plan), if any. */
	todos?: Todos
	/** The user's own typed request text (and any steered follow-ups during this turn). */
	requests?: string[]
	/** True when the turn is waiting on human input (question, approval, or key form). */
	waitingOnUser: boolean
	/** Number of automatic continuations already run for this request. */
	continuations: number
	/** Files saved in the previous sub-turn's outbox that haven't been uploaded yet. */
	withheldFiles?: string[]
}

export type Continuation = {
	/** Short diagnostic label for logs. */
	reason: "unfinished_todos" | "incomplete_reply"
	/** Prompt sent to resume the same agent thread. */
	prompt: string
}

const SPECIAL_REPLY = /^(?:\[SKIP\]|\[SILENT\]|\[REACT:[a-z0-9_+'-]+\])$/i

/** Negated phrasing in a user request ("never send a partial CSV", "don't stop after 50"). */
const NEGATED_REQUEST = /\b(?:never|no|not|don['’]t|do\s+not|without|avoid)\b/i

/**
 * Explicit user-imposed scope caps or sample requests. Bare numeric targets ("check 500 leads",
 * "send the first 50 and keep going") intentionally do NOT match.
 */
const EXPLICIT_PARTIAL_REQUEST =
	/\b(?:(?:only|just)\s+(?:the\s+)?first\s+\d+|(?:use|check|do|verify|send)\s+(?:the\s+)?first\s+\d+\s+only|stop\s+after\s+(?:the\s+)?(?:first\s+)?\d+|(?:send|build|make|create|give(?:\s+me)?)\s+(?:a\s+)?(?:sample|partial)\s+(?:workbook|csv|batch|file|output|results?)|partial\s+(?:workbook|csv|batch|results?|output)\s+(?:for\s+now|only|first)|just\s+a\s+(?:sample|partial))\b/i

/** Natural exhaustion of the input set (valid reason to stop short of a numeric target). */
const EXHAUSTED_INPUT =
	/\b(?:no\s+more\s+(?:candidates|results|leads|rows|pages|items)|candidates?\s+(?:are\s+)?exhausted|ran\s+out\s+of\s+(?:candidates|results|leads|credits|quota))\b/i

/** Clauses that negate a blocker ("No LinkedIn CAPTCHA or rate limit appeared"). */
const NEGATED_CLAUSE =
	/\b(?:no|without|neither|nor|none\s+of|didn['’]t|did\s+not|wasn['’]t|was\s+not|weren['’]t|were\s+not|isn['’]t|is\s+not|aren['’]t|are\s+not|not\s+(?:a|any|blocked|forced|caused|due\s+to))\b/i

/** Clauses indicating a failure affected only one optional source/item while work can continue. */
const SINGLE_SOURCE_SCOPE =
	/\b(?:one\s+(?:optional\s+)?(?:source|site|page|company|domain|provider|lead)|an?\s+optional\s+(?:source|site|provider)|individual\s+(?:site|source|company|lead|failure|block)|its\s+(?:official\s+)?website|other\s+(?:sources?|sites?|companies|leads|results)\s+(?:remain|are)\s+available|remaining\s+(?:sources?|sites?|companies|leads)\s+(?:are\s+)?(?:available|unblocked))\b/i

/** Blockers that are inherently account-wide, session-wide, or tool-wide. */
const GLOBAL_BLOCKER =
	/\b(?:(?:hit|reached|exceeded|exhausted|out\s+of)\s+(?:its\s+|the\s+|my\s+|your\s+)?(?:(?:monthly|daily|hourly|weekly|api|search|rate|usage|credit)\s+)*(?:limit|quota|credits?)|logged\s+out|session\s+expired|sign\s+in\s+(?:again|first|to\s+continue)|reauthorize|re-?authenticate|lacks?\s+[\w-]+\s+(?:billing\s+)?access|requires?\s+the\s+\w+\s+plan|stopped\s+responding|browser\s+crashed|couldn['’]t\s+reopen)\b/i

/** Rate-limit / access blockers that only stop the whole run when not scoped to one optional source. */
const SCOPED_BLOCKER =
	/\b(?:rate[- ]limit(?:ed|s)?|too\s+many\s+requests|http\s+429|\b429\b|captcha|verify\s+you\s+are\s+human|permission\s+denied|access\s+denied)\b/i

/** Explicit self-reports that the agent stopped mid-task with remaining work. */
const SELF_REPORTED_INCOMPLETE: RegExp[] = [
	/\b(?<!(?:uploaded|input|source|supplied|existing|original|your|their)\s+)(?:the\s+)?(?:research|batch|run|work|task|verification|search|screening|enrichment|check|audit|workbook)\s+is\s+(?:still\s+)?incomplete\b/i,
	/\b(?:i|we)\s+(?:didn['’]t|did\s+not|couldn['’]t|could\s+not|haven['’]t|have\s+not)\s+(?:finish|complete)\b/i,
	/\b(?:this|the)\s+(?:run|turn)\s+ended\s+(?:before|early)\b/i,
	/\b(?:i|we)\s+(?:ended|stopped)\s+(?:the\s+)?(?:run|turn|search|work)\s+(?:before|early|too\s+early)\b/i,
	/\b(?:partial\s+(?:workbook|batch|csv|export|results?|file|output|progress|deliverable)|-partial\.(?:xlsx|csv|json|md))\b/i,
	/\b(?:still\s+need(?:s)?\s+(?:public\s+|further\s+)?(?:checks?|research|verification|validation)|marked\s+\*{0,2}research\s+pending\*{0,2}|remaining\s+(?:results?|leads?|rows?|companies?|items?)\s+(?:haven['’]t|have\s+not|weren['’]t|were\s+not|still\s+need))\b/i,
	/\b(?:no\s+(?:\d+-lead\s+|csv\s+)?batch(?:es)?\s+(?:sent|finalized|ready))\b/i,
]

const REFUSES_ATTACHMENT =
	/\b(?:haven['’]t|have\s+not|didn['’]t|did\s+not|not)\s+(?:sent|attached|uploaded|included)\b/i

const splitClauses = (text: string) =>
	text
		.split(/[.!?\n;]+/)
		.map(clause => clause.trim())
		.filter(Boolean)

/** True when any user message in this turn explicitly asked for a partial/sample or early stop. */
export function isExplicitPartialRequest(requests: string[] = []): boolean {
	for (const request of requests) {
		for (const clause of splitClauses(request)) {
			if (NEGATED_REQUEST.test(clause)) continue
			if (EXPLICIT_PARTIAL_REQUEST.test(clause)) return true
		}
	}
	return false
}

/** True when the reply reports a genuine run-wide blocker rather than a voluntary early stop. */
export function reportsBlocker(text: string): boolean {
	const clauses = splitClauses(text)
	const replyNotesOtherSourcesAvailable = SINGLE_SOURCE_SCOPE.test(text)
	for (const clause of clauses) {
		if (EXHAUSTED_INPUT.test(clause)) return true
		if (NEGATED_CLAUSE.test(clause)) continue
		if (GLOBAL_BLOCKER.test(clause)) return true
		if (
			SCOPED_BLOCKER.test(clause) &&
			!SINGLE_SOURCE_SCOPE.test(clause) &&
			!replyNotesOtherSourcesAvailable
		)
			return true
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
	if (trimmed && SPECIAL_REPLY.test(trimmed)) return null
	if (trimmed && reportsBlocker(trimmed)) return null
	if (isExplicitPartialRequest(check.requests)) return null

	const withheldNote = check.withheldFiles?.length
		? ` Withheld files from your earlier outbox (not uploaded): ${check.withheldFiles.join(", ")}.`
		: ""

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
				`Your previous reply was not sent to Slack yet because your to-do list still has unfinished items:${withheldNote}`,
				listed,
				"",
				"Do not stop early with incomplete work. Keep working in this thread until every requested item is finished, mark the to-do list complete, and save any final deliverables in this turn's outbox. If the work is already complete as asked, or a genuine run-wide blocker stops further progress, update the to-do list and reply clearly with the final answer.",
			].join("\n"),
		}
	}

	if (!trimmed) return null

	if (SELF_REPORTED_INCOMPLETE.some(pattern => pattern.test(trimmed))) {
		return {
			reason: "incomplete_reply",
			prompt: [
				`Your previous reply was not sent to Slack yet because it reports incomplete work without a run-wide blocker.${withheldNote}`,
				"",
				"Do not end the turn with a partial batch or unresearched pending items — ending the turn stops all work in Slack. Keep working in this thread until the full requested scope is finished (checkpoint progress to disk, script or parallelize large batches, and use `slack post` only for agreed milestones while continuing). Save final deliverables in this turn's outbox once done. If the request is actually complete as asked, or a genuine run-wide blocker prevents continuing, reply clearly with that final answer.",
			].join("\n"),
		}
	}

	return null
}

/**
 * Resolves which outbox files should be uploaded after a continuation sub-turn.
 * - New files from the continuation replace earlier withheld/partial files.
 * - If the continuation wrote no new files, carry forward earlier files only when the final reply
 *   explicitly names them (without refusing to attach), or when a 0-step unfinished-todo check
 *   confirmed completion cleanly — preventing both dropped deliverables and leaked partial files.
 */
export function resolveContinuationFiles(
	previous: { files: OutFile[]; skipped: string[] },
	next: { text: string; files: OutFile[]; skipped: string[] },
	context: { reason: Continuation["reason"]; steps: number },
): { files: OutFile[]; skipped: string[] } {
	if (next.files.length > 0 || !previous.files.length) {
		return { files: next.files, skipped: next.skipped }
	}
	const trimmed = next.text.trim()
	const lower = trimmed.toLowerCase()
	if (!REFUSES_ATTACHMENT.test(trimmed)) {
		const referenced = previous.files.filter(file =>
			lower.includes(file.name.toLowerCase()),
		)
		if (referenced.length > 0) {
			return { files: referenced, skipped: previous.skipped }
		}
		if (
			context.steps === 0 &&
			context.reason === "unfinished_todos" &&
			!reportsBlocker(trimmed)
		) {
			return { files: previous.files, skipped: previous.skipped }
		}
	}
	return { files: [], skipped: next.skipped }
}
