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
