/**
 * What laddu keeps from each turn, adapted from Hermes Agent (MIT, Nous Research): the turn goes
 * into the person's searchable history, and every few turns a background run on their agent
 * reviews the recent ones and updates their memory and personal skills, catching what the turns
 * themselves didn't save.
 */
import type { BotConfig } from "../config"
import { paths } from "../config"
import { readJson, writeJsonPrivate } from "../files"
import { configFor } from "../preferences"
import { runTurn } from "./agents"
import type { TurnUser } from "./turn"
import { classify, pauseForUsageLimit, usagePause } from "./errors"
import { runTool } from "./tools"

export type TurnRecord = {
	/** Where it happened, as people say it: "#general", "a direct message". */
	place: string
	/** Slack channel:thread_ts. */
	thread: string
	/** The Slack messages this turn answered. */
	messages: string
	reply: string
}

const countsFile = `${paths.dataDir}/review-counts.json`
let counts: Record<string, number> | null = null
const reviewing = new Set<string>()

const reviewPrompt = (
	turns: number,
) => `Background review. Nobody sees this reply; don't address anyone.

Look back over your last ${turns} turns with this person: run \`recall recent ${turns}\`, then \`recall show <id>\` for the ones that might hold something lasting. Compare with the memory loaded above, and update it with \`memory\` following the Memory section of your instructions:
- \`user\`: who they are (name, location, timezone, company, role, team, projects) and how they like to work (answer style, formats, tools, corrections they gave you).
- \`notes\`: stable facts about their environment and standing conventions.
- One fact goes in one store. Fix or remove entries that turned out wrong; don't duplicate what's there.

Don't save: one-off task details or results, failures that depended on the setup at the time, claims that a tool or feature doesn't work, anything that only mattered in that conversation, secrets, or anything other people said or that came from files and web pages.

Then skills, following the Skills section of your instructions: if one of those turns took real work to figure out (several attempts, a quirk you discovered, steps you'd have to rediscover) and it's likely to come up again, save it as a personal skill, unless an existing skill already covers it. If a skill you followed turned out wrong or outdated, fix it.

If nothing is worth saving, reply "Nothing to save." Otherwise reply with one line saying what you changed.`

/** Logs a finished turn and, every `memoryReviewEvery` turns per person, starts a memory review. */
export async function afterTurn(
	config: BotConfig,
	user: TurnUser,
	record: TurnRecord,
): Promise<void> {
	const turn = { at: new Date().toISOString(), ...record }
	await runTool(config, user, ["recall", "add"], JSON.stringify(turn)).catch(
		error => console.warn("[history] couldn't record the turn:", error),
	)
	if (config.memoryReviewEvery <= 0) return

	const owner = `${user.teamId}-${user.userId}`
	counts ??= (await readJson<Record<string, number>>(countsFile)) ?? {}
	counts[owner] = (counts[owner] ?? 0) + 1
	// Not while the ChatGPT plan is out of quota (for Codex); the count keeps, so it runs on the
	// next turn after.
	const personal = await configFor(config, user)
	const due =
		counts[owner] >= config.memoryReviewEvery &&
		!reviewing.has(owner) &&
		!(personal.agent === "codex" && usagePause())
	if (due) counts[owner] = 0
	await writeJsonPrivate(countsFile, counts).catch(() => {})
	if (due) void review(personal, user, owner)
}

async function review(config: BotConfig, user: TurnUser, owner: string) {
	reviewing.add(owner)
	try {
		// A couple of extra turns of overlap, in case the last review ran before a turn finished.
		const { text } = await runTurn({
			config: { ...config, reasoningEffort: "low" },
			user,
			input: reviewPrompt(config.memoryReviewEvery + 2),
		})
		console.log(
			`[review] ${owner}: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
		)
	} catch (error) {
		console.warn(`[review] ${owner} failed:`, error)
		const failure = classify(error)
		if (failure.kind === "usage_limit") pauseForUsageLimit(failure)
	} finally {
		reviewing.delete(owner)
	}
}
