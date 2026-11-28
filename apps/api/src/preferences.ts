/**
 * Each person's own settings, picked on laddu's Home tab: the agent, its model, how hard it thinks,
 * and fast mode. Unset ones fall back to the bot's (.env). A pick the model no longer supports is
 * ignored, so a catalog change never breaks a turn.
 */
import type { BotConfig } from "./config"
import { paths } from "./config"
import { readJson, writeJsonPrivate } from "./files"
import { AGENTS, type AgentId } from "./agent/agents"
import type { ModelOption } from "./agent/turn"

export type Preferences = {
	agent?: AgentId
	model?: string
	effort?: string
	fast?: boolean
	/** Show which harness/model answered at the end of replies and sent messages (default: true). */
	attribution?: boolean
}
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

/** The agent their turns run on: their pick, else the bot's. */
export const agentFor = (config: BotConfig, picked: Preferences): AgentId =>
	picked.agent ?? config.agent

/** Whether model attribution is shown for this person (enabled by default). */
export async function attributionEnabled(person: Person): Promise<boolean> {
	return (await preferences(person)).attribution !== false
}

export type Effective = {
	agent: AgentId
	model: string
	effort: string
	fast: boolean
	attribution: boolean
	/** The model's catalog entry (absent if the agent didn't list it). */
	option?: ModelOption
}

/**
 * What their turns use on `agent` (agentFor(…)): their picks where the model supports them, else
 * the bot's, else the agent's own default. `models` are that agent's (AGENTS[agent].listModels()).
 */
export function effective(
	config: BotConfig,
	agent: AgentId,
	picked: Preferences,
	models: ModelOption[],
): Effective {
	const fallback = {
		codex: config.model,
		claude: config.claudeModel,
		agy: config.agyModel,
		opencode: config.opencodeModel,
	}[agent]
	const fallbackEffort = {
		codex: config.reasoningEffort,
		claude: config.claudeEffort,
		agy: config.agyEffort,
		opencode: config.opencodeEffort,
	}[agent]
	const find = (id?: string) => models.find(model => model.id === id)
	const option =
		find(picked.model) ??
		find(fallback) ??
		(fallback ? undefined : models.find(model => model.isDefault))
	const model = option?.id ?? fallback
	const supports = (effort?: string) =>
		effort !== undefined &&
		(!option || option.efforts.some(candidate => candidate.id === effort))
	const effort = supports(picked.effort)
		? picked.effort!
		: fallbackEffort && supports(fallbackEffort)
			? fallbackEffort
			: option?.defaultEffort === "low" && supports("medium")
				? "medium"
				: (option?.defaultEffort ?? fallbackEffort)
	const fast =
		(picked.fast ?? config.fast) &&
		(option ? option.fast : agent === "codex")
	const attribution = picked.attribution ?? true
	return {
		agent,
		model,
		effort,
		fast,
		attribution,
		...(option ? { option } : {}),
	}
}

/** The bot's config with this person's settings applied, for their turns. */
export async function configFor(
	config: BotConfig,
	person: Person,
): Promise<BotConfig> {
	const picked = await preferences(person)
	const agent = agentFor(config, picked)
	const hasModelPicks =
		picked.agent !== undefined ||
		picked.model !== undefined ||
		picked.effort !== undefined ||
		picked.fast !== undefined
	if (!hasModelPicks && agent === "codex") return config
	const chosen = effective(
		config,
		agent,
		picked,
		await AGENTS[agent].listModels(config, person),
	)
	return {
		...config,
		agent,
		model: chosen.model,
		reasoningEffort: chosen.effort as BotConfig["reasoningEffort"],
		fast: chosen.fast,
	}
}
