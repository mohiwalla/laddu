/**
 * What a bot API request does outside the conversation, for two jobs: which requests need the
 * person's OK first (slack/approvals.ts), and which ones a restart must not repeat (inflight.ts).
 * Pure, so the rules are easy to read and test; bot-api.ts gathers the inputs.
 */
export type ApiRequest = {
	/** The first path segment: slack, ms, ado, codecommit, schedule… */
	resource: string
	/** The second: dm, api, request, write, git… */
	action?: string
	method: string
	/** The URL's path, for Git requests (a POST to …/git-receive-pack is a push). */
	path: string
	/** The JSON body, for the requests whose rules read it. */
	body: Record<string, unknown> | null
	/** The DM or Slack call would go out as the person, not as laddu. */
	asPerson: boolean
	/** A `slack api` call to a method that changes something. */
	slackWrite: boolean
}

export type Risky = {
	/** For the turn that asked: "send a DM as them to @ana". */
	label: string
	/**
	 * For the confirmation in Slack (mrkdwn): what would happen, in plain words with real names, never
	 * the API call behind it. (A command belongs there only when the command is the action itself,
	 * like a shell command against someone's infrastructure; none of these are.)
	 */
	detail: string
}

const text = (value: unknown) => (typeof value === "string" ? value : "")
const escape = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const clip = (value: string, max = 600) =>
	value.length > max ? `${value.slice(0, max)}…` : value
const quote = (value: string) =>
	clip(escape(value))
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n")
/** A Slack user ID shown as a mention ("@Ana"), anything else as typed. */
const person = (to: string) => {
	const id = /^<?@?([UW][A-Z0-9]{5,})(\|[^>]*)?>?$/.exec(to.trim())?.[1]
	return id ? `<@${id}>` : escape(to)
}
/** A channel ID shown as a link ("#general"), a name as "#name". */
const channel = (value: unknown) => {
	const id = /^<?#?([CGD][A-Z0-9]{6,})(\|[^>]*)?>?$/.exec(
		text(value).trim(),
	)?.[1]
	return id ? `<#${id}>` : `#${escape(text(value).replace(/^#/, ""))}`
}
const people = (value: unknown) =>
	text(value).split(",").filter(Boolean).map(person).join(", ")

/** Slack calls in plain words, for people who don't know Slack's API; null for the rest. */
function plainSlack(
	method: string,
	args: Record<string, unknown>,
): string | null {
	const where = channel(args.channel ?? args.channel_id)
	const said = text(args.text) || text(args.markdown_text)
	const words = said ? `:\n${quote(said)}` : ""
	switch (method) {
		case "chat.postMessage":
			return `Post in ${where} *as you*${words}`
		case "chat.scheduleMessage":
			return `Schedule a message in ${where} *as you*${words}`
		case "chat.update":
			return `Edit your message in ${where}${words}`
		case "chat.delete":
			return `Delete your message in ${where}`
		case "chat.deleteScheduledMessage":
			return `Cancel your scheduled message in ${where}`
		case "conversations.invite":
			return `Add ${people(args.users)} to ${where}, *as you*`
		case "conversations.kick":
			return `Remove ${people(args.user)} from ${where}`
		case "conversations.create":
			return `Create the ${args.is_private ? "private " : ""}channel #${escape(text(args.name))}`
		case "conversations.archive":
			return `Archive ${where}`
		case "conversations.unarchive":
			return `Bring back ${where}`
		case "conversations.rename":
			return `Rename ${where} to #${escape(text(args.name))}`
		case "conversations.setTopic":
			return `Change the topic of ${where} to:\n${quote(text(args.topic))}`
		case "conversations.setPurpose":
			return `Change the description of ${where} to:\n${quote(text(args.purpose))}`
		case "pins.add":
			return `Pin a message in ${where}`
		case "pins.remove":
			return `Unpin a message in ${where}`
		case "bookmarks.add":
			return `Add the bookmark "${escape(text(args.title))}" to ${where}`
		case "bookmarks.edit":
			return `Change a bookmark in ${where}`
		case "bookmarks.remove":
			return `Remove a bookmark from ${where}`
		case "files.delete":
			return "Delete one of your files"
		case "files.revokePublicURL":
			return "Turn off a file's public link"
		case "conversations.canvases.create":
			return `Create a canvas in ${where}`
		case "canvases.create":
			return `Create a canvas${args.title ? ` called "${escape(text(args.title))}"` : ""}`
		case "canvases.edit":
			return "Edit one of your canvases"
	}
	return null
}

/** Graph requests in plain words, from what the path and body say; null for the rest. */
function plainGraph(
	method: string,
	path: string,
	body: unknown,
): string | null {
	const data = (body ?? {}) as Record<string, any>
	const message = data.message ?? data
	const recipients = (list: unknown) =>
		(Array.isArray(list) ? list : [])
			.map(r => escape(text(r?.emailAddress?.address)))
			.filter(Boolean)
			.join(", ")
	const content = (value: unknown) =>
		text(value)
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t]+/g, " ")
			.trim()
	if (method === "DELETE") {
		const what = /\/events\//i.test(path)
			? "a calendar event"
			: /\/messages\//i.test(path)
				? "an email"
				: /\/(drive|items)\//i.test(path)
					? "a file"
					: "something"
		return `Delete ${what} in your Microsoft 365`
	}
	if (/(^|\/)sendMail$/i.test(path)) {
		const to = recipients(message.toRecipients)
		const subject = text(message.subject)
		const said = content(message.body?.content)
		return `Send an email *as you*${to ? ` to ${to}` : ""}${subject ? `, subject "${escape(subject)}"` : ""}${said ? `:\n${quote(said)}` : ""}`
	}
	if (/(^|\/)(reply|replyAll|forward)$/i.test(path)) {
		const kind = /forward$/i.test(path)
			? "Forward an email"
			: "Reply to an email"
		const to = recipients(data.toRecipients ?? message.toRecipients)
		const said = content(data.comment)
		return `${kind} *as you*${to ? ` to ${to}` : ""}${said ? `:\n${quote(said)}` : ""}`
	}
	if (/(^|\/)(chats|channels)\/[^/]+\/messages/i.test(path)) {
		const said = content(data.body?.content)
		return `Send a Teams message *as you*${said ? `:\n${quote(said)}` : ""}`
	}
	if (/(^|\/)(invite|grant)$/i.test(path)) {
		const to = recipients(data.recipients)
		return `Share a file *as you*${to ? ` with ${to}` : ""}`
	}
	if (/(^|\/)createLink$/i.test(path)) return "Make a sharing link for a file"
	if (/\/messages\/[^/]+\/send$/i.test(path))
		return "Send a draft email *as you*"
	return null
}

const graphPath = (body: Record<string, unknown> | null) =>
	text(body?.path).split("?")[0]!

/** Slack writes that only touch the person's own view or settings; they don't need an OK. */
const OWN_SLACK =
	/^(conversations\.(join|leave|open|close|mark)|users\.(profile\.set|setPresence)|dnd\..+|reactions\..+|reminders\..+|chat\.postEphemeral)$/

/** Graph requests that send, reply, share or invite as the person. */
const GRAPH_SENDS =
	/(^|\/)(sendMail|send|reply|replyAll|forward|invite|createLink|grant)$|(^|\/)(chats|channels)\/[^/]+\/messages(\/[^/]+\/replies)?$/i

/** Requests that act as the person where others see it, or that can't be undone: null for the rest. */
export function needsOk(request: ApiRequest): Risky | null {
	const { resource, action, body } = request
	if (resource === "slack" && action === "dm" && request.asPerson) {
		const to = text(body?.to)
		return {
			label: `send a Slack DM as them to ${to}`,
			detail: `Send a Slack DM *as you* to ${person(to)}:\n${quote(text(body?.text))}`,
		}
	}
	if (resource === "slack" && action === "api" && request.asPerson) {
		const method = text(body?.method)
		if (!request.slackWrite || OWN_SLACK.test(method)) return null
		const args = (body?.args ?? {}) as Record<string, unknown>
		const plain = plainSlack(method, args)
		return {
			label: `call Slack's ${method} as them`,
			detail:
				plain ?? `Make a change in Slack *as you* (${escape(method)})`,
		}
	}
	if (resource === "ms" && action === "request") {
		const method = (text(body?.method) || "GET").toUpperCase()
		const path = graphPath(body)
		if (
			method !== "DELETE" &&
			!(method === "POST" && GRAPH_SENDS.test(path))
		)
			return null
		const plain = plainGraph(method, path, body?.body)
		return {
			label: `${method === "DELETE" ? "delete" : "send or share as them"} in Microsoft 365 (${method} ${path})`,
			detail:
				plain ??
				`${method === "DELETE" ? "Delete something" : "Send or share something"} in your Microsoft 365, *as you*`,
		}
	}
	if (resource === "ado" && action === "write") {
		const method = (text(body?.method) || "PATCH").toUpperCase()
		const summary = text(body?.summary) || `${method} ${text(body?.path)}`
		const change = body?.body as Record<string, unknown> | undefined
		if (method === "DELETE")
			return {
				label: `delete in Azure DevOps (${summary})`,
				detail: `Delete in Azure DevOps as you: ${escape(summary)}`,
			}
		if (change?.status === "completed")
			return {
				label: `complete (merge) a pull request (${summary})`,
				detail: `Complete (merge) a pull request in Azure DevOps as you: ${escape(summary)}`,
			}
	}
	return null
}

/**
 * Who or what a risky request reaches or changes, so the bot can tell whether the person named it
 * in their own words (askedFor). A person by Slack ID or email, a channel by ID or name, a message
 * by its channel and ts, an Azure DevOps work item or pull request by number, an @channel-style
 * mention by its group ("here", "subteam^S123").
 */
export type Target =
	| { kind: "person"; id?: string; email?: string }
	| { kind: "channel"; id?: string; name?: string }
	| { kind: "message"; channel: string; ts: string }
	| { kind: "item"; number: string }
	| { kind: "mention"; group: string }

/** A target, with the names the bot found for it (a person's display and real names…). */
export type Known = { target: Target; names: string[] }

const record = (value: unknown) =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}

/** A Slack ID or email as a person; null for anything else. */
function slackPerson(value: string): Target | null {
	const trimmed = value.trim()
	const id = /^<?@?([UW][A-Z0-9]{5,})(\|[^>]*)?>?$/.exec(trimmed)?.[1]
	if (id) return { kind: "person", id }
	const email = /^(?:<mailto:)?([^\s@<>|]+@[^\s@<>|]+\.[^\s@<>|]+)/.exec(
		trimmed,
	)?.[1]
	return email ? { kind: "person", email } : null
}

/** Whoever a message's text notifies: the people it mentions, and @channel, @here or a group. */
function notified(value: string): Target[] {
	const targets: Target[] = [
		...value.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g),
	].map(([, id]) => ({ kind: "person", id }))
	for (const [, coded, typed] of value.matchAll(
		/<!(channel|here|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>|(?<![\w@])@(channel|here|everyone)\b/g,
	))
		targets.push({ kind: "mention", group: (coded ?? typed)! })
	return targets
}

/** Slack arguments that point at something nobody can name in a message (a file, a bookmark…). */
const UNNAMEABLE = [
	"file",
	"file_id",
	"files",
	"canvas_id",
	"bookmark_id",
	"scheduled_message_id",
	"document_id",
	"external_id",
	"item_id",
]

function slackTargets(
	method: string,
	args: Record<string, unknown>,
): Target[] | null {
	if (UNNAMEABLE.some(key => args[key] !== undefined)) return null
	const targets: Target[] = []
	const where = text(args.channel ?? args.channel_id).trim()
	const ts = text(args.ts ?? args.timestamp)
	if (where) {
		const id = /^<?#?([CGD][A-Z0-9]{6,})(\|[^>]*)?>?$/.exec(where)?.[1]
		// A user ID as the channel is a DM with them.
		const place: Target = id
			? { kind: "channel", id }
			: (slackPerson(where) ?? {
					kind: "channel",
					name: where.replace(/^#/, ""),
				})
		targets.push(place)
		if (ts && place.kind === "channel" && id)
			targets.push({ kind: "message", channel: id, ts })
	} else if (ts) return null
	for (const user of [args.users, args.user].map(text).join(",").split(","))
		if (user.trim()) {
			const person = slackPerson(user)
			if (!person) return null
			targets.push(person)
		}
	if (/^conversations\.(create|rename)$/.test(method) && text(args.name))
		targets.push({ kind: "channel", name: text(args.name) })
	return [...targets, ...notified(JSON.stringify(args))]
}

function graphTargets(
	method: string,
	path: string,
	body: unknown,
): Target[] | null {
	// Deletes, replies, Teams chats and sharing links act on IDs nobody types.
	if (method !== "POST") return null
	const data = record(body)
	const message = record(data.message ?? data)
	const lists = /(^|\/)sendMail$/i.test(path)
		? [message.toRecipients, message.ccRecipients, message.bccRecipients]
		: /(^|\/)forward$/i.test(path)
			? [
					data.toRecipients,
					message.toRecipients,
					message.ccRecipients,
					message.bccRecipients,
				]
			: /(^|\/)invite$/i.test(path)
				? [data.recipients]
				: null
	if (!lists) return null
	const emails = lists
		.flatMap(list => (Array.isArray(list) ? list : []))
		.map(entry =>
			text(
				record(record(entry).emailAddress).address ||
					record(entry).email,
			),
		)
	if (emails.some(email => !email)) return null
	return emails.map(email => ({ kind: "person", email }))
}

/**
 * Everyone and everything a risky request (needsOk) reaches or changes; null when something it
 * acts on can't be named in words (an email's ID, a file, a Teams chat), so the person is asked.
 */
export function targetsOf(request: ApiRequest): Target[] | null {
	const { resource, action, body } = request
	let targets: Target[] | null = null
	if (resource === "slack" && action === "dm") {
		const to = slackPerson(text(body?.to))
		targets = to && [to, ...notified(text(body?.text))]
	} else if (resource === "slack" && action === "api")
		targets = slackTargets(text(body?.method), record(body?.args))
	else if (resource === "ms" && action === "request")
		targets = graphTargets(
			(text(body?.method) || "GET").toUpperCase(),
			graphPath(body),
			body?.body,
		)
	else if (resource === "ado" && action === "write") {
		const number = /\/(?:workitems|pullrequests)\/(\d+)(?:$|[/?])/i.exec(
			text(body?.path),
		)?.[1]
		targets = number ? [{ kind: "item", number }] : null
	}
	return targets?.length ? targets : null
}

const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether `said` has `name` as a word of its own, any case: "Vikash" in "DM vikash a story" and
 * U123 in "<@U123>", but not "ana@example.com" in "diana@example.com" or "Vikash" in an email.
 */
function says(said: string, name: string): boolean {
	const clean = name.trim().normalize("NFKC")
	if (clean.length < 2) return false
	return new RegExp(
		`(?<![\\p{L}\\p{N}._%+-])${literal(clean)}(?![\\p{L}\\p{N}]|[.@][\\p{L}\\p{N}])`,
		"iu",
	).test(said)
}

/** Ways of pointing at the conversation they're writing in. */
const HERE =
	/\b(this (channel|chat|conversation|group|thread|dm)|(in|to|into|from) here)\b/i

/** "work item 123", "PR #7", "!7", or a link to it. */
const item = (number: string) =>
	new RegExp(
		`(#|!|/edit/|/pullrequest/|\\b(work ?items?|items?|bugs?|tasks?|stor(y|ies)|prs?|pull ?requests?|issues?|tickets?|features?|epics?|ids?)\\s*(no\\.?|number)?\\s*#?)${number}(?!\\d)`,
		"i",
	)

function named(said: string, known: Known, here: string): boolean {
	const { target, names } = known
	switch (target.kind) {
		case "person":
			return [target.id, target.email, ...names].some(
				name => name && says(said, name),
			)
		case "channel": {
			const channelNames = [target.name, ...names]
				.map(name => name?.replace(/^#/, ""))
				.filter(name => name !== undefined && name !== "")
			return (
				Boolean(
					target.id &&
					(says(said, target.id) ||
						(target.id === here && HERE.test(said))),
				) ||
				channelNames.some(
					name =>
						says(said, `#${name}`) || says(said, `${name} channel`),
				)
			)
		}
		case "message":
			return said.includes(
				`/archives/${target.channel}/p${target.ts.replace(".", "")}`,
			)
		case "item":
			return item(target.number).test(said)
		case "mention":
			return (
				said.includes(`<!${target.group}`) ||
				(!target.group.includes("^") && says(said, `@${target.group}`))
			)
	}
}

/**
 * Whether the person asked for exactly this themselves: their own words in the running turn
 * (`words`: the messages they wrote, nothing quoted from elsewhere) name every target, as a mention,
 * ID, email, name the bot found, "#channel", "this channel" for `here`, or "work item 123". No
 * words (a scheduled run, an answer) or unknown targets: no, so they're asked.
 */
export function askedFor(
	words: string[],
	known: Known[] | null,
	here: string,
): boolean {
	const said = words.join("\n").normalize("NFKC")
	if (!said.trim() || !known?.length) return false
	return known.every(target => named(said, target, here))
}

/**
 * What the request did, if it changed something outside the conversation: "sent a Slack DM to
 * @ana". A turn cut off after one of these isn't started over on its own.
 */
export function outsideAction(request: ApiRequest): string | null {
	const { resource, action, method, body } = request
	const push = method === "POST" && request.path.endsWith("/git-receive-pack")
	switch (resource) {
		case "schedule":
			if (method === "POST") return "added a scheduled task"
			if (method === "DELETE") return "removed a scheduled task"
			return null
		case "ado":
			if (action === "write")
				return `changed Azure DevOps: ${text(body?.summary) || `${text(body?.method) || "PATCH"} ${text(body?.path)}`}`
			return action === "git" && push ? "pushed to Azure Repos" : null
		case "codecommit":
			if (action === "pr") return "opened a CodeCommit pull request"
			return action === "git" && push ? "pushed to CodeCommit" : null
		case "ms": {
			if (action === "upload") return "uploaded a file to Microsoft 365"
			const verb = (text(body?.method) || "GET").toUpperCase()
			return action === "request" && verb !== "GET"
				? `changed Microsoft 365: ${verb} ${graphPath(body)}`
				: null
		}
		case "slack":
			if (action === "dm") return `sent a Slack DM to ${text(body?.to)}`
			if (action === "post") return "posted in this thread"
			if (action === "upload") return "uploaded a file to Slack"
			if (action === "form") return "posted a form"
			if (action === "api" && request.slackWrite)
				return `used Slack's ${text(body?.method)}`
			if (
				action === "automate" &&
				!["list", "history"].includes(text(body?.operation))
			)
				return "changed an event automation"
			return null
	}
	return null
}
