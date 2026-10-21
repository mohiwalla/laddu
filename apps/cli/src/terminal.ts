/**
 * Prompts and output for the wizard. Reads lines from stdin, which `install.sh` points at the
 * terminal (with `curl … | sh`, stdin is the script itself).
 */

const color = (code: number) => (text: string) =>
	Bun.enableANSIColors ? `\x1b[${code}m${text}\x1b[0m` : text
export const bold = color(1)
export const dim = color(2)
export const green = color(32)
export const yellow = color(33)
export const red = color(31)
export const cyan = color(36)

export const say = (...lines: string[]) => console.log(lines.join("\n"))
export const step = (title: string) => say("", bold(cyan(`▸ ${title}`)))
export const done = (text: string) => say(`  ${green("✓")} ${text}`)
export const warn = (text: string) => say(`  ${yellow("!")} ${text}`)
export const fail = (text: string) => say(`  ${red("✗")} ${text}`)

let reader: { read(): Promise<{ value?: string; done: boolean }> } | null = null
let buffer = ""
let ended = false
/** The one read in flight; a prompt that stops waiting leaves it to fill the buffer for the next. */
let filling: Promise<void> | null = null

function fill(): Promise<void> {
	reader ??= Bun.stdin
		.stream()
		.pipeThrough(new TextDecoderStream())
		.getReader()
	filling ??= reader!.read().then(({ value, done }) => {
		if (done) ended = true
		else buffer += value
		filling = null
	})
	return filling
}

const abortion = (signal: AbortSignal) =>
	new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason)
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		})
	})

/**
 * One line from stdin. A read still waiting when the signal aborts rejects, and whatever is typed
 * goes to the next one. Throws once stdin has ended, so the wizard never spins on a closed terminal.
 */
export async function readLine(signal?: AbortSignal): Promise<string> {
	while (!buffer.includes("\n")) {
		if (ended) throw new Error("No terminal to read from (stdin ended).")
		await (signal ? Promise.race([fill(), abortion(signal)]) : fill())
	}
	const end = buffer.indexOf("\n")
	const line = buffer.slice(0, end).replace(/\r$/, "")
	buffer = buffer.slice(end + 1)
	return line
}

/** Asks for text; empty input takes the default. `check` returns an error message or nothing. */
export async function ask(
	question: string,
	options: {
		default?: string
		check?: (value: string) => string | void
	} = {},
): Promise<string> {
	while (true) {
		const hint = options.default ? dim(` [${options.default}]`) : ""
		await Bun.write(Bun.stdout, `  ${question}${hint}: `)
		const value = (await readLine()).trim() || options.default || ""
		const problem = options.check?.(value)
		if (!problem) return value
		fail(problem)
	}
}

export async function confirm(question: string, fallback = true) {
	const answer = await ask(
		`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")}`,
		{
			check: value =>
				/^(y(es)?|no?|)$/i.test(value) ? undefined : "Answer y or n.",
		},
	)
	return answer ? /^y/i.test(answer) : fallback
}

export type Choice<T> = { label: string; value: T; hint?: string }

/** A numbered list; Enter picks the default (the first choice unless given). */
export async function choose<T>(
	question: string,
	choices: Choice<T>[],
	fallback = 0,
): Promise<T> {
	say(`  ${question}`)
	choices.forEach((choice, index) =>
		say(
			`    ${index === fallback ? green(">") : " "} ${index + 1}. ${choice.label}${choice.hint ? dim(`  ${choice.hint}`) : ""}`,
		),
	)
	const answer = await ask("Choice", {
		default: String(fallback + 1),
		check: value =>
			Number(value) >= 1 && Number(value) <= choices.length
				? undefined
				: `Pick a number from 1 to ${choices.length}.`,
	})
	return choices[Number(answer) - 1]!.value
}
