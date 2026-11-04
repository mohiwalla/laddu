import { expect, test } from "bun:test"
import type { ThreadItem } from "@openai/codex-sdk"
import { stepTracker, type Step, type Todos } from "./steps"

test.each([
	["rg missing file.txt", 1, "complete"],
	["rg --files", 1, "complete"],
	["grep missing file.txt", 1, "complete"],
	["rg missing file.txt", 2, "error"],
	["rg missing file.txt; false", 1, "error"],
	["rg missing file.txt | another-command", 1, "error"],
	["python3 script.py", 1, "error"],
] as const)(
	"search exit semantics: %s (exit %i)",
	(command, exit_code, status) => {
		const steps: Step[] = []
		stepTracker(step => steps.push(step))(
			{
				id: "cmd",
				type: "command_execution",
				command,
				status: "failed",
				exit_code,
				aggregated_output: "",
			} satisfies ThreadItem,
			true,
		)
		expect(steps[0]?.status).toBe(status)
		if (status === "complete")
			expect(steps[0]?.details).toContain("No matches found.")
	},
)

test("desktop exec keeps the computer viewer available", () => {
	const steps: Step[] = []
	stepTracker(step => steps.push(step))(
		{
			id: "desktop-exec",
			type: "command_execution",
			command: "desktop exec xfconf-query -c xfce4-desktop -lv",
			status: "in_progress",
			aggregated_output: "",
		} satisfies ThreadItem,
		false,
	)
	expect(steps[0]?.computer).toBe(true)
})

test("the to-do list goes out whole, and actions stay steps", () => {
	const steps: Step[] = []
	const lists: Todos[] = []
	const track = stepTracker(
		step => steps.push(step),
		todos => lists.push(todos),
	)
	track(
		{
			type: "plan",
			title: " Scheduled exports ",
			items: [
				{ text: "Design the table", status: "completed" },
				{ text: "Cron dispatcher", status: "in_progress" },
				{ text: " ", status: "pending" },
			],
		},
		false,
	)
	expect(lists).toEqual([
		{
			title: "Scheduled exports",
			items: [
				{ text: "Design the table", status: "completed" },
				{ text: "Cron dispatcher", status: "in_progress" },
			],
		},
	])
	expect(steps).toEqual([])
	track(
		{
			id: "search",
			type: "web_search",
			query: "cron",
		} satisfies ThreadItem,
		true,
	)
	expect(steps.map(step => step.id)).toEqual(["search"])
})
