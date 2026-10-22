/** Slack Free tools. Tokens stay on the host; the caller cannot select another person's identity. */
import type { App } from "@slack/bolt"
import { connection, forget } from "./user-tokens"

export type SlackClient = App["client"]
export type Person = { teamId: string; userId: string }
type Method = {
	identity: "user" | "either" | "laddu"
	required: string[]
	optional: string[]
	scopes: string[]
	write: boolean
}
export const methods: Record<string, Method> = {}
function add(
	name: string,
	identity: Method["identity"],
	scopes: string,
	required = "",
	optional = "",
	write = false,
) {
	methods[name] = {
		identity,
		scopes: scopes.split(" ").filter(Boolean),
		required: required.split(" ").filter(Boolean),
		optional: optional.split(" ").filter(Boolean),
		write,
	}
}
// Alternative conversation scopes depend on whether the channel is public, private, IM or MPIM.
add(
	"conversations.list",
	"either",
	"channels:read groups:read im:read mpim:read",
	"",
	"cursor limit types exclude_archived",
)
add(
	"conversations.info",
	"either",
	"channels:read groups:read im:read mpim:read",
	"channel",
	"include_num_members",
)
add(
	"conversations.members",
	"either",
	"channels:read groups:read",
	"channel",
	"cursor limit",
)
add(
	"conversations.history",
	"either",
	"channels:history groups:history im:history mpim:history",
	"channel",
	"cursor limit oldest latest inclusive",
)
add(
	"conversations.replies",
	"either",
	"channels:history groups:history im:history mpim:history",
	"channel ts",
	"cursor limit oldest latest inclusive",
)
add(
	"conversations.create",
	"user",
	"channels:write groups:write",
	"name",
	"is_private",
	true,
)
for (const verb of ["archive", "unarchive", "leave", "close", "join"])
	add(
		`conversations.${verb}`,
		"user",
		"channels:write groups:write",
		"channel",
		"",
		true,
	)
add(
	"conversations.open",
	"user",
	"im:write mpim:write",
	"",
	"users channel return_im",
	true,
)
add(
	"conversations.invite",
	"user",
	"channels:write.invites groups:write.invites",
	"channel users",
	"",
	true,
)
add(
	"conversations.kick",
	"user",
	"channels:write groups:write",
	"channel user",
	"",
	true,
)
add(
	"conversations.rename",
	"user",
	"channels:write groups:write",
	"channel name",
	"",
	true,
)
add(
	"conversations.setTopic",
	"user",
	"channels:write.topic groups:write.topic",
	"channel topic",
	"",
	true,
)
add(
	"conversations.setPurpose",
	"user",
	"channels:write groups:write",
	"channel purpose",
	"",
	true,
)
add(
	"conversations.mark",
	"user",
	"channels:history groups:history im:history mpim:history",
	"channel ts",
	"",
	true,
)
add(
	"users.conversations",
	"user",
	"channels:read groups:read im:read mpim:read",
	"",
	"cursor limit types exclude_archived",
)
for (const kind of ["messages", "files", "all"])
	add(
		`search.${kind}`,
		"user",
		"search:read",
		"query",
		"count page cursor sort sort_dir highlight",
	)
add("users.list", "either", "users:read", "", "cursor limit")
add("users.info", "either", "users:read", "user", "include_locale")
add("users.lookupByEmail", "either", "users:read.email", "email")
add("users.getPresence", "either", "users:read", "user")
add(
	"users.profile.get",
	"either",
	"users.profile:read",
	"",
	"user include_labels",
)
add("users.profile.set", "user", "users.profile:write", "profile", "", true)
add("users.setPresence", "user", "users:write", "presence", "", true)
add("dnd.info", "either", "dnd:read", "", "user")
add("dnd.teamInfo", "either", "dnd:read", "", "users")
add("dnd.setSnooze", "user", "dnd:write", "num_minutes", "", true)
for (const verb of ["endSnooze", "endDnd"])
	add(`dnd.${verb}`, "user", "dnd:write", "", "", true)
add(
	"chat.postMessage",
	"either",
	"chat:write",
	"channel text",
	"thread_ts reply_broadcast blocks attachments unfurl_links unfurl_media parse metadata",
	true,
)
add(
	"chat.postEphemeral",
	"either",
	"chat:write",
	"channel text",
	"thread_ts blocks",
	true,
)
add(
	"chat.update",
	"either",
	"chat:write",
	"channel ts",
	"text blocks attachments metadata",
	true,
)
add("chat.delete", "either", "chat:write", "channel ts", "", true)
add("chat.getPermalink", "either", "", "channel message_ts")
add(
	"chat.scheduleMessage",
	"either",
	"chat:write",
	"channel text post_at",
	"thread_ts reply_broadcast blocks unfurl_links unfurl_media",
	true,
)
add(
	"chat.scheduledMessages.list",
	"user",
	"chat:write",
	"",
	"channel cursor limit oldest latest",
)
add(
	"chat.deleteScheduledMessage",
	"user",
	"chat:write",
	"channel scheduled_message_id",
	"",
	true,
)
add("chat.unfurl", "laddu", "links:write", "channel ts unfurls", "", true)
for (const verb of ["add", "remove"])
	add(
		`reactions.${verb}`,
		"either",
		"reactions:write",
		"channel timestamp name",
		"",
		true,
	)
add("reactions.get", "either", "reactions:read", "channel timestamp", "full")
add("reactions.list", "user", "reactions:read", "", "cursor limit full")
for (const verb of ["add", "remove"])
	add(`pins.${verb}`, "either", "pins:write", "channel timestamp", "", true)
add("pins.list", "either", "pins:read", "channel")
add("bookmarks.list", "either", "bookmarks:read", "channel_id")
add(
	"bookmarks.add",
	"either",
	"bookmarks:write",
	"channel_id title type link",
	"emoji",
	true,
)
add(
	"bookmarks.edit",
	"either",
	"bookmarks:write",
	"channel_id bookmark_id",
	"title link emoji",
	true,
)
add(
	"bookmarks.remove",
	"either",
	"bookmarks:write",
	"channel_id bookmark_id",
	"",
	true,
)
add("emoji.list", "either", "emoji:read")
add("team.info", "either", "team:read")
add(
	"files.list",
	"user",
	"files:read",
	"",
	"channel user types ts_from ts_to count page",
)
add("files.info", "user", "files:read", "file", "count page")
add("files.delete", "user", "files:write", "file", "", true)
add("files.revokePublicURL", "user", "files:write", "file", "", true)
for (const verb of ["list", "info", "add", "delete", "complete"])
	add(
		`reminders.${verb}`,
		"user",
		verb === "list" || verb === "info"
			? "reminders:read"
			: "reminders:write",
		verb === "add" ? "text time" : verb === "list" ? "" : "reminder",
		"",
		!["list", "info"].includes(verb),
	)
// Free supports one canvas tab per channel. Standalone canvases and Lists are deliberately absent.
add(
	"conversations.canvases.create",
	"user",
	"canvases:write",
	"channel_id",
	"document_content",
	true,
)
add(
	"canvases.create",
	"user",
	"canvases:write",
	"channel_id",
	"title document_content",
	true,
)
add("canvases.edit", "user", "canvases:write", "canvas_id changes", "", true)
add("canvases.sections.lookup", "user", "canvases:read", "canvas_id criteria")
add("canvases.getContent", "user", "canvases:read", "canvas_id")

export class SlackToolError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message)
	}
}
export function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Even public channel writes from laddu require the requester to belong to that channel. */
export async function requireMember(
	client: SlackClient,
	person: Person,
	channel: string,
	token?: string,
): Promise<Record<string, unknown>> {
	const info = await client.conversations.info({
		channel,
		...(token ? { token } : {}),
	})
	const details = info.channel as Record<string, unknown> | undefined
	if (!details)
		throw new SlackToolError("Conversation not found or unavailable.", 404)
	let cursor: string | undefined
	do {
		const page = await client.conversations.members({
			channel,
			cursor,
			limit: 200,
			...(token ? { token } : {}),
		})
		if (page.members?.includes(person.userId)) return details
		cursor = page.response_metadata?.next_cursor || undefined
	} while (cursor)
	throw new SlackToolError("You aren't a member of that conversation.", 403)
}

export async function resolveChannel(
	client: SlackClient,
	person: Person,
	input: string,
	token?: string,
): Promise<string> {
	const mention = /^<#([CGD][A-Z0-9]+)(?:\|[^>]+)?>$/.exec(input)
	if (mention) return mention[1]!
	if (/^[CGD][A-Z0-9]+$/.test(input)) return input
	const name = input.replace(/^#/, "")
	let cursor: string | undefined
	do {
		const page = await client.conversations.list({
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: 200,
			cursor,
			...(token ? { token } : {}),
		})
		const match = page.channels?.find(channel => channel.name === name)
		if (match?.id) {
			await requireMember(client, person, match.id, token)
			return match.id
		}
		cursor = page.response_metadata?.next_cursor || undefined
	} while (cursor)
	throw new SlackToolError(
		`Channel ${input} wasn't found. Use its Slack channel ID.`,
		404,
	)
}

export function slackFailure(error: unknown): SlackToolError {
	if (error instanceof SlackToolError) return error
	const data = (
		error as {
			data?: { error?: string; needed?: string }
			retryAfter?: number
		}
	).data
	const code = data?.error
	if (code === "missing_scope")
		return new SlackToolError(
			`Slack needs ${data?.needed ?? "additional permissions"}. Reconnect with slack connect; the app installer may also need to reinstall laddu.`,
			403,
		)
	if (code === "not_allowed_token_type")
		return new SlackToolError(
			"Slack requires a different token type for this method. Try --as user and reconnect Slack.",
			403,
		)
	if (
		code &&
		[
			"paid_only",
			"not_available_on_free",
			"free_teams_cannot_create_standalone_canvases",
			"free_teams_cannot_edit_standalone_canvases",
		].includes(code)
	)
		return new SlackToolError(`Unavailable on Slack Free (${code}).`, 403)
	if (
		code === "ratelimited" ||
		(error as { code?: string }).code === "slack_webapi_rate_limited_error"
	)
		return new SlackToolError("Slack rate limit reached; retry later.", 429)
	return new SlackToolError(
		`Slack request failed: ${code ?? (error instanceof Error ? error.message : "unknown error")}`,
		502,
	)
}

export async function callSlack(
	client: SlackClient,
	person: Person,
	input: { method: string; args?: unknown; as?: string },
) {
	const spec = methods[input.method]
	if (!Object.hasOwn(methods, input.method) || !spec)
		throw new SlackToolError(
			"Method isn't exposed by laddu's Slack Free tools. Run slack methods.",
		)
	if (input.as !== undefined && !["auto", "user", "laddu"].includes(input.as))
		throw new SlackToolError("Identity must be auto, user or laddu.")
	const args = input.args ?? {}
	if (!object(args))
		throw new SlackToolError("Arguments must be a JSON object.")
	for (const key of Object.keys(args))
		if (![...spec.required, ...spec.optional].includes(key))
			throw new SlackToolError(
				`Unsupported argument ${key} for ${input.method}. Run slack methods ${input.method}.`,
			)
	for (const key of spec.required)
		if (args[key] === undefined || args[key] === null || args[key] === "")
			throw new SlackToolError(`Missing ${key} for ${input.method}.`)
	const saved = await connection(person)
	const identity =
		input.as === "laddu"
			? "laddu"
			: input.as === "user"
				? "user"
				: spec.identity === "laddu"
					? "laddu"
					: saved
						? "user"
						: spec.identity === "user"
							? "user"
							: "laddu"
	if (
		(spec.identity === "user" && identity !== "user") ||
		(spec.identity === "laddu" && identity !== "laddu")
	)
		throw new SlackToolError(
			`${input.method} requires --as ${spec.identity}.`,
			403,
		)
	if (identity === "user" && !saved)
		throw new SlackToolError(
			"Connect your Slack account with slack connect first.",
			409,
		)
	const token = identity === "user" ? saved!.token : undefined
	const options = { ...args }
	try {
		for (const key of ["channel", "channel_id"])
			if (options[key] !== undefined) {
				if (typeof options[key] !== "string")
					throw new SlackToolError(
						`${key} must be a channel ID or name.`,
					)
				options[key] = await resolveChannel(
					client,
					person,
					options[key] as string,
					token,
				)
				if (!token)
					await requireMember(client, person, options[key] as string)
			}
		if (input.method === "chat.postEphemeral") options.user = person.userId
		if (input.method === "users.profile.get" && !options.user)
			options.user = person.userId
		// Bot tokens cannot read channel threads with conversations.replies; use the person's token.
		if (!token && input.method === "conversations.replies")
			throw new SlackToolError(
				"Reading arbitrary threads requires slack connect and --as user.",
				409,
			)
		const result = (await client.apiCall(input.method, {
			...options,
			...(token ? { token } : {}),
		})) as Awaited<ReturnType<SlackClient["apiCall"]>> &
			Record<string, unknown>
		if (!result.ok) throw { data: result }
		if (
			!token &&
			input.method === "conversations.list" &&
			Array.isArray(result.channels)
		) {
			const visible = []
			for (const channel of result.channels as Record<
				string,
				unknown
			>[]) {
				if (!channel.is_private && !channel.is_im && !channel.is_mpim)
					visible.push(channel)
				else if (typeof channel.id === "string") {
					try {
						await requireMember(client, person, channel.id)
						visible.push(channel)
					} catch {
						/* Private bot memberships aren't exposed to other people. */
					}
				}
			}
			result.channels = visible
		}
		console.info(
			`[slack api] ${person.userId} ${input.method} as ${identity}`,
		)
		return { identity, result }
	} catch (error) {
		if (
			token &&
			["token_revoked", "invalid_auth", "account_inactive"].includes(
				(error as { data?: { error?: string } }).data?.error ?? "",
			)
		)
			await forget(person)
		throw slackFailure(error)
	}
}

export async function capabilities(
	client: SlackClient,
	person: Person,
	method?: string,
) {
	if (method && !Object.hasOwn(methods, method))
		throw new SlackToolError("Unknown Slack Free method.")
	const saved = await connection(person)
	const catalog = method ? { [method]: methods[method] } : methods
	return {
		planTarget: "free",
		connected: !!saved,
		userScopes: saved?.scopes ?? [],
		historyLimitDays: 90,
		methods: catalog,
		excluded: [
			"Lists",
			"Workflow Builder",
			"custom user groups",
			"standalone canvases",
			"Enterprise APIs",
			"paid agent surfaces",
		],
		note: "Scopes shown are requirements, with alternatives for conversation types. Actual permissions and Slack availability are enforced on each call. Use returned cursors/pages to paginate.",
	}
}
