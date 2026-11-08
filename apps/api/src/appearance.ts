/**
 * What each person calls laddu, and the picture it wears for them: set on the Home tab or by asking
 * laddu (`appearance`). Every message laddu posts for that person carries them (Slack's
 * chat:write.customize), so everyone in the conversation sees them; laddu's @handle, profile and
 * Home tab stay its own, as do its reactions (Slack can't dress those up) and system notices
 * (slack/system.ts), which are the bot's own. Pictures are served from the gateway's public HTTPS address, where Slack fetches them once per
 * message; without one, only names work.
 */
import type { App } from "@slack/bolt"
import { paths } from "./config"
import { readJson, writeJsonPrivate } from "./files"
import { systemName } from "./slack/system"

type WebClient = App["client"]
type Person = { teamId: string; userId: string }

export type Appearance = {
	name?: string
	/** A preset (PRESETS) or an uploaded picture ("<hash>.png"). */
	picture?: string
}

/**
 * Pictures anyone can pick, in assets/pictures/: the mascots on laddu's icon background (#282828),
 * filling the square like its icon. Bump PRESETS_VERSION when they change; Slack caches by address.
 */
const PRESETS_VERSION = 2
export const PRESETS: Record<string, string> = {
	"jalebi.png": "Jalebi",
	"kaju-katli.png": "Kaju katli",
	"gulab-jamun.png": "Gulab jamun",
	"rasgulla.png": "Rasgulla",
}
export const PRESET_DIR = Bun.fileURLToPath(
	new URL("../assets/pictures/", import.meta.url),
)
export const UPLOAD_DIR = `${paths.dataDir}/pictures`
const UPLOADED = /^[0-9a-f]{32}\.(png|jpg|gif)$/
export const MAX_NAME = 40
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024

const file = `${paths.dataDir}/appearance.json`
let all: Record<string, Appearance> | null = null
const key = (person: Person) => `${person.teamId}-${person.userId}`

async function load(): Promise<Record<string, Appearance>> {
	return (all ??= (await readJson<Record<string, Appearance>>(file)) ?? {})
}

export async function appearance(person: Person): Promise<Appearance> {
	return (await load())[key(person)] ?? {}
}

/** Changes their name or picture; undefined goes back to laddu's own. */
export async function setAppearance(
	person: Person,
	change: Appearance,
): Promise<void> {
	const saved = await load()
	const before = saved[key(person)]?.picture
	const next = { ...saved[key(person)], ...change }
	for (const name of Object.keys(next) as (keyof Appearance)[])
		if (next[name] === undefined) delete next[name]
	if (Object.keys(next).length) saved[key(person)] = next
	else delete saved[key(person)]
	await writeJsonPrivate(file, saved)
	// An upload nobody wears any more.
	if (
		before &&
		UPLOADED.test(before) &&
		!Object.values(saved).some(other => other.picture === before)
	)
		await Bun.file(`${UPLOAD_DIR}/${before}`)
			.delete()
			.catch(() => {})
}

/** The file behind /_laddu/pictures/<name>, or null if there's no such picture. */
export function pictureFile(name: string): string | null {
	if (name in PRESETS) return `${PRESET_DIR}${name}`
	return UPLOADED.test(name) ? `${UPLOAD_DIR}/${name}` : null
}

let publicUrl: string | null = null
/** Where Slack fetches pictures: the gateway's public address, if it's HTTPS. */
export function servePicturesAt(url: string) {
	publicUrl = url.startsWith("https:") ? url : null
}
export const picturesWork = () => publicUrl !== null

export const pictureUrl = (picture: string) =>
	publicUrl &&
	`${publicUrl}/_laddu/pictures/${encodeURIComponent(picture)}${picture in PRESETS ? `?v=${PRESETS_VERSION}` : ""}`

/** The fields to add to a chat.postMessage / chat.startStream laddu sends for them. */
export async function postAs(
	person: Person,
): Promise<{ username?: string; icon_url?: string }> {
	const { name, picture } = await appearance(person)
	const icon = picture && pictureUrl(picture)
	return {
		...(name ? { username: name } : {}),
		...(icon ? { icon_url: icon } : {}),
	}
}

/** A line for the agent when the bot isn't called laddu here or they've renamed it, or null. */
export async function nameNote(person: Person): Promise<string | null> {
	const { name } = await appearance(person)
	const own = systemName()
	const notes = [
		own !== "laddu" &&
			`In this workspace the bot is called "${own}", not laddu: people tag you as @${own}, so call yourself ${own}.`,
		name &&
			`The person you're working for calls you "${name}": your replies to them show that name, so answer to it.`,
	].filter(Boolean)
	return notes.length ? notes.join(" ") : null
}

/** Saves an uploaded picture (PNG, JPEG or GIF); its file name, or why it can't be used. */
export async function savePicture(
	bytes: Uint8Array,
): Promise<{ picture: string } | { problem: string }> {
	if (bytes.length > MAX_PICTURE_BYTES)
		return { problem: "That picture is over 5 MB." }
	const type = imageType(bytes)
	if (!type) return { problem: "Use a PNG, JPEG or GIF picture." }
	const hash = new Bun.CryptoHasher("sha256")
		.update(bytes)
		.digest("hex")
		.slice(0, 32)
	const picture = `${hash}.${type}`
	await Bun.write(`${UPLOAD_DIR}/${picture}`, bytes, { createPath: true })
	return { picture }
}

function imageType(bytes: Uint8Array): "png" | "jpg" | "gif" | null {
	const starts = (...magic: number[]) =>
		magic.every((byte, index) => bytes[index] === byte)
	if (starts(0x89, 0x50, 0x4e, 0x47)) return "png"
	if (starts(0xff, 0xd8, 0xff)) return "jpg"
	if (starts(0x47, 0x49, 0x46, 0x38)) return "gif"
	return null
}

let members: { names: Set<string>; at: number } | null = null

/**
 * Why they can't use this name, or null. Not a real person's name in the workspace: laddu's
 * messages would read as that person's (Slack's APP badge is easy to miss).
 */
export async function nameProblem(
	client: WebClient,
	name: string,
): Promise<string | null> {
	if (!name) return "Give a name."
	if (name.length > MAX_NAME) return `Keep it to ${MAX_NAME} characters.`
	if (/[<>@*_~`\n]/.test(name))
		return "Use plain text: no @, <, >, or formatting."
	if (!members || Date.now() - members.at > 10 * 60_000) {
		const names = new Set<string>()
		let cursor: string | undefined
		do {
			const page = await client.users.list({ limit: 200, cursor })
			for (const user of page.members ?? [])
				if (!user.is_bot && !user.deleted && user.id !== "USLACKBOT")
					for (const known of [
						user.name,
						user.real_name,
						user.profile?.display_name,
						user.profile?.real_name,
						user.profile?.first_name,
					])
						if (known?.trim()) names.add(known.trim().toLowerCase())
			cursor = page.response_metadata?.next_cursor || undefined
		} while (cursor)
		members = { names, at: Date.now() }
	}
	return members.names.has(name.toLowerCase())
		? "That's someone's name in this workspace; pick one that isn't."
		: null
}

/** Tidies a name as typed: one line, single spaces. */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ")
