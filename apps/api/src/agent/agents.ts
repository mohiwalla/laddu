/**
 * The agents dot can run a turn on, one per person (picked on the Home tab, see preferences.ts):
 * Codex on the owner's ChatGPT plan (native app-server), or OpenCode's free models (over ACP).
 * Everything for a person runs on their pick, background memory reviews included.
 */
import { listCodexModels, runCodexTurn } from "./codex"
import { listOpenCodeModels, runOpenCodeTurn } from "./opencode"
import type { ModelOption, TurnOptions, TurnResult } from "./turn"

export type AgentId = "codex" | "opencode"

export const AGENTS: Record<
	AgentId,
	{
		name: string
		/** What it runs on, for the Home tab. */
		plan: string
		listModels: () => Promise<ModelOption[]>
		runTurn: (options: TurnOptions) => Promise<TurnResult>
	}
> = {
	codex: {
		name: "Codex",
		plan: "ChatGPT subscription",
		listModels: listCodexModels,
		runTurn: runCodexTurn,
	},
	opencode: {
		name: "OpenCode",
		plan: "Free models",
		listModels: listOpenCodeModels,
		runTurn: runOpenCodeTurn,
	},
}

export const isAgent = (value: unknown): value is AgentId =>
	typeof value === "string" && Object.hasOwn(AGENTS, value)

/** Runs the turn on the agent its config names (configFor() in preferences.ts sets it per person). */
export function runTurn(options: TurnOptions): Promise<TurnResult> {
	return AGENTS[options.config.agent].runTurn(options)
}
