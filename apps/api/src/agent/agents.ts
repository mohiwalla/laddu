/**
 * The agents laddu can run a turn on, one per person (picked on the Home tab, see preferences.ts):
 * Codex on their own ChatGPT plan (native app-server), Claude Code on their own Claude plan
 * (headless `claude`), or OpenCode's free models (over ACP).
 * Everything for a person runs on their pick, background memory reviews included.
 */
import { listClaudeModels, runClaudeTurn } from "./claude"
import { listCodexModels, runCodexTurn } from "./codex"
import { listOpenCodeModels, runOpenCodeTurn } from "./opencode"
import type { BotConfig } from "../config"
import type { ModelOption, TurnOptions, TurnResult, TurnUser } from "./turn"

export type AgentId = "codex" | "claude" | "opencode"

export const AGENTS: Record<
	AgentId,
	{
		name: string
		/** What it runs on, for the Home tab. */
		plan: string
		/** The models this person can pick. */
		listModels: (
			config: BotConfig,
			user: TurnUser,
		) => Promise<ModelOption[]>
		runTurn: (options: TurnOptions) => Promise<TurnResult>
	}
> = {
	codex: {
		name: "Codex",
		plan: "Your ChatGPT plan",
		listModels: listCodexModels,
		runTurn: runCodexTurn,
	},
	claude: {
		name: "Claude Code",
		plan: "Your Claude plan",
		listModels: listClaudeModels,
		runTurn: runClaudeTurn,
	},
	opencode: {
		name: "OpenCode",
		plan: "Free models",
		listModels: () => listOpenCodeModels(),
		runTurn: runOpenCodeTurn,
	},
}

export const isAgent = (value: unknown): value is AgentId =>
	typeof value === "string" && Object.hasOwn(AGENTS, value)

/** Runs the turn on the agent its config names (configFor() in preferences.ts sets it per person). */
export function runTurn(options: TurnOptions): Promise<TurnResult> {
	return AGENTS[options.config.agent].runTurn(options)
}
