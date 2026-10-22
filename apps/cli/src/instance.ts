/** One bot on this machine: its folder, .env and the Slack app it was set up with. */
import { readEnv, updateEnv, type Env } from "./env"
import { instanceDir, instanceNames, NAME_PATTERN } from "./paths"
import type { AppCredentials, CliAuth } from "./slack"

/** What setup learned about the Slack app; kept private, in the instance's data folder. */
export type SlackApp = {
	app_id: string
	team_id: string
	team_domain?: string
	/** The bot's name in Slack. */
	name: string
	credentials?: AppCredentials
	/** The Slack CLI-style login that created the app; lets `update` push manifest changes. */
	cli?: CliAuth
}

export class Instance {
	readonly dir: string
	readonly envPath: string
	readonly dataDir: string
	readonly slackAppPath: string

	constructor(readonly name: string) {
		this.dir = instanceDir(name)
		this.envPath = `${this.dir}/.env`
		this.dataDir = `${this.dir}/.data`
		this.slackAppPath = `${this.dataDir}/slack-app.json`
	}

	exists() {
		return Bun.file(this.envPath).exists()
	}

	env(): Promise<Env> {
		return readEnv(this.envPath)
	}

	setEnv(changes: Record<string, string | null>) {
		return updateEnv(this.envPath, changes)
	}

	async slackApp(): Promise<SlackApp | null> {
		const file = Bun.file(this.slackAppPath)
		return (await file.exists()) ? ((await file.json()) as SlackApp) : null
	}

	async saveSlackApp(app: SlackApp) {
		await Bun.$`mkdir -p ${this.dataDir}`.quiet()
		await Bun.write(
			this.slackAppPath,
			`${JSON.stringify(app, null, "\t")}\n`,
		)
		await Bun.$`chmod 600 ${this.slackAppPath}`.quiet()
	}

	/** The folder, private to this user, with places for the deployment's own persona additions. */
	async create() {
		await Bun.$`mkdir -p ${this.dataDir} ${this.dir}/skills.local`.quiet()
		await Bun.$`chmod 700 ${this.dir} ${this.dataDir}`.quiet()
		const notes = Bun.file(`${this.dir}/AGENTS.local.md`)
		if (!(await notes.exists()))
			await Bun.write(
				notes,
				"<!-- Private instructions for this bot, added to its persona every turn (your company, its projects, how you like things done). Edits apply from the next message. -->\n",
			)
	}
}

export const checkName = (name: string) =>
	NAME_PATTERN.test(name)
		? undefined
		: "Use lowercase letters, digits and dashes (up to 31), starting with a letter or digit."

/**
 * The instance a command is about: --name, else the only one there is. Null when it's ambiguous
 * or there are none; the caller says which.
 */
export async function pickInstance(
	name: string | undefined,
): Promise<Instance | string> {
	const names = await instanceNames()
	if (name) {
		if (!names.includes(name))
			return `No bot named "${name}" here.${names.length ? ` There's ${names.join(", ")}.` : ""}`
		return new Instance(name)
	}
	if (names.length === 1) return new Instance(names[0]!)
	if (!names.length)
		return "No bots set up on this machine yet. Run `laddu setup`."
	return `Several bots here (${names.join(", ")}); say which with --name.`
}
