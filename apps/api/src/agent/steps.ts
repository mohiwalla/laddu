/**
 * Turns Codex's items into plain-language steps for the Slack progress UI. Codex usually writes a
 * short note before acting ("Checking the weather on wttr.in"); that becomes the step's title and
 * the raw command is kept as its details. Without a note, the title is guessed from the command.
 */
import type { ThreadItem } from "@openai/codex-sdk"

export type Step = {
	id: string
	title: string
	status: "in_progress" | "complete" | "error"
	details?: string
}

const MAX_TITLE = 150
const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text

/** `/bin/bash -lc "…"` → `…`: Codex wraps every command in a login shell. */
export function unwrapCommand(command: string): string {
	const match = command.match(/^\S*?(?:bash|zsh|sh) -lc (["'])([\s\S]*)\1$/)
	if (!match) return command
	return match[1] === '"'
		? match[2]!.replace(/\\(["\\$`])/g, "$1")
		: match[2]!
}

/** A plain-language title for a command Codex didn't narrate. */
export function commandTitle(command: string): string {
	const host = command.match(/https?:\/\/([^/\s'"?#]+)/)?.[1]
	const program = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? ""
	if (host && /\b(curl|wget)\b/.test(command)) return `Fetching ${host}`
	if (/^python3?$/.test(program)) return "Running a Python script"
	if (/^(unzip|tar|gunzip|7z)$/.test(program)) return "Unpacking files"
	if (
		/^(rg|grep|find|ls|cat|head|tail|sed|awk|wc|jq|file|stat|tree)$/.test(
			program,
		)
	)
		return "Looking through files"
	if (/^(mkdir|cp|mv|rm|touch|ln)$/.test(program)) return "Organizing files"
	if (program === "git") return "Working with git"
	if (program === "memory")
		return /^\s*memory\s+show\b/.test(command)
			? "Checking memory"
			: "Updating memory"
	if (program === "ms") {
		const area = command.trim().split(/\s+/)[1] ?? ""
		if (/^(connect|disconnect)$/.test(area))
			return "Setting up Microsoft 365"
		return (
			{
				mail: "Checking Outlook",
				calendar: "Checking the calendar",
				files: "Working with OneDrive and SharePoint",
				teams: "Checking Teams",
				planner: "Checking Planner",
			}[area] ?? "Checking Microsoft 365"
		)
	}
	if (program === "ado")
		return /^\s*ado\s+(connect|disconnect)\b/.test(command)
			? "Setting up Azure DevOps"
			: "Checking Azure DevOps"
	return "Running a command"
}

/** First line of a note Codex wrote before acting, as a title. */
function narrationTitle(text: string): string | null {
	const line = text
		.trim()
		.split("\n")[0]!
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "") // list markers, when it writes notes as bullets
		.trim()
		.replace(/[.:…]+$/, "")
	return line ? clip(line, MAX_TITLE) : null
}

function toStep(item: ThreadItem, done: boolean): Step | null {
	const status = (itemStatus?: string): Step["status"] =>
		itemStatus === "failed"
			? "error"
			: done || itemStatus === "completed"
				? "complete"
				: "in_progress"
	switch (item.type) {
		case "command_execution": {
			const command = unwrapCommand(item.command)
			return {
				id: item.id,
				title: commandTitle(command),
				status: status(item.status),
				details: command,
			}
		}
		case "mcp_tool_call":
			return {
				id: item.id,
				title: `Using ${item.server} (${item.tool})`,
				status: status(item.status),
			}
		case "web_search":
			return {
				id: item.id,
				title: clip(`Searching the web for "${item.query}"`, MAX_TITLE),
				status: status(),
			}
		case "file_change": {
			const names = item.changes
				.map(change => change.path.replace(/^.*\//, ""))
				.join(", ")
			return {
				id: item.id,
				title: clip(`Editing ${names}`, MAX_TITLE),
				status: status(item.status),
			}
		}
		default:
			return null
	}
}

/** Feed it every Codex item event; it reports each step's latest state, keeping its first title. */
export function stepTracker(onStep: (step: Step) => void) {
	const titles = new Map<string, string>()
	let narration: string | null = null
	return (item: ThreadItem, done: boolean) => {
		if (item.type === "agent_message") {
			if (done) narration = narrationTitle(item.text)
			return
		}
		const step = toStep(item, done)
		if (!step) return
		let title = titles.get(step.id)
		if (!title) {
			// A note applies to the action right after it; later ones get a guessed title.
			title = narration ?? step.title
			narration = null
			titles.set(step.id, title)
		}
		onStep({ ...step, title })
	}
}
