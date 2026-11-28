import { expect, spyOn, test } from "bun:test"
import { AGENTS } from "../agent/agents"
import type { BotConfig } from "../config"
import { setPreferences } from "../preferences"
import { agentSection, agyConnectView, claudeConnectView } from "./home"

test("Connect Claude and Antigravity modals separate steps with clear hierarchy and no intro blurb", () => {
	const cases = [
		{
			view: claudeConnectView("https://claude.ai/oauth/authorize?x=1"),
			callbackId: "home_claude_code",
			title: "Connect Claude",
			step1Title: "*Step 1 · Sign in with Claude*",
			buttonText: "Open Claude sign-in ↗",
			url: "https://claude.ai/oauth/authorize?x=1",
			placeholder: "Code from Claude",
		},
		{
			view: agyConnectView(
				"https://accounts.google.com/o/oauth2/auth?x=1",
			),
			callbackId: "home_agy_code",
			title: "Connect Antigravity",
			step1Title: "*Step 1 · Sign in with Google*",
			buttonText: "Open Google sign-in ↗",
			url: "https://accounts.google.com/o/oauth2/auth?x=1",
			placeholder: "Code or callback URL",
		},
	] as const

	for (const c of cases) {
		expect(c.view.callback_id).toBe(c.callbackId)
		expect(c.view.title.text).toBe(c.title)
		expect(c.view.submit?.text).toBe("Connect")
		expect(c.view.blocks.map(b => b.type)).toEqual([
			"section",
			"context",
			"actions",
			"divider",
			"input",
		])
		const [step1, , actions, , input] = c.view.blocks
		expect(step1).toMatchObject({
			type: "section",
			text: { type: "mrkdwn", text: c.step1Title },
		})
		expect("accessory" in step1!).toBe(false)
		const btn = (
			actions as unknown as { elements: Record<string, unknown>[] }
		).elements[0]!
		expect(btn).toMatchObject({
			type: "button",
			action_id: "system_link",
			text: { text: c.buttonText },
			url: c.url,
		})
		expect(btn.style).toBeUndefined()
		expect(input).toMatchObject({
			type: "input",
			block_id: "code",
			label: { text: "Step 2 · Paste the code" },
			element: { placeholder: { text: c.placeholder } },
		})
	}
})

test("Connect modals show only loading context while waiting for a link, and prepend retry warnings", () => {
	const loading = agyConnectView(null)
	expect(loading.submit).toBeUndefined()
	expect(loading.blocks.map(b => b.type)).toEqual(["context"])

	const retry = claudeConnectView(
		"https://claude.ai/oauth/authorize?x=2",
		"That code didn't work.",
	)
	expect(retry.blocks.map(b => b.type)).toEqual([
		"section",
		"section",
		"context",
		"actions",
		"divider",
		"input",
	])
	expect(retry.blocks[0]).toMatchObject({
		type: "section",
		text: { text: ":warning:  That code didn't work." },
	})
})

test("Agent settings include Model attribution toggle enabled by default and honoring opt-out", async () => {
	const person = { teamId: "T_HOME_ATTR", userId: "U_HOME_ATTR" }
	const listSpy = spyOn(AGENTS.codex, "listModels").mockResolvedValue([
		{
			id: "gpt-6.2-sol",
			name: "GPT-6.2 Sol",
			description: "Default model",
			efforts: [{ id: "high", description: "" }],
			defaultEffort: "high",
			fast: true,
			images: true,
			isDefault: true,
		},
	])
	const config = {
		agent: "codex",
		model: "",
		claudeModel: "",
		agyModel: "",
		opencodeModel: "",
		reasoningEffort: "high",
		claudeEffort: "",
		agyEffort: "",
		opencodeEffort: "",
		fast: false,
	} as unknown as BotConfig
	try {
		const initial = await agentSection(config, person)
		const findToggle = (blocks: typeof initial) =>
			blocks.find(
				block =>
					block.type === "section" &&
					"accessory" in block &&
					block.accessory &&
					"action_id" in block.accessory &&
					block.accessory.action_id === "home_attribution",
			) as
				| {
						accessory?: {
							initial_option?: {
								value?: string
								text?: { text?: string }
							}
						}
				  }
				| undefined
		expect(findToggle(initial)?.accessory?.initial_option?.value).toBe("on")

		await setPreferences(person, { attribution: false })
		const disabled = await agentSection(config, person)
		expect(findToggle(disabled)?.accessory?.initial_option?.value).toBe(
			"off",
		)
	} finally {
		await setPreferences(person, { attribution: undefined })
		listSpy.mockRestore()
	}
})
