import { expect, test } from "bun:test"
import { codexFastTier } from "./agent/codex"
import {
	clearTurnAttribution,
	contextFooterBlock,
	formatAttribution,
	getTurnAttribution,
	sentThroughLabel,
	setTurnAttribution,
} from "./attribution"

test("formats Codex attribution with harness, humanized model, effort and fast", () => {
	expect(
		formatAttribution({
			agent: "codex",
			model: "gpt-6.2-astra",
			effort: "high",
			fast: true,
		}),
	).toBe("Codex GPT-6.2 Astra high fast")
	expect(
		formatAttribution({
			agent: "codex",
			model: "gpt-6.2-astra",
			modelName: "6.2 Astra",
			effort: "high",
			fast: true,
		}),
	).toBe("Codex 6.2 Astra high fast")
	expect(
		formatAttribution({
			agent: "codex",
			model: "gpt-5.4",
			effort: "medium",
			fast: false,
		}),
	).toBe("Codex GPT-5.4 medium")
	expect(
		formatAttribution({
			agent: "codex",
			model: "o4-mini",
			effort: "high",
		}),
	).toBe("Codex o4-mini high")
	expect(formatAttribution({ agent: "codex" })).toBe("Codex")
})

test("formats Claude Code attribution without duplicating Claude prefix", () => {
	expect(
		formatAttribution({
			agent: "claude",
			model: "claude-sonnet-5-5-20260929",
			effort: "max",
		}),
	).toBe("Claude Sonnet 5.5 max")
	expect(
		formatAttribution({
			agent: "claude",
			model: "claude-opus-4-6",
			effort: "high",
		}),
	).toBe("Claude Opus 4.6 high")
	expect(
		formatAttribution({
			agent: "claude",
			model: "claude-opus-4-6[1m]",
			effort: "high",
		}),
	).toBe("Claude Opus 4.6 (1M) high")
	expect(
		formatAttribution({
			agent: "claude",
			model: "default",
			modelName: "Default (recommended)",
			modelDescription: "Opus 4.6 · Most capable for complex work",
			effort: "high",
		}),
	).toBe("Claude Opus 4.6 high")
	expect(
		formatAttribution({
			agent: "claude",
			model: "sonnet",
			modelName: "Sonnet",
			modelDescription: "Sonnet 5.5 · Best for everyday tasks",
			effort: "max",
		}),
	).toBe("Claude Sonnet 5.5 max")
	expect(formatAttribution({ agent: "claude" })).toBe("Claude Code")
})

test("formats Antigravity and OpenCode attribution with their harness name", () => {
	expect(
		formatAttribution({
			agent: "agy",
			model: "gemini-4-neon",
			modelName: "Gemini 4 Neon",
			effort: "high",
		}),
	).toBe("Antigravity Gemini 4 Neon high")
	expect(
		formatAttribution({
			agent: "agy",
			model: "claude-sonnet-5-5",
			modelName: "Claude Sonnet 5.5",
			effort: "high",
		}),
	).toBe("Antigravity Claude Sonnet 5.5 high")
	expect(
		formatAttribution({
			agent: "opencode",
			model: "opencode/big-pickle",
			modelName: "Big Pickle",
		}),
	).toBe("OpenCode Big Pickle")
	expect(
		formatAttribution({
			agent: "opencode",
			model: "opencode/deepseek-v4.1-flash-free",
			effort: "max",
		}),
	).toBe("OpenCode DeepSeek V4.1 Flash Free max")
})

test("formats Sent-by label and escapes Slack mrkdwn characters in context footers", () => {
	expect(sentThroughLabel("Codex 6.2 Astra high fast", "dot")).toBe(
		"Sent by @dot — Codex 6.2 Astra high fast",
	)
	expect(contextFooterBlock("Codex <beta> & test")).toEqual({
		type: "context",
		elements: [{ type: "mrkdwn", text: "Codex &lt;beta&gt; &amp; test" }],
	})
})

test("tracks and clears active turn attribution by turn target", () => {
	const target = {
		teamId: "T1",
		userId: "U1",
		channel: "C1",
		threadTs: "1.001",
		scheduled: false,
	}
	const info = {
		agent: "codex" as const,
		model: "gpt-6.2-sol",
		effort: "high",
		fast: true,
	}
	expect(getTurnAttribution(target)).toBeUndefined()
	setTurnAttribution(target, info)
	expect(getTurnAttribution(target)).toEqual(info)
	expect(getTurnAttribution({ ...target, scheduled: true })).toBeUndefined()
	clearTurnAttribution(target)
	expect(getTurnAttribution(target)).toBeUndefined()
})

test("codexFastTier recognizes priority and fast service tiers and falls back on null/undefined", () => {
	expect(codexFastTier("priority", false)).toBe(true)
	expect(codexFastTier("fast", false)).toBe(true)
	expect(codexFastTier("standard", true)).toBe(false)
	expect(codexFastTier("flex", true)).toBe(false)
	expect(codexFastTier(null, true)).toBe(true)
	expect(codexFastTier(null, false)).toBe(false)
	expect(codexFastTier(undefined, true)).toBe(true)
	expect(codexFastTier(undefined, false)).toBe(false)
})
