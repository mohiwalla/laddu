/**
 * An instance's .env: read it, and change keys in place so comments and order survive. Values are
 * always written quoted (AGENTS.md).
 */

export type Env = Record<string, string>

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/** Bun's .env rules: in double quotes `\$` and `\n` are escapes; a `"` can't be escaped at all. */
function unquote(raw: string): string {
	const value = raw.trim()
	const double = value.match(/^"(.*)"(\s+#.*)?$/)
	if (double)
		return double[1]!.replace(/\\([$n])/g, (_, char: string) =>
			char === "n" ? "\n" : char,
		)
	const single = value.match(/^'(.*)'(\s+#.*)?$/)
	if (single) return single[1]!
	// Unquoted: a comment starts at " #".
	return value.replace(/\s+#.*$/, "")
}

function quote(value: string): string {
	if (/["\n]/.test(value))
		throw new Error(
			`Can't write a value with quotes or line breaks: ${value}`,
		)
	// Bun expands $NAME inside values, even quoted ones.
	return `"${value.replace(/\$/g, "\\$")}"`
}

export function parseEnv(text: string): Env {
	const env: Env = {}
	for (const line of text.split("\n")) {
		const match = line.match(LINE)
		if (match) env[match[1]!] = unquote(match[2]!)
	}
	return env
}

export async function readEnv(path: string): Promise<Env> {
	const file = Bun.file(path)
	return (await file.exists()) ? parseEnv(await file.text()) : {}
}

/** Sets keys (null removes them): replaced where they are, new ones appended. */
export function updateEnvText(
	text: string,
	changes: Record<string, string | null>,
): string {
	const pending = new Map(Object.entries(changes))
	const lines = text.split("\n").flatMap(line => {
		const key = line.match(LINE)?.[1]
		if (!key || !pending.has(key)) return [line]
		const value = pending.get(key)!
		pending.delete(key)
		return value === null ? [] : [`${key}=${quote(value)}`]
	})
	while (lines.length && lines.at(-1) === "") lines.pop()
	for (const [key, value] of pending)
		if (value !== null) lines.push(`${key}=${quote(value)}`)
	return `${lines.join("\n")}\n`
}

export async function updateEnv(
	path: string,
	changes: Record<string, string | null>,
): Promise<void> {
	const file = Bun.file(path)
	const text = (await file.exists()) ? await file.text() : ""
	await Bun.write(path, updateEnvText(text, changes))
	await Bun.$`chmod 600 ${path}`.quiet()
}
