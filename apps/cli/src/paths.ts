/** Where things live: the bot's code, each instance's state, and how this user runs services. */

/** Running as root: system-wide services and state. Otherwise everything is this user's. */
export const isRoot = (await Bun.$`id -u`.text()).trim() === "0"

/** Every instance's folder lives here, one per name. */
export const home = isRoot ? "/var/lib/slack-dot" : `${Bun.env.HOME}/.slack-dot`

export const instanceDir = (name: string) => `${home}/${name}`

/** The bot (apps/api): next to the CLI in the published package, or the sibling app in the repo. */
export const botRoot = await (async () => {
	for (const candidate of ["../bot/", "../../api/"]) {
		const dir = new URL(candidate, import.meta.url)
		if (await Bun.file(new URL("package.json", dir)).exists())
			return Bun.fileURLToPath(dir).replace(/\/$/, "")
	}
	throw new Error("The bot's files are missing from this install.")
})()

/** Installed from npm (updates come from there), or run from a git checkout. */
export const fromPackage = botRoot.endsWith("/bot")

export const bun = Bun.which("bun") ?? Bun.argv[0]!

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/

export async function instanceNames(): Promise<string[]> {
	const exists = await Bun.file(home)
		.stat()
		.then(stat => stat.isDirectory())
		.catch(() => false)
	if (!exists) return []
	const names: string[] = []
	for await (const path of new Bun.Glob("*/.env").scan({
		cwd: home,
		dot: true,
	}))
		names.push(path.slice(0, path.indexOf("/")))
	return names.sort()
}
