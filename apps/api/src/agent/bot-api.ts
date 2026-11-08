/**
 * A small API for laddu's commands inside a container that need the bot itself: `schedule`, `ado`
 * (Azure DevOps) and `ms` (Microsoft 365), whose tokens stay here, `slack` (find people, DM
 * them as the person or from laddu, ask them questions), `desktop link` and `appearance`
 * (the name and picture they give laddu).
 *
 * Each Codex turn gets a caller credential signed by this process: who the turn runs for and the
 * Slack thread it came from. The command sends it back, so a request can only act as that person,
 * in that conversation; changing any part of it breaks the signature. The variable is named
 * LADDU_CALLER (no KEY/TOKEN/SECRET) so Codex passes it to the commands it runs. Listens on the
 * Docker bridge address, where containers can reach it.
 */
import type { App } from "@slack/bolt"
import {
	appearance,
	cleanName,
	nameProblem,
	postAs,
	picturesWork,
	PRESETS,
	savePicture,
	setAppearance,
	type Appearance,
} from "../appearance"
import type { BotConfig } from "../config"
import * as azureDevOps from "../integrations/azure-devops"
import * as graph from "../integrations/graph"
import * as codecommit from "../integrations/codecommit"
import * as microsoft from "../integrations/microsoft"
import { findPeople, recipient, sendOnBehalf } from "../slack/messaging"
import * as slackSignIn from "../slack/user-tokens"
import {
	callSlack,
	capabilities,
	identityFor,
	methods,
	object,
	slackFailure,
} from "../slack/api"
import { requestOk } from "../slack/approvals"
import { markAction } from "../inflight"
import { sessionKey } from "../sessions"
import { needsOk, outsideAction, type ApiRequest } from "./actions"
import { transfer } from "../slack/transfers"
import * as questions from "../slack/questions"
import * as keys from "../slack/keys"
import { uploadFiles } from "../slack/attachments"
import { chunkMarkdown, showTodos } from "../slack/reply"
import type { SlackAutomations } from "../slack/automations"
import type { SlackForms } from "../slack/forms"
import { systemName } from "../slack/system"
import { sendDesktopLink } from "./desktop"
import { refreshHome } from "../slack/home"
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

const notSetUp = () =>
	reply(
		501,
		"Microsoft integrations aren't set up on this bot (the person running it needs to add MICROSOFT_CLIENT_ID; see docs/SETUP.md).",
	)

/** connect / disconnect, the same for `ado` and `ms` (one Microsoft connection). */
async function handleConnection(
	request: Request,
	caller: Caller,
	settings: microsoft.Settings,
	resource: microsoft.Resource,
	client: App["client"],
): Promise<Response | null> {
	const person = { teamId: caller.teamId, userId: caller.userId }
	if (request.method === "POST") {
		if (caller.scheduled)
			return reply(403, "A scheduled run can't start a sign-in.")
		return reply(
			200,
			await microsoft.connect(settings, client, person, resource, {
				channel: caller.channel,
				threadTs: caller.threadTs,
			}),
		)
	}
	if (request.method === "DELETE")
		return reply(
			200,
			(await microsoft.disconnect(person))
				? `Disconnected; ${systemName()} no longer keeps their Microsoft sign-in (Azure DevOps and Microsoft 365).`
				: "They weren't connected.",
		)
	return null
}

function failed(error: unknown, what: string): Response {
	console.warn(`[${what}]`, error)
	return reply(
		502,
		error instanceof microsoft.SignInError ||
			error instanceof microsoft.ConsentError
			? error.message
			: `${what} request failed: ${error instanceof Error ? error.message : error}`,
	)
}

async function handleAzureDevOps(
	request: Request,
	caller: Caller,
	action: string | undefined,
	deps: Deps,
): Promise<Response> {
	const settings = deps.config.microsoft
	if (!settings) return notSetUp()
	const person = { teamId: caller.teamId, userId: caller.userId }
	try {
		if (action === "git")
			return await azureDevOps.gitRequest(settings, person, request)
		if (action === "status" && request.method === "GET")
			return reply(200, await azureDevOps.status(settings, person))
		if (action === "identity" && request.method === "GET") {
			if (!(await microsoft.accessToken(settings, person, "devops")))
				return reply(409, microsoft.notConnected("devops"))
			const account = await microsoft.account(person)
			return reply(
				200,
				JSON.stringify({ name: account!.name, email: account!.email }),
			)
		}
		if (action === "connect") {
			const response = await handleConnection(
				request,
				caller,
				settings,
				"devops",
				deps.client,
			)
			if (response) return response
		}
		if (action === "use" && request.method === "POST") {
			const { organization } = (await request
				.json()
				.catch(() => ({}))) as { organization?: string }
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
		return failed(error, "Azure DevOps")
	}
}

async function handleGraph(
	request: Request,
	caller: Caller,
	action: string | undefined,
	deps: Deps,
): Promise<Response> {
	const settings = deps.config.microsoft
	if (!settings) return notSetUp()
	const person = { teamId: caller.teamId, userId: caller.userId }
	try {
		if (action === "status" && request.method === "GET")
			return reply(200, await microsoft.status(settings, person, "graph"))
		if (action === "connect") {
			const response = await handleConnection(
				request,
				caller,
				settings,
				"graph",
				deps.client,
			)
			if (response) return response
		}
		if (action === "request" && request.method === "POST") {
			const input = (await request
				.json()
				.catch(() => null)) as graph.GraphRequest | null
			if (!input?.path) return reply(400, "Give the Graph path or URL.")
			const result = await graph.request(settings, person, input)
			return reply(result.status < 400 ? 200 : result.status, result.text)
		}
		const path = new URL(request.url).searchParams.get("path")
		if (action === "download" && request.method === "GET" && path)
			return await graph.download(settings, person, path)
		if (action === "upload" && request.method === "PUT" && path) {
			const result = await graph.upload(
				settings,
				person,
				path,
				await request.arrayBuffer(),
				request.headers.get("content-type") ??
					"application/octet-stream",
			)
			return reply(result.status < 400 ? 200 : result.status, result.text)
		}
		return reply(404, "Use status, connect, request, download or upload.")
	} catch (error) {
		return failed(error, "Microsoft Graph")
	}
}

/** `desktop link`: the person's link to your computer, privately in this conversation. */
async function handleDesktopLink(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> {
	if (request.method !== "POST") return reply(405, "Use POST.")
	if (!deps.config.desktop)
		return reply(
			501,
			`${systemName()}'s computer is turned off on this bot (DESKTOP).`,
		)
	if (caller.scheduled)
		return reply(
			403,
			"A scheduled run can't send links; nobody is in the conversation.",
		)
	const { reason } = (await request.json().catch(() => ({}))) as {
		reason?: string
	}
	try {
		await sendDesktopLink(
			deps.client,
			deps.config,
			{
				teamId: caller.teamId,
				userId: caller.userId,
				channel: caller.channel,
				threadTs: caller.threadTs,
			},
			reason?.trim() || undefined,
		)
	} catch (error) {
		return failed(error, "Desktop link")
	}
	return reply(
		200,
		"Sent them a private link to your computer: they can watch it and take control from there. Don't repeat or invent the link.",
	)
}

/** `slack`: look people up, DM them (as the person once they've connected Slack, or from laddu). */
async function handleSlack(
	request: Request,
	caller: Caller,
	action: string | undefined,
	deps: Deps,
): Promise<Response> {
	const person = { teamId: caller.teamId, userId: caller.userId }
	if (action === "ask") return handleAsk(request, caller, deps)
	if (action === "post") return handlePost(request, caller, deps)
	if (action === "todo") return handleTodo(request, caller)
	try {
		if (
			["methods", "capabilities"].includes(action ?? "") &&
			request.method === "GET"
		)
			return reply(
				200,
				JSON.stringify(
					await capabilities(
						deps.client,
						person,
						new URL(request.url).searchParams.get("method") ??
							undefined,
					),
				),
			)
		if (
			(action === "upload" && request.method === "PUT") ||
			(action === "download" && request.method === "GET")
		)
			return await transfer(deps.client, person, request, action)
		if (
			["api", "automate", "form"].includes(action ?? "") &&
			request.method === "POST"
		) {
			const input = await request.json().catch(() => null)
			if (!object(input)) return reply(400, "Give a JSON object.")
			if (action === "api") {
				if (
					typeof input.method !== "string" ||
					(input.as !== undefined && typeof input.as !== "string")
				)
					return reply(
						400,
						"Give a method and optional identity (auto, user, laddu).",
					)
				const result = JSON.stringify(
					await callSlack(deps.client, person, {
						method: input.method,
						args: input.args,
						as: input.as as string | undefined,
					}),
				)
				if (result.length > 400_000)
					return reply(
						413,
						"Slack result exceeds 400 KB. Request a smaller page with limit/count and continue with its cursor/page.",
					)
				return reply(200, result)
			}
			if (!deps.slack)
				return reply(503, "Slack events and forms aren't configured.")
			if (action === "form")
				return reply(
					200,
					JSON.stringify(
						await deps.slack.forms.create(person, input),
					),
				)
			if (
				caller.scheduled &&
				!["list", "history"].includes(String(input.operation))
			)
				return reply(
					403,
					"Background tasks can't create or modify event automations.",
				)
			return reply(
				200,
				JSON.stringify(
					await deps.slack.automations.manage(person, input),
				),
			)
		}
	} catch (error) {
		const failure = slackFailure(error)
		return reply(failure.status, failure.message)
	}
	if (action === "status" && request.method === "GET")
		return reply(200, await slackSignIn.status(person))
	if (action === "connect" && request.method === "DELETE")
		return reply(
			200,
			(await slackSignIn.disconnect(deps.client, person))
				? `Disconnected; ${systemName()} no longer keeps their Slack sign-in, and DMs come from ${systemName()}.`
				: "They weren't connected.",
		)
	if (request.method !== "POST") return reply(405, "Use POST.")
	const body = (await request.json().catch(() => ({}))) as {
		query?: string
		to?: string
		text?: string
		fromLaddu?: boolean
	}
	try {
		if (action === "connect") {
			if (!deps.config.slackSignIn)
				return reply(
					501,
					`Sending as people isn't set up on this bot (the person running it needs to add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET; see docs/SETUP.md). DMs can still come from ${systemName()}.`,
				)
			if (caller.scheduled)
				return reply(403, "A scheduled run can't start a sign-in.")
			return reply(
				200,
				await slackSignIn.connect(
					deps.config.slackSignIn,
					deps.client,
					person,
					{ channel: caller.channel, threadTs: caller.threadTs },
				),
			)
		}
		if (action === "find")
			return reply(
				200,
				await findPeople(deps.client, caller.teamId, body.query ?? ""),
			)
		if (action === "dm") {
			const { slackSignIn: signIn } = deps.config
			const result = await sendOnBehalf(
				deps.client,
				{ teamId: caller.teamId, userId: caller.userId },
				body.to ?? "",
				body.text ?? "",
				// Without sign-in set up on this bot, DMs can only come from laddu.
				body.fromLaddu === true || !signIn,
			)
			// Not connected yet is a step, not a failure: send them the link and say so.
			if (
				!result.ok &&
				result.notConnected &&
				signIn &&
				!caller.scheduled
			)
				return reply(
					200,
					`Not sent yet: their Slack account isn't connected, so it can't come from them. ${await slackSignIn.connect(signIn, deps.client, person, { channel: caller.channel, threadTs: caller.threadTs })} (Or send it from ${systemName()} now with \`slack dm --from-laddu\`.)`,
				)
			return reply(result.ok ? 200 : 400, result.text)
		}
		return reply(404, "Use find, dm, status or connect.")
	} catch (error) {
		return failed(error, "Slack")
	}
}

/**
 * `slack ask`: POST puts the question in the thread and returns its ID; GET ?id= is one long poll
 * for the answer (the command repeats it while the turn waits).
 */
async function handleAsk(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> {
	if (caller.scheduled)
		return reply(
			403,
			"A scheduled run can't ask; nobody is in the conversation.",
		)
	if (request.method !== "POST") return reply(405, "Use POST.")
	try {
		const input = await request.json().catch(() => null)
		if (!object(input)) return reply(400, "Give a JSON object.")
		return reply(200, await questions.ask(deps.client, caller, input))
	} catch (error) {
		if (error instanceof questions.QuestionError)
			return reply(400, error.message)
		return failed(error, "Slack question")
	}
}

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const

/** `slack todo`: the to-do list shown in the thread while the turn works through it. */
async function handleTodo(request: Request, caller: Caller): Promise<Response> {
	if (request.method !== "POST") return reply(405, "Use POST.")
	const input = await request.json().catch(() => null)
	if (!object(input) || !Array.isArray(input.items))
		return reply(400, "Give the list's items.")
	const items = input.items.flatMap(item =>
		object(item) &&
		typeof item.text === "string" &&
		item.text.trim() &&
		TODO_STATUSES.includes(item.status as never)
			? [
					{
						text: item.text.trim(),
						status: item.status as (typeof TODO_STATUSES)[number],
					},
				]
			: [],
	)
	if (
		!items.length ||
		items.length !== input.items.length ||
		items.length > 12
	)
		return reply(400, "Give 1 to 12 items, each with text and a status.")
	const title =
		typeof input.title === "string" ? input.title.trim() : undefined
	if (!showTodos(caller, { title: title || undefined, items }))
		return reply(
			409,
			"There's no reply in progress here to show a to-do list in (e.g. a scheduled run). Carry on without it.",
		)
	return reply(
		200,
		"Shown in the thread. Run it again with the whole list each time an item starts or is done.",
	)
}

/** `slack post`: part of the answer in the turn's own thread, as laddu, while the turn goes on. */
async function handlePost(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> {
	if (request.method !== "POST") return reply(405, "Use POST.")
	const input = await request.json().catch(() => null)
	if (!object(input)) return reply(400, "Give a JSON object.")
	const text = typeof input.text === "string" ? input.text.trim() : ""
	const files = Array.isArray(input.files) ? input.files : []
	if (
		files.length > 10 ||
		files.some(
			file =>
				!object(file) ||
				typeof file.name !== "string" ||
				!file.name ||
				typeof file.data !== "string",
		)
	)
		return reply(400, "Give up to 10 files, each with a name and data.")
	if (!text && !files.length) return reply(400, "Give some text or a file.")
	const person = { teamId: caller.teamId, userId: caller.userId }
	try {
		const as = await postAs(person)
		for (const part of text ? chunkMarkdown(text) : [])
			await deps.client.chat.postMessage({
				channel: caller.channel,
				thread_ts: caller.threadTs,
				markdown_text: part,
				...as,
			})
		await uploadFiles(
			deps.client,
			caller.channel,
			caller.threadTs,
			(files as { name: string; data: string }[]).map(file => ({
				name: file.name,
				data: Uint8Array.fromBase64(file.data),
			})),
			as,
		)
		return reply(
			200,
			"Posted in the thread. Carry on; don't repeat it in your final reply.",
		)
	} catch (error) {
		return failed(error, "Slack")
	}
}

/** `connections key request`: asks the person for a key with a private form (slack/keys.ts). */
async function handleKeyRequest(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> {
	if (caller.scheduled)
		return reply(
			403,
			"A scheduled run can't ask for a key; nobody is in the conversation. Ask in a conversation with them.",
		)
	if (request.method !== "POST") return reply(405, "Use POST.")
	try {
		const input = await request.json().catch(() => null)
		if (!object(input)) return reply(400, "Give a JSON object.")
		return reply(200, await keys.requestKey(deps.client, caller, input))
	} catch (error) {
		if (error instanceof keys.KeyError) return reply(400, error.message)
		return failed(error, "Slack")
	}
}

/** `appearance`: the name and picture the person gave laddu (appearance.ts). */
async function handleAppearance(
	request: Request,
	caller: Caller,
	id: string | undefined,
	deps: Deps,
): Promise<Response> {
	const person = { teamId: caller.teamId, userId: caller.userId }
	const describe = async () => {
		const { name, picture } = await appearance(person)
		const shown = !picture
			? `${systemName()}'s own picture`
			: picture in PRESETS
				? `the ${PRESETS[picture]} picture`
				: "a picture of theirs"
		return `Name: ${name ?? `${systemName()} (its own)`}. Picture: ${shown}.${picture && !picturesWork() ? " (Pictures don't show on this bot: it has no public HTTPS address, DESKTOP_PUBLIC_URL.)" : ""}`
	}
	if (request.method === "GET" && !id) return reply(200, await describe())
	if (caller.scheduled)
		return reply(
			403,
			`A scheduled run can't change ${systemName()}'s name or picture.`,
		)
	let change: Appearance
	if (request.method === "PUT" && id === "picture") {
		if (!picturesWork())
			return reply(
				501,
				"Pictures need the bot's public HTTPS address (DESKTOP_PUBLIC_URL), and this bot has none. Names still work.",
			)
		const saved = await savePicture(await request.bytes())
		if ("problem" in saved) return reply(400, saved.problem)
		change = { picture: saved.picture }
	} else if (request.method === "POST" && !id) {
		const body = (await request.json().catch(() => ({}))) as {
			name?: string
			preset?: string
			reset?: string
		}
		if (body.reset)
			change = {
				...(body.reset !== "picture" ? { name: undefined } : {}),
				...(body.reset !== "name" ? { picture: undefined } : {}),
			}
		else if (body.name !== undefined) {
			const name = cleanName(body.name)
			const problem = await nameProblem(deps.client, name)
			if (problem) return reply(400, problem)
			change = { name }
		} else if (body.preset) {
			const picture = `${body.preset}.png`
			if (!(picture in PRESETS)) return reply(400, "No such picture.")
			change = { picture }
		} else return reply(400, "Give a name, a picture or a reset.")
	} else return reply(405, "Use name, picture or reset.")
	await setAppearance(person, change)
	void refreshHome(deps.client, person).catch(() => {})
	return reply(
		200,
		`Saved; your next messages for them show it. ${await describe()}`,
	)
}

type Deps = {
	config: BotConfig
	client: App["client"]
	slack?: { automations: SlackAutomations; forms: SlackForms }
}

async function handleCodeCommit(
	request: Request,
	caller: Caller,
	action: string | undefined,
	deps: Deps,
): Promise<Response> {
	const settings = deps.config.codeCommit
	if (!settings)
		return reply(
			501,
			"CodeCommit isn't set up. The operator needs to assign host AWS profiles in CODECOMMIT_PROFILES; see docs/SETUP.md.",
		)
	const person = { teamId: caller.teamId, userId: caller.userId }
	try {
		if (action === "git")
			return await codecommit.gitRequest(settings, person, request)
		if (request.method !== "POST") return reply(405, "Use POST.")
		const input = (await request.json()) as codecommit.PullRequest
		if (action === "repository") {
			const repo = await codecommit.repository(settings, person, input)
			const { user } = await deps.client.users.info({
				user: caller.userId,
			})
			return reply(
				200,
				JSON.stringify({
					...repo,
					identity: {
						name: user?.real_name || user?.name,
						email: user?.profile?.email,
					},
				}),
			)
		}
		if (action === "check") {
			await codecommit.check(settings, person, input)
			return reply(200, "Ready to push this task branch.")
		}
		if (action === "pr")
			return reply(
				200,
				JSON.stringify(
					await codecommit.pullRequest(settings, person, input),
				),
			)
		return reply(404, "Use repository, check or pr.")
	} catch (error) {
		return failed(error, "CodeCommit")
	}
}

function dispatch(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> | Response {
	const [, resource, id] = new URL(request.url).pathname.split("/")
	if (resource === "schedule") return handleSchedule(request, caller, id)
	if (resource === "ado") return handleAzureDevOps(request, caller, id, deps)
	if (resource === "ms") return handleGraph(request, caller, id, deps)
	if (resource === "codecommit")
		return handleCodeCommit(request, caller, id, deps)
	if (resource === "slack") return handleSlack(request, caller, id, deps)
	if (resource === "appearance")
		return handleAppearance(request, caller, id, deps)
	if (resource === "keys" && id === "request")
		return handleKeyRequest(request, caller, deps)
	if (resource === "desktop" && id === "link")
		return handleDesktopLink(request, caller, deps)
	return reply(404, "Unknown endpoint.")
}

/** Requests whose rules in actions.ts read the JSON body (small ones; uploads aren't read twice). */
const READS_BODY = new Set([
	"slack/dm",
	"slack/api",
	"slack/automate",
	"ms/request",
	"ado/write",
])

/**
 * Every request goes through here: a risky one waits for the person's OK (approvals.ts) instead of
 * being sent, and one that changed something outside the conversation is noted on the turn, so a
 * restart won't start that turn over and do it again (inflight.ts).
 */
async function guarded(
	request: Request,
	caller: Caller,
	deps: Deps,
): Promise<Response> {
	const url = new URL(request.url)
	const [, resource = "", action] = url.pathname.split("/")
	const raw = READS_BODY.has(`${resource}/${action}`)
		? await request.text()
		: undefined
	let body: Record<string, unknown> | null = null
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : null
		if (object(parsed)) body = parsed
	} catch {
		/* The handler reports the bad body. */
	}
	const person = { teamId: caller.teamId, userId: caller.userId }
	const described: ApiRequest = {
		resource,
		action,
		method: request.method,
		path: url.pathname,
		body,
		asPerson: await goesOutAsPerson(resource, action, body, person, deps),
		slackWrite:
			resource === "slack" &&
			action === "api" &&
			Boolean(methods[String(body?.method)]?.write),
	}
	// The body was read above, so the handler gets a fresh copy of the request.
	const fresh = () =>
		raw === undefined
			? request
			: new Request(request.url, {
					method: request.method,
					headers: request.headers,
					body: raw,
				})
	// They asked for exactly this themselves (the command's --asked): no need to ask again.
	const asked = request.headers.get("x-laddu-asked") === "1"
	const risky = needsOk(described)
	if (risky && asked)
		console.log(
			`[approval] ${caller.teamId}-${caller.userId}: asked directly, so no OK needed to ${risky.label}`,
		)
	if (risky && !asked)
		try {
			const waiting = await requestOk(
				deps.client,
				caller,
				risky,
				async () => {
					const response = await dispatch(fresh(), caller, deps)
					const { text } = (await response
						.json()
						.catch(() => ({}))) as {
						text?: string
					}
					return {
						ok: response.ok,
						text: text ?? `HTTP ${response.status}`,
					}
				},
			)
			return reply(428, waiting)
		} catch (error) {
			return failed(error, "Slack (asking for their OK)")
		}
	const response = await dispatch(fresh(), caller, deps)
	const done = response.ok ? outsideAction(described) : null
	if (done && !caller.scheduled)
		await markAction(
			sessionKey(caller.channel, caller.threadTs, caller.userId),
			done,
		).catch(() => {})
	return response
}

/** Whether a DM or Slack call would go out as the person rather than as laddu. */
async function goesOutAsPerson(
	resource: string,
	action: string | undefined,
	body: Record<string, unknown> | null,
	person: { teamId: string; userId: string },
	deps: Deps,
): Promise<boolean> {
	if (resource !== "slack") return false
	if (action === "dm") {
		if (
			!deps.config.slackSignIn ||
			body?.fromLaddu === true ||
			!(await slackSignIn.userToken(person))
		)
			return false
		// To themselves ("DM me") laddu sends it as itself; an unknown recipient is just an error.
		const found = await recipient(
			deps.client,
			person.teamId,
			String(body?.to ?? ""),
		)
		return "id" in found && found.id !== person.userId
	}
	if (action === "api") {
		const spec = methods[String(body?.method)]
		if (!spec) return false
		const as = typeof body?.as === "string" ? body.as : undefined
		return (
			identityFor(
				spec,
				as,
				Boolean(await slackSignIn.userToken(person)),
			) === "user"
		)
	}
	return false
}

export type BotApi = { url: string }
let api: BotApi | null = null

/** The API's address once started (null before, or if this runtime doesn't use it). */
export const botApiUrl = () => api?.url ?? null

export function startBotApi(hostname: string, deps: Deps): BotApi {
	if (api) return api
	const server = Bun.serve({
		hostname,
		port: 0,
		// Repository transfers can be quiet while Azure prepares a pack.
		idleTimeout: 255,
		maxRequestBodySize: 52 * 1024 * 1024,
		async fetch(request) {
			const caller = verify(request.headers.get("x-laddu-caller"))
			if (!caller)
				return reply(
					401,
					"Not signed by this bot (the credential is per turn).",
				)
			return guarded(request, caller, deps)
		},
	})
	api = { url: `http://${hostname}:${server.port}` }
	return api
}
