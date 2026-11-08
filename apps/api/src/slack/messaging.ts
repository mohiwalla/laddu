/**
 * laddu messaging people for someone: `slack find` looks people up, `slack dm` sends a DM. As the
 * person, with their own Slack sign-in (user-tokens.ts), when they've connected; otherwise from
 * laddu (bot token), saying who it's from.
 */
import { postAs } from "../appearance"
import { systemName } from "./system"
import type { App } from "@slack/bolt"
import { forget, userToken } from "./user-tokens"

type WebClient = App["client"]

/** Longest message laddu passes on; longer ones belong in a file or the person's own message. */
const MAX_TEXT = 4_000
/** DMs one person can send through laddu per hour, so a runaway turn can't spam the workspace. */
const HOURLY_LIMIT = 20
const DIRECTORY_TTL_MS = 10 * 60_000

type Person = {
	id: string
	name: string
	realName: string
	title: string
	email: string
}

let directory: { people: Person[]; at: number; teamId: string } | null = null

/** Everyone active in the workspace (no bots, no deactivated accounts), cached for 10 minutes. */
async function people(client: WebClient, teamId: string): Promise<Person[]> {
	if (
		directory?.teamId === teamId &&
		Date.now() - directory.at < DIRECTORY_TTL_MS
	)
		return directory.people
	const found: Person[] = []
	let cursor: string | undefined
	do {
		const page = await client.users.list({ limit: 200, cursor })
		for (const user of page.members ?? []) {
			if (user.deleted || user.is_bot || user.id === "USLACKBOT") continue
			if (user.team_id && user.team_id !== teamId) continue
			found.push({
				id: user.id!,
				name:
					user.profile?.display_name ||
					user.real_name ||
					user.name ||
					"",
				realName: user.real_name ?? "",
				title: user.profile?.title ?? "",
				email: user.profile?.email ?? "",
			})
		}
		cursor = page.response_metadata?.next_cursor || undefined
	} while (cursor)
	directory = { people: found, at: Date.now(), teamId }
	return found
}

/**
 * What someone could be called in a message: their Slack ID, email, and each of their names and
 * first names that nobody else in the workspace goes by. Empty when they aren't in the workspace.
 */
export async function namesFor(
	client: WebClient,
	teamId: string,
	who: { id?: string; email?: string },
): Promise<string[]> {
	const everyone = await people(client, teamId)
	const email = who.email?.toLowerCase()
	const them = everyone.find(
		person =>
			person.id === who.id ||
			(email !== undefined && person.email.toLowerCase() === email),
	)
	if (!them) return []
	const called = (person: Person) => {
		const full = [person.name, person.realName]
			.map(name => name.trim().toLowerCase())
			.filter(Boolean)
		return new Set([...full, ...full.map(name => name.split(/\s+/)[0]!)])
	}
	const others = everyone.filter(person => person.id !== them.id).map(called)
	const unique = [...called(them)].filter(
		name => !others.some(names => names.has(name)),
	)
	return [them.id, them.email, ...unique].filter(Boolean)
}

/** People whose name, display name or email contains every word of the query. */
export async function findPeople(
	client: WebClient,
	teamId: string,
	query: string,
): Promise<string> {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (!words.length) return "Give a name or email to look for."
	const matches = (await people(client, teamId)).filter(person => {
		const haystack =
			`${person.name} ${person.realName} ${person.email}`.toLowerCase()
		return words.every(word => haystack.includes(word))
	})
	if (!matches.length) return `Nobody in the workspace matches "${query}".`
	return matches
		.slice(0, 15)
		.map(person =>
			[
				`<@${person.id}>`,
				person.realName || person.name,
				person.name !== person.realName ? `(${person.name})` : "",
				person.title ? `— ${person.title}` : "",
				person.email ? `<${person.email}>` : "",
			]
				.filter(Boolean)
				.join(" "),
		)
		.join("\n")
		.concat(
			matches.length > 15 ? `\n…and ${matches.length - 15} more.` : "",
		)
}

const sent = new Map<string, number[]>()

/** Room left in this hour's allowance; records the send when there is. */
function allowance(senderId: string): boolean {
	const recent = (sent.get(senderId) ?? []).filter(
		at => Date.now() - at < 3_600_000,
	)
	if (recent.length >= HOURLY_LIMIT) return false
	sent.set(senderId, [...recent, Date.now()])
	return true
}

/** `<@U123>`, `U123` or an email → a Slack user ID, or a reason it can't be messaged. */
export async function recipient(
	client: WebClient,
	teamId: string,
	to: string,
): Promise<{ id: string } | { problem: string }> {
	const trimmed = to.trim()
	const id = /^<?@?([UW][A-Z0-9]{5,})(\|[^>]*)?>?$/.exec(trimmed)?.[1]
	if (!id && !trimmed.includes("@"))
		return {
			problem: `"${to}" isn't a Slack ID or email. Look them up with \`slack find\` first.`,
		}
	const { user } = id
		? await client.users
				.info({ user: id })
				.catch(() => ({ user: undefined }))
		: await client.users
				.lookupByEmail({ email: trimmed })
				.catch(() => ({ user: undefined }))
	if (!user) return { problem: `No Slack user ${to}.` }
	if (user.deleted) return { problem: `${to}'s account is deactivated.` }
	if (user.is_bot || user.id === "USLACKBOT")
		return { problem: `${to} is a bot.` }
	if (user.team_id && user.team_id !== teamId)
		return { problem: `${to} isn't in this workspace.` }
	return { id: user.id! }
}

/** "DM me": laddu DMs them, as itself; a DM as them to themselves would just be a note to self. */
async function dmThemselves(
	client: WebClient,
	person: { teamId: string; userId: string },
	message: string,
): Promise<{ ok: boolean; text: string }> {
	if (!allowance(person.userId))
		return {
			ok: false,
			text: `They've sent ${HOURLY_LIMIT} DMs through laddu in the last hour, the limit. Try again later.`,
		}
	const { channel } = await client.conversations.open({
		users: person.userId,
	})
	await client.chat.postMessage({
		channel: channel!.id!,
		...(await postAs(person)),
		markdown_text: message,
	})
	console.info(
		`[slack dm] ${person.userId} → themselves from laddu (${message.length} chars)`,
	)
	return {
		ok: true,
		text: `Sent to them, in their DM with ${systemName()}.`,
	}
}

/** Slack's errors for a user token it no longer accepts. */
const DEAD_TOKEN = new Set([
	"token_revoked",
	"invalid_auth",
	"account_inactive",
	"not_authed",
	"missing_scope",
])

/**
 * Sends `text` to `to`: as the person, in their own DM with them, when they've connected Slack;
 * otherwise (or with `fromLaddu`) from laddu, in laddu's DM with them, headed with who it's from.
 */
export async function sendOnBehalf(
	client: WebClient,
	from: { teamId: string; userId: string },
	to: string,
	text: string,
	fromLaddu: boolean,
): Promise<
	| { ok: true; text: string }
	| { ok: false; text: string; notConnected?: true }
> {
	const message = text.trim()
	if (!message) return { ok: false, text: "Give the message to send." }
	if (message.length > MAX_TEXT)
		return {
			ok: false,
			text: `That's ${message.length} characters; keep it under ${MAX_TEXT}.`,
		}
	const found = await recipient(client, from.teamId, to)
	if ("problem" in found) return { ok: false, text: found.problem }
	if (found.id === from.userId) return dmThemselves(client, from, message)
	const token = fromLaddu ? null : await userToken(from)
	if (!fromLaddu && !token)
		return {
			ok: false,
			notConnected: true,
			text: "They haven't connected their Slack account, so it can't come from them. Run `slack connect` (DMs them a link), or send it from laddu with `slack dm --from-laddu`.",
		}
	if (!allowance(from.userId))
		return {
			ok: false,
			text: `They've sent ${HOURLY_LIMIT} DMs through laddu in the last hour, the limit. Try again later.`,
		}

	if (token) {
		try {
			const { channel } = await client.conversations.open({
				token,
				users: found.id,
			})
			await client.chat.postMessage({
				token,
				channel: channel!.id!,
				markdown_text: message,
			})
		} catch (error) {
			const code = (error as { data?: { error?: string } }).data?.error
			if (!code || !DEAD_TOKEN.has(code)) throw error
			await forget(from)
			return {
				ok: false,
				text: `Their Slack connection stopped working (${code}), so nothing was sent. Run \`slack connect\` to connect again, or send it from laddu with \`slack dm --from-laddu\`.`,
			}
		}
		console.info(
			`[slack dm] ${from.userId} → ${found.id} as them (${message.length} chars)`,
		)
		return { ok: true, text: `Sent to <@${found.id}>, as them.` }
	}

	const { channel } = await client.conversations.open({ users: found.id })
	await client.chat.postMessage({
		channel: channel!.id!,
		...(await postAs(from)),
		markdown_text: `<@${from.userId}> asked ${systemName()} to send you this:\n\n${message}\n\n_Sent by ${systemName()} for <@${from.userId}>. To answer, message them directly._`,
	})
	console.info(
		`[slack dm] ${from.userId} → ${found.id} from laddu (${message.length} chars)`,
	)
	return { ok: true, text: `Sent to <@${found.id}>, from laddu.` }
}
