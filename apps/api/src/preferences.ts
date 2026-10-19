/**
 * Each person's own settings, picked on dot's Home tab: the model, how hard it thinks, and fast
 * mode. Unset ones fall back to the bot's (.env). A pick the model no longer supports is ignored,
 * so a catalog change never breaks a turn.
 */
import type { BotConfig } from "./config"
import { paths } from "./config"
import { readJson, writeJsonPrivate } from "./files"
import { listModels, type ModelOption } from "./agent/codex"

export type Preferences = { model?: string; effort?: string; fast?: boolean }
type Person = { teamId: string; userId: string }

const file = `${paths.dataDir}/preferences.json`
let all: Record<string, Preferences> | null = null
const key = (person: Person) => `${person.teamId}-${person.userId}`

async function load(): Promise<Record<string, Preferences>> {
	return (all ??= (await readJson<Record<string, Preferences>>(file)) ?? {})
}

export async function preferences(person: Person): Promise<Preferences> {
	return (await load())[key(person)] ?? {}
}

/** Changes some of their settings; undefined values go back to the bot's. */
export async function setPreferences(
	person: Person,
	change: Preferences,
): Promise<void> {
	const saved = await load()
	const next = { ...saved[key(person)], ...change }
	for (const name of Object.keys(next) as (keyof Preferences)[])
		if (next[name] === undefined) delete next[name]
	if (Object.keys(next).length) saved[key(person)] = next
	else delete saved[key(person)]
	await writeJsonPrivate(file, saved)
}

export type Effective = {
	model: string
	effort: string
	fast: boolean
	/** The model's catalog entry (absent if Codex didn't list it). */
	option?: ModelOption
}

/** What their turns use: their picks where the model supports them, else the bot's. */
export function effective(
	config: BotConfig,
	picked: Preferences,
	models: ModelOption[],
): Effective {
	const find = (id?: string) => models.find(model => model.id === id)
	const option = find(picked.model) ?? find(config.model)
	const model = option?.id ?? config.model
	const supports = (effort?: string) =>
		effort !== undefined &&
		(!option || option.efforts.some(candidate => candidate.id === effort))
	const effort = supports(picked.effort)
		? picked.effort!
		: supports(config.reasoningEffort)
			? config.reasoningEffort
			: (option?.defaultEffort ?? config.reasoningEffort)
	const fast = (picked.fast ?? config.fast) && (option ? option.fast : true)
	return { model, effort, fast, ...(option ? { option } : {}) }
}

/** The bot's config with this person's settings applied, for their turns. */
export async function configFor(
	config: BotConfig,
	person: Person,
): Promise<BotConfig> {
	const picked = await preferences(person)
	if (!Object.keys(picked).length) return config
	const chosen = effective(config, picked, await listModels())
	return {
		...config,
		model: chosen.model,
		reasoningEffort: chosen.effort as BotConfig["reasoningEffort"],
		fast: chosen.fast,
	}
}
