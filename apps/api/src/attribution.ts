/**
 * Model attribution for laddu's responses and messages sent through it.
 * Formats the harness, model, reasoning effort and speed into a compact label
 * (e.g. "Codex GPT-6.2 Astra high fast", "Claude Sonnet 5.5 max"), tracks the
 * active turn's resolved model so mid-turn bot API calls (`slack dm`, `slack send`,
 * `slack post`) carry it too, and builds Slack context-block footers.
 */
import type { types } from "@slack/bolt"
import type { AgentId } from "./agent/agents"

export type Attribution = {
	agent: AgentId
	/** Raw model ID (e.g. "gpt-6.2-sol", "claude-sonnet-5-5-20260929", "gemini-4-neon"). */
	model?: string
	/** Human-readable display name from the agent or catalog (e.g. "Gemini 4 Neon"). */
	modelName?: string
	/** Optional catalog description (used for Claude aliases like "default" -> "Opus 4.6 · …"). */
	modelDescription?: string
	/** Reasoning effort (e.g. "low", "medium", "high", "xhigh", "max"). */
	effort?: string
	/** Codex fast tier. */
	fast?: boolean
}

export type TurnTarget = {
	teamId: string
	userId: string
	channel: string
	threadTs: string
	scheduled?: boolean
}

const HARNESS: Record<AgentId, string> = {
	codex: "Codex",
	claude: "Claude Code",
	agy: "Antigravity",
	opencode: "OpenCode",
}

const ACRONYMS: Record<string, string> = {
	gpt: "GPT",
	glm: "GLM",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	codex: "Codex",
	claude: "Claude",
	gemini: "Gemini",
	llama: "Llama",
	kimi: "Kimi",
	minimax: "MiniMax",
}

/** True when a display name already looks curated (spaces or uppercase), not a raw slug. */
const isCuratedName = (name: string) => /[A-Z]/.test(name) || /\s/.test(name)

/** Formats a Claude model ID like "claude-sonnet-5-5-20260929" -> "Claude Sonnet 5.5". */
function formatClaudeId(id: string): string | null {
	let raw = id.trim()
	let suffix = ""
	const bracket = raw.match(/\[([^\]]+)\]$/)
	if (bracket) {
		suffix = ` (${bracket[1]!.toUpperCase()})`
		raw = raw.slice(0, -bracket[0].length)
	}
	// Strip trailing YYYYMMDD release dates.
	raw = raw.replace(/-\d{8}$/, "")
	const modern = raw.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/i)
	if (modern) {
		const family =
			modern[1]!.charAt(0).toUpperCase() +
			modern[1]!.slice(1).toLowerCase()
		const version = modern[3] ? `${modern[2]}.${modern[3]}` : modern[2]
		return `Claude ${family} ${version}${suffix}`
	}
	const legacy = raw.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/i)
	if (legacy) {
		const family =
			legacy[3]!.charAt(0).toUpperCase() +
			legacy[3]!.slice(1).toLowerCase()
		const version = legacy[2] ? `${legacy[1]}.${legacy[2]}` : legacy[1]
		return `Claude ${version} ${family}${suffix}`
	}
	return null
}

/** Formats a raw model slug into a readable name ("gpt-6.2-astra" -> "GPT-6.2 Astra"). */
function humanizeSlug(slug: string): string {
	const cleaned = slug.trim().replace(/^[a-z0-9_-]+\//i, "")
	if (!cleaned) return ""
	const claude = formatClaudeId(cleaned)
	if (claude) return claude
	// Keep compact OpenAI reasoning slugs like "o3", "o4-mini" readable as-is.
	if (/^o\d+(?:-[a-z0-9]+)?$/i.test(cleaned)) return cleaned.toLowerCase()
	// "gpt-6.2-astra" -> "GPT-6.2 Astra", "gpt-5.4" -> "GPT-5.4", "gpt-5.3-codex" -> "GPT-5.3 Codex"
	const gpt = cleaned.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i)
	if (gpt) {
		const tail = gpt[2]
			? ` ${gpt[2].split("-").filter(Boolean).map(formatWord).join(" ")}`
			: ""
		return `GPT-${gpt[1]}${tail}`
	}
	return cleaned.split("-").filter(Boolean).map(formatWord).join(" ")
}

function formatWord(word: string): string {
	const lower = word.toLowerCase()
	if (lower in ACRONYMS) return ACRONYMS[lower]!
	if (/^\d/.test(word)) return word
	if (/^v\d/i.test(word)) return `V${word.slice(1)}`
	return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** Resolves the model display part for an agent (without effort/fast). */
function resolveModelPart(info: Attribution): string {
	const id = info.model?.trim() ?? ""
	const name = info.modelName?.trim() ?? ""
	const desc = info.modelDescription?.trim() ?? ""

	if (info.agent === "claude") {
		const fromId = id ? formatClaudeId(id) : null
		if (fromId) return fromId
		// Claude Code's "default" or short alias ("sonnet") carries the concrete version in description ("Opus 4.6 · …").
		const generic =
			!name ||
			/^default\b/i.test(name) ||
			/^(opus|sonnet|haiku)$/i.test(name)
		if (generic && desc) {
			const lead = desc.split(/\s*·\s*/)[0]?.trim() ?? ""
			if (/^(claude\s+)?(opus|sonnet|haiku)\b/i.test(lead))
				return /^claude\b/i.test(lead) ? lead : `Claude ${lead}`
		}
		if (name && !/^default\b/i.test(name)) {
			if (/^(opus|sonnet|haiku)\b/i.test(name)) return `Claude ${name}`
			if (/^claude\b/i.test(name)) return name
			return `Claude Code ${name}`
		}
		if (id && id !== "default") {
			if (/^(opus|sonnet|haiku)$/i.test(id))
				return `Claude ${formatWord(id)}`
			return `Claude Code ${humanizeSlug(id)}`
		}
		return HARNESS.claude
	}

	const harness = HARNESS[info.agent]
	const model =
		name && isCuratedName(name)
			? name
			: id
				? humanizeSlug(id)
				: name
					? humanizeSlug(name)
					: ""
	if (!model) return harness
	if (model.toLowerCase().startsWith(`${harness.toLowerCase()} `))
		return model
	return `${harness} ${model}`
}

/**
 * Formats a turn's harness, model, reasoning effort and fast tier into a compact attribution label,
 * e.g. "Codex GPT-6.2 Astra high fast" or "Claude Sonnet 5.5 max".
 */
export function formatAttribution(info: Attribution): string {
	const parts = [resolveModelPart(info)]
	const effort = info.effort?.trim().toLowerCase()
	if (effort && effort !== "default") parts.push(effort)
	if (info.fast) parts.push("fast")
	return parts.join(" ")
}

/** Escapes Slack mrkdwn special characters in plain attribution text. */
export const escapeMrkdwn = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Attribution text for messages sent through the bot ("Sent by @dot — Codex …"). */
export function sentThroughLabel(attribution: string, botName: string): string {
	return `Sent by @${botName} — ${attribution}`
}

/** Small muted Slack context block for a footer line (plain text, escaped for mrkdwn). */
export function contextFooterBlock(text: string): types.ContextBlock {
	return {
		type: "context",
		elements: [{ type: "mrkdwn", text: escapeMrkdwn(text) }],
	}
}

/** Small muted Slack context block where the caller already formatted mrkdwn (e.g. `<@U123>`). */
export function rawContextFooterBlock(mrkdwn: string): types.ContextBlock {
	return {
		type: "context",
		elements: [{ type: "mrkdwn", text: mrkdwn }],
	}
}

// ---- active turn tracking -------------------------------------------------------------------

const activeTurns = new Map<string, Attribution>()
const turnKey = (target: TurnTarget) =>
	`${target.teamId}:${target.userId}:${target.channel}:${target.threadTs}:${target.scheduled ? "1" : "0"}`

export function setTurnAttribution(
	target: TurnTarget,
	info: Attribution,
): void {
	activeTurns.set(turnKey(target), info)
}

export function getTurnAttribution(
	target: TurnTarget,
): Attribution | undefined {
	return activeTurns.get(turnKey(target))
}

export function clearTurnAttribution(target: TurnTarget): void {
	activeTurns.delete(turnKey(target))
}
