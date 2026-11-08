/**
 * Each person's own ChatGPT sign-in for Codex. Codex's app-server runs the device-code sign-in in
 * their container (`account/login/start`), laddu DMs them the link and code, and the login is
 * kept in Codex's own `auth.json` in their container, where Codex refreshes it. Nobody else's
 * turns can use it, and the bot never holds it.
 */
import type { App } from "@slack/bolt"
import type { BotConfig } from "../config"
import { sendNotice, systemName, type Where } from "../slack/system"
import { askCodex, forgetCodexModels, openCodex } from "./codex"
import { stopRun } from "./containers"
import type { AppServer } from "./app-server"
import type { TurnUser } from "./turn"

type WebClient = App["client"]

/** A ChatGPT plan, or their own OpenAI API key (plan "apiKey", no email). */
export type Account = { email: string | null; plan: string }

const key = (user: TurnUser) => `${user.teamId}-${user.userId}`
const ACCOUNT_MS = 10 * 60_000
const accounts = new Map<
	string,
	{ account: Promise<Account | null>; at: number }
>()

/** Who they're signed in to ChatGPT as, or null; cached for a few minutes. */
export function codexAccount(
	config: BotConfig,
	user: TurnUser,
): Promise<Account | null> {
	const cached = accounts.get(key(user))
	if (cached && Date.now() - cached.at < ACCOUNT_MS) return cached.account
	const account = askCodex(config, user, async server => {
		const read = await server.request<{
			account: {
				type: string
				email?: string | null
				planType?: string
			} | null
		}>("account/read", {})
		if (read.account?.type === "apiKey")
			return { email: null, plan: "apiKey" }
		return read.account?.type === "chatgpt"
			? {
					email: read.account.email ?? null,
					plan: read.account.planType ?? "unknown",
				}
			: null
	})
	accounts.set(key(user), { account, at: Date.now() })
	account.catch(() => accounts.delete(key(user)))
	return account
}

function forget(user: TurnUser) {
	accounts.delete(key(user))
	forgetCodexModels(user)
}

/** Sign-ins waiting for the person, by person: the app-server holding each one open. */
const signingIn = new Map<
	string,
	{ server: AppServer; stop: () => Promise<void> }
>()

/** Where ChatGPT's "device code sign-in for Codex" switch is; it's off until they turn it on. */
const SECURITY_URL =
	"https://chatgpt.com/settings/security#:~:text=Enable%20device%20code%20sign%2Din%20for%20Codex%2C%20Excel%2C%20PowerPoint%2C%20and%20Word"

/** How long Codex's device codes work. */
const CODE_MINUTES = 15

/**
 * Sends them a ChatGPT sign-in link and code, privately where they are (`where`; null: their
 * DM), and keeps Codex waiting for it in their container; the outcome goes to the same place.
 * `done` runs once it ends either way (to redraw their Home tab). A newer sign-in replaces this one.
 */
export async function signIn(
	config: BotConfig,
	client: WebClient,
	user: TurnUser,
	where: Where,
	done: () => void = () => {},
): Promise<void> {
	const id = key(user)
	const earlier = signingIn.get(id)
	if (earlier) {
		signingIn.delete(id)
		earlier.server.close()
		await earlier.stop()
	}
	const turnId = `signin-${crypto.randomUUID().slice(0, 8)}`
	const { server, container } = await openCodex(config, user, {
		LADDU_TURN: turnId,
	})
	const session = { server, stop: () => stopRun(container, turnId) }
	try {
		const started = await server.request<{
			loginId: string
			userCode: string
			verificationUrl: string
		}>("account/login/start", { type: "chatgptDeviceCode" })
		const finished = new Promise<{
			success: boolean
			error: string | null
		}>(resolve =>
			server.listen(({ method, params }) => {
				if (
					method === "account/login/completed" &&
					params.loginId === started.loginId
				)
					resolve({
						success: Boolean(params.success),
						error: (params.error as string | null) ?? null,
					})
			}),
		)
		await sendNotice(client, user, where, {
			icon: ":key:",
			title: "Connect your ChatGPT account",
			text: `${systemName()} runs on your own ChatGPT plan.${earlier ? " (New code; the earlier one no longer works.)" : ""}`,
			steps: [
				`Turn on *device code sign-in for Codex* in <${SECURITY_URL}|ChatGPT security settings> (once).`,
				"Open the sign-in page and sign in to ChatGPT.",
				"Enter this code:",
			],
			code: started.userCode,
			link: { label: "Open sign-in page", url: started.verificationUrl },
			buttons: [
				{
					label: "Use an API key",
					action: "home_chatgpt",
					value: "key",
				},
			],
			footer: `Works for ${CODE_MINUTES} minutes. Didn't ask for this? Ignore it.`,
		})
		signingIn.set(id, session)
		void (async () => {
			const outcome = await Promise.race([
				finished,
				server.exited.then(() => null),
				Bun.sleep(CODE_MINUTES * 60_000).then(() => ({
					success: false,
					error: "The code expired.",
				})),
			])
			// Replaced by a newer sign-in: that one reports.
			if (signingIn.get(id) !== session) return
			signingIn.delete(id)
			forget(user)
			if (outcome?.success) {
				const account = await codexAccount(config, user).catch(
					() => null,
				)
				await sendNotice(client, user, where, {
					icon: ":white_check_mark:",
					title: "ChatGPT connected",
					text: `${account?.email ? `Signed in as ${account.email}. ` : ""}Send your message again.`,
				})
			} else
				await sendNotice(client, user, where, {
					icon: ":warning:",
					title: "ChatGPT isn't connected",
					text: outcome?.error ?? "The sign-in didn't finish.",
					steps: [
						`Check that *device code sign-in for Codex* is on in <${SECURITY_URL}|ChatGPT security settings>.`,
						"Send your message again for a new code.",
					],
				})
			done()
		})()
			.catch(error => console.warn("[account] sign-in failed:", error))
			.finally(() => {
				server.close()
				void session.stop()
			})
	} catch (error) {
		server.close()
		await session.stop()
		throw error
	}
}

/**
 * Codex on their own OpenAI API key instead of a plan: Codex's own API-key login, kept in its
 * `auth.json` in their container like a ChatGPT one. A sign-in still waiting ends quietly.
 */
export async function useCodexKey(
	config: BotConfig,
	user: TurnUser,
	apiKey: string,
): Promise<void> {
	const waiting = signingIn.get(key(user))
	if (waiting) {
		signingIn.delete(key(user))
		waiting.server.close()
		await waiting.stop()
	}
	await askCodex(config, user, server =>
		server.request("account/login/start", { type: "apiKey", apiKey }),
	)
	forget(user)
}

/** Signs them out of ChatGPT in their container; their turns then ask them to sign in again. */
export async function signOut(
	config: BotConfig,
	user: TurnUser,
): Promise<void> {
	await askCodex(config, user, server => server.request("account/logout", {}))
	forget(user)
}
