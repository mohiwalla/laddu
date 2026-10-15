/**
 * A small API for dot's commands inside a container that need the bot itself: `schedule`, and
 * `ado` (Azure DevOps, whose tokens stay here).
 *
 * Each Codex turn gets a caller credential signed by this process: who the turn runs for and the
 * Slack thread it came from. The command sends it back, so a request can only act as that person,
 * in that conversation; changing any part of it breaks the signature. The variable is named
 * DOT_CALLER (no KEY/TOKEN/SECRET) so Codex passes it to the commands it runs. Listens on the
 * Docker bridge address (host runtime: localhost), like the model proxy.
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import * as azureDevOps from "../integrations/azure-devops"
import {
	addJob,
	cronProblem,
	describeWhen,
	listJobs,
	removeJob,
	validTimezone,
	zonedToUtc,
	type Job,
} from "../scheduler"

export type Caller = {
	teamId: string
	userId: string
	channel: string
	threadTs: string
	/** Set for scheduled runs, which can't create more scheduled tasks. */
	scheduled: boolean
}

const secret = crypto.getRandomValues(new Uint8Array(32))
const sign = (payload: string) =>
	new Bun.CryptoHasher("sha256", secret).update(payload).digest("base64url")

export function callerCredential(caller: Caller): string {
	const payload = [
		caller.teamId,
		caller.userId,
		caller.channel,
		caller.threadTs,
		caller.scheduled ? "1" : "0",
	].join(".")
	return `${payload}.${sign(payload)}`
}

/** Constant-time comparison, so response timing doesn't leak how much of a signature was right. */
function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let difference = 0
	for (let i = 0; i < a.length; i++)
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return difference === 0
}

function verify(credential: string | null): Caller | null {
	const parts = credential?.split(".") ?? []
	if (parts.length !== 7) return null
	const payload = parts.slice(0, 6).join(".")
	const expected = sign(payload)
	if (!sameString(parts[6]!, expected)) return null
	// threadTs contains a dot ("1792065097.615079"), hence 6 payload parts.
	const [teamId, userId, channel, tsSeconds, tsMicros, scheduled] = parts as [
		string,
		string,
		string,
		string,
		string,
		string,
	]
	return {
		teamId,
		userId,
		channel,
		threadTs: `${tsSeconds}.${tsMicros}`,
		scheduled: scheduled === "1",
	}
}

const reply = (status: number, text: string) =>
	Response.json({ ok: status < 400, text }, { status })

type NewJob = {
	name?: string
	task?: string
	cron?: string
	at?: string
	post?: string
	timezone?: string
}

async function handleSchedule(
	request: Request,
	caller: Caller,
	id: string | undefined,
): Promise<Response> {
	const { teamId, userId } = caller
	if (request.method === "GET") {
		const jobs = await listJobs(teamId, userId)
		if (!jobs.length) return reply(200, "No scheduled tasks.")
		return reply(
			200,
			jobs
				.map(
					job =>
						`${job.id}  ${job.name}  (${describeWhen(job)}; posts to ${job.post})\n    ${job.task}`,
				)
				.join("\n"),
		)
	}
	if (request.method === "DELETE" && id) {
		return (await removeJob(teamId, userId, id))
			? reply(200, `Removed ${id}.`)
			: reply(404, `No task ${id} of yours.`)
	}
	if (request.method !== "POST") return reply(405, "Use list, add or remove.")

	if (caller.scheduled)
		return reply(403, "A scheduled run can't schedule more tasks.")
	const body = (await request.json().catch(() => ({}))) as NewJob
	const task = body.task?.trim()
	if (!task)
		return reply(
			400,
			"Give the task: what to do when it runs, written to stand on its own.",
		)
	const timezone =
		body.timezone && validTimezone(body.timezone) ? body.timezone : "UTC"
	const post = (["thread", "channel", "dm"] as const).find(
		where => where === (body.post ?? "thread"),
	)
	if (!post) return reply(400, 'post must be "thread", "channel" or "dm".')
	if (Boolean(body.cron) === Boolean(body.at))
		return reply(
			400,
			"Give exactly one of --cron (recurring) or --at (once).",
		)

	let when: Pick<Job, "cron" | "at">
	if (body.cron) {
		const problem = cronProblem(body.cron)
		if (problem) return reply(400, `Bad cron: ${problem}.`)
		when = { cron: body.cron.trim().split(/\s+/).join(" ") }
	} else {
		const at = zonedToUtc(body.at!, timezone)
		if (!at)
			return reply(
				400,
				'Give --at as "YYYY-MM-DD HH:MM" in the person\'s time zone.',
			)
		if (at.getTime() < Date.now() - 60_000)
			return reply(400, `That time is in the past (${timezone}).`)
		when = { at: at.toISOString() }
	}

	const job = await addJob({
		teamId,
		userId,
		name: body.name?.trim() || task.slice(0, 60),
		task,
		...when,
		timezone,
		post,
		channel: caller.channel,
		threadTs: caller.threadTs,
	})
	if (typeof job === "string") return reply(409, job)
	return reply(
		200,
		`Scheduled ${job.id}: ${job.name} — ${describeWhen(job)}; posts to ${job.post}.`,
	)
}

async function handleAzureDevOps(
	request: Request,
	caller: Caller,
	action: string | undefined,
	deps: Deps,
): Promise<Response> {
	const settings = deps.config.azureDevOps
	if (!settings)
		return reply(
			501,
			"Azure DevOps isn't set up on this bot (the person running it needs to add AZURE_DEVOPS_CLIENT_ID; see docs/SETUP.md).",
		)
	const person = { teamId: caller.teamId, userId: caller.userId }
	try {
		if (action === "status" && request.method === "GET")
			return reply(200, await azureDevOps.status(settings, person))
		if (action === "connect" && request.method === "POST") {
			if (caller.scheduled)
				return reply(403, "A scheduled run can't start a sign-in.")
			return reply(
				200,
				await azureDevOps.connect(settings, deps.client, person),
			)
		}
		if (action === "connect" && request.method === "DELETE")
			return reply(
				200,
				(await azureDevOps.disconnect(person))
					? "Disconnected; dot no longer keeps their Azure DevOps sign-in."
					: "They weren't connected.",
			)
		if (action === "use" && request.method === "POST") {
			const { organization } = (await request
				.json()
				.catch(() => ({}))) as {
				organization?: string
			}
			const used = await azureDevOps.useOrganization(
				settings,
				person,
				organization ?? "",
			)
			if (used === null)
				return reply(409, "Not connected. Run `ado connect`.")
			return used
				? reply(200, `Default organization: ${used}.`)
				: reply(
						404,
						`They aren't in an organization called "${organization}".`,
					)
		}
		if (action === "write" && request.method === "POST") {
			const input = (await request.json().catch(() => null)) as
				(azureDevOps.AdoRequest & { summary?: string }) | null
			if (!input?.path) return reply(400, "Give the API path or URL.")
			const result = await azureDevOps.write(settings, person, input)
			return reply(result.status < 400 ? 200 : result.status, result.text)
		}
		if (action === "request" && request.method === "POST") {
			const input = (await request
				.json()
				.catch(() => null)) as azureDevOps.AdoRequest | null
			if (!input?.path) return reply(400, "Give the API path or URL.")
			const result = await azureDevOps.request(settings, person, input)
			return reply(result.status < 400 ? 200 : result.status, result.text)
		}
		return reply(404, "Use status, connect, use, request or write.")
	} catch (error) {
		console.warn("[azure-devops]", error)
		return reply(
			502,
			error instanceof azureDevOps.SignInError
				? error.message
				: `Azure DevOps request failed: ${error instanceof Error ? error.message : error}`,
		)
	}
}

type Deps = { config: BotConfig; client: App["client"] }

export type BotApi = { url: string }
let api: BotApi | null = null

/** The API's address once started (null before, or if this runtime doesn't use it). */
export const botApiUrl = () => api?.url ?? null

export function startBotApi(hostname: string, deps: Deps): BotApi {
	if (api) return api
	const server = Bun.serve({
		hostname,
		port: 0,
		async fetch(request) {
			const caller = verify(request.headers.get("x-dot-caller"))
			if (!caller)
				return reply(
					401,
					"Not signed by this bot (the credential is per turn).",
				)
			const [, resource, id] = new URL(request.url).pathname.split("/")
			if (resource === "schedule")
				return handleSchedule(request, caller, id)
			if (resource === "ado")
				return handleAzureDevOps(request, caller, id, deps)
			return reply(404, "Unknown endpoint.")
		},
	})
	api = { url: `http://${hostname}:${server.port}` }
	return api
}
