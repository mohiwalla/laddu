/**
 * The model provider step. Only the ChatGPT plan for now (Codex on the person's own plan, signed in
 * once); other providers would be more entries in PROVIDERS.
 */
import { botRoot } from "./paths"
import { readLine } from "./terminal"

type Login = typeof import("../../api/src/auth/login")
type Siwc = typeof import("../../api/src/auth/siwc")

/**
 * The bot's own sign-in code, pointed at this instance. It reads DATA_DIR when first imported, so
 * one CLI run works with one instance.
 */
async function botAuth(dataDir: string, appName: string) {
	Bun.env.DATA_DIR = dataDir
	Bun.env.APP_NAME = appName
	const login: Login = await import(`${botRoot}/src/auth/login.ts`)
	const siwc: Siwc = await import(`${botRoot}/src/auth/siwc.ts`)
	return { ...login, ...siwc }
}

export async function signInWithChatGpt(dataDir: string, appName: string) {
	const auth = await botAuth(dataDir, appName)
	const credentials = await auth.signIn(readLine)
	return {
		email: credentials.account?.email,
		models: await auth.listModels(credentials.access_token!),
	}
}

/** Already signed in with plan usage: the models, without a new sign-in. Null if not. */
export async function existingChatGpt(dataDir: string, appName: string) {
	const auth = await botAuth(dataDir, appName)
	const credentials = await auth.loadCredentials()
	if (!credentials || !auth.hasPlanUsage(credentials)) return null
	try {
		const token = await auth.getAccessToken()
		return {
			email: credentials.account?.email,
			models: await auth.listModels(token),
		}
	} catch {
		return null
	}
}
