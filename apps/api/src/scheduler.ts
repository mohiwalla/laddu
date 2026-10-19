/**
 * Scheduled tasks ("every Monday 9am, summarize #sales", "remind me tomorrow at 5"), in the spirit
 * of Hermes Agent's cron (MIT, Nous Research): each run is a fresh Codex turn for the person who set
 * it up, its answer is posted where they asked, and a run can reply [SILENT] to post nothing.
 * Jobs live in .data/schedules.json; the bot checks them every 30 seconds.
 */
import { paths } from "./config"
import { readJson, writeJsonPrivate } from "./files"

export type Job = {
	id: string
	teamId: string
	userId: string
	/** Short label, e.g. "Weekly #sales summary". */
	name: string
	/** What to do, written to stand on its own: the run starts a fresh conversation. */
	task: string
	/** Five-field cron in `timezone` (recurring), or `at` (once). */
	cron?: string
	at?: string
	timezone: string
	/** Where the answer goes: the thread it was set up in, that channel, or a DM. */
	post: "thread" | "channel" | "dm"
	channel: string
	threadTs: string
	createdAt: string
	/** UTC minute ("2026-10-16T03:30") of the last run, so a minute never runs twice. */
	lastRun?: string
	failures?: number
}

const MAX_JOBS_PER_USER = 20
const TICK_MS = 30_000
/** A one-off job missed by more than this (the bot was down) is reported, not run late. */
const LATE_LIMIT_MS = 6 * 60 * 60 * 1000
/** One-off retries after a failed run, then it's reported as failed (Hermes uses the same ladder). */
const RETRY_DELAYS_MIN = [5, 15, 30]

const file = `${paths.dataDir}/schedules.json`
let jobs: Job[] | null = null
let chain: Promise<unknown> = Promise.resolve()

async function load(): Promise<Job[]> {
	jobs ??= (await readJson<Job[]>(file)) ?? []
	return jobs
}

/** Applies a change to the job list and saves it, one change at a time. */
function change<T>(apply: (all: Job[]) => T): Promise<T> {
	const next = chain.then(async () => {
		const all = await load()
		const result = apply(all)
		await writeJsonPrivate(file, all)
		return result
	})
	chain = next.catch(() => {})
	return next
}

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

/** Wall-clock parts of `date` in `timezone`. */
function zoned(date: Date, timezone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		})
			.formatToParts(date)
			.map(part => [part.type, part.value]),
	)
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
		parts.weekday!,
	)
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		weekday,
	}
}

export function validTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone })
		return true
	} catch {
		return false
	}
}

/** "2026-10-16 17:00" in `timezone` → the UTC instant. */
export function zonedToUtc(local: string, timezone: string): Date | null {
	const match = local
		.trim()
		.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/)
	if (!match) return null
	const [, y, mo, d, h, mi] = match.map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	]
	const wanted = Date.UTC(y, mo - 1, d, h, mi)
	// Guess, see how far off the zone's wall clock is, correct; twice covers DST edges.
	let guess = wanted
	for (let i = 0; i < 2; i++) {
		const seen = zoned(new Date(guess), timezone)
		guess +=
			wanted -
			Date.UTC(
				seen.year,
				seen.month - 1,
				seen.day,
				seen.hour,
				seen.minute,
			)
	}
	return new Date(guess)
}

/** One cron field ("*", "5", "1-5", "*\/2", "1,15") against a value. */
function fieldMatches(
	field: string,
	value: number,
	min: number,
	max: number,
): boolean {
	return field.split(",").some(part => {
		const [range, stepText] = part.split("/") as [string, string?]
		const step = stepText ? Number(stepText) : 1
		const [from, to] =
			range === "*"
				? [min, max]
				: range.includes("-")
					? range.split("-").map(Number)
					: [Number(range), Number(range)]
		return value >= from! && value <= to! && (value - from!) % step === 0
	})
}

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/

/** Why a cron expression is refused, or null if it's fine. Minimum recurring interval: one minute. */
export function cronProblem(cron: string): string | null {
	const fields = cron.trim().split(/\s+/)
	if (fields.length !== 5)
		return 'use five fields: "minute hour day-of-month month day-of-week"; minimum interval is one minute'
	if (!fields.every(field => CRON_FIELD.test(field)))
		return "only numbers, *, ranges (1-5), lists (1,3) and steps (*/2)"
	return null
}

function cronMatches(cron: string, date: Date, timezone: string): boolean {
	const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/) as [
		string,
		string,
		string,
		string,
		string,
	]
	const now = zoned(date, timezone)
	const dayOk = fieldMatches(day, now.day, 1, 31)
	const weekdayOk = fieldMatches(
		weekday.replace(/\b7\b/g, "0"),
		now.weekday,
		0,
		6,
	)
	// Classic cron: if both day fields are restricted, either may match.
	const days =
		day !== "*" && weekday !== "*" ? dayOk || weekdayOk : dayOk && weekdayOk
	return (
		fieldMatches(minute, now.minute, 0, 59) &&
		fieldMatches(hour, now.hour, 0, 23) &&
		fieldMatches(month, now.month, 1, 12) &&
		days
	)
}

/** The next time a job runs, scanning up to ~5 weeks ahead (enough for anything but yearly jobs). */
export function nextRun(
	job: Pick<Job, "cron" | "at" | "timezone" | "lastRun">,
	from = new Date(),
): Date | null {
	if (job.at) return job.lastRun ? null : new Date(job.at)
	const start = Math.ceil(from.getTime() / 60_000) * 60_000
	for (
		let t = start, end = start + 35 * 24 * 60 * 60_000;
		t < end;
		t += 60_000
	) {
		if (cronMatches(job.cron!, new Date(t), job.timezone))
			return new Date(t)
	}
	return null
}

export function describeWhen(job: Job): string {
	const next = nextRun(job)
	const when = next
		? new Intl.DateTimeFormat("en-GB", {
				timeZone: job.timezone,
				weekday: "short",
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			}).format(next)
		: "no upcoming run"
	return job.cron
		? `cron "${job.cron}" (${job.timezone}), next ${when}`
		: `once, ${when} (${job.timezone})`
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────

export const listJobs = async (teamId: string, userId: string) =>
	(await load()).filter(job => job.teamId === teamId && job.userId === userId)

export function addJob(
	job: Omit<Job, "id" | "createdAt">,
): Promise<Job | string> {
	return change(all => {
		if (
			all.filter(
				other =>
					other.teamId === job.teamId && other.userId === job.userId,
			).length >= MAX_JOBS_PER_USER
		)
			return `You already have ${MAX_JOBS_PER_USER} scheduled tasks; remove one first.`
		const created: Job = {
			...job,
			id: crypto.randomUUID().slice(0, 8),
			createdAt: new Date().toISOString(),
		}
		all.push(created)
		return created
	})
}

export function removeJob(
	teamId: string,
	userId: string,
	id: string,
): Promise<boolean> {
	return change(all => {
		const index = all.findIndex(
			job =>
				job.id === id && job.teamId === teamId && job.userId === userId,
		)
		if (index >= 0) all.splice(index, 1)
		return index >= 0
	})
}

export type RunOutcome = "done" | "failed"

/** Whether a failed run of this job will be tried again (one-offs, on the retry ladder). */
export const willRetry = (job: Job) =>
	Boolean(job.at) && (job.failures ?? 0) < RETRY_DELAYS_MIN.length

/**
 * Starts the 30-second check. `run` does one job (a Codex turn plus posting) and reports how it
 * went; `missed` reports a one-off the bot was down for.
 */
export function startScheduler(handlers: {
	run: (job: Job) => Promise<RunOutcome>
	missed: (job: Job) => Promise<void>
}) {
	const running = new Set<string>()

	const tick = async () => {
		const now = new Date()
		const minute = now.toISOString().slice(0, 16)
		for (const job of await load()) {
			if (running.has(job.id)) continue
			let due = false
			if (job.cron)
				due =
					job.lastRun !== minute &&
					cronMatches(job.cron, now, job.timezone)
			else if (job.at && !job.lastRun) {
				const at = new Date(job.at).getTime()
				if (now.getTime() - at > LATE_LIMIT_MS) {
					await change(() => void removeFrom(job.id))
					void handlers
						.missed(job)
						.catch(error =>
							console.warn(
								"[scheduler] missed note failed:",
								error,
							),
						)
					continue
				}
				due = now.getTime() >= at
			}
			if (!due) continue

			running.add(job.id)
			await change(
				all =>
					void (
						find(all, job.id) &&
						(find(all, job.id)!.lastRun = minute)
					),
			)
			void handlers
				.run(job)
				.catch((): RunOutcome => "failed")
				.then(outcome =>
					change(all => {
						const current = find(all, job.id)
						if (!current) return
						if (outcome === "done") {
							current.failures = 0
							if (current.at) removeFrom(job.id)
							return
						}
						current.failures = (current.failures ?? 0) + 1
						// One-off: try again on the ladder, then give up (the runner has posted why).
						const delay = RETRY_DELAYS_MIN[current.failures - 1]
						if (current.at && delay !== undefined) {
							current.at = new Date(
								Date.now() + delay * 60_000,
							).toISOString()
							current.lastRun = undefined
						} else if (current.at) removeFrom(job.id)
					}),
				)
				.finally(() => running.delete(job.id))
		}
	}

	const find = (all: Job[], id: string) => all.find(job => job.id === id)
	const removeFrom = (id: string) => {
		const index = jobs!.findIndex(job => job.id === id)
		if (index >= 0) jobs!.splice(index, 1)
	}

	setInterval(
		() =>
			void tick().catch(error =>
				console.error("[scheduler] tick failed:", error),
			),
		TICK_MS,
	)
	void tick().catch(error => console.error("[scheduler] tick failed:", error))
}
