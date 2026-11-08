/**
 * Reads a JSON file; null when it's missing. A file that won't parse (cut off by a crash before
 * writes were atomic, or edited by hand) is moved aside to `<path>.corrupt-<time>` and read as
 * missing, so one bad file can't stop the bot from starting.
 */
export async function readJson<T>(path: string): Promise<T | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	try {
		return (await file.json()) as T
	} catch (error) {
		const aside = `${path}.corrupt-${Date.now()}`
		console.error(
			`[files] ${path} isn't valid JSON; moved to ${aside}:`,
			error,
		)
		await Bun.$`mv ${path} ${aside}`.quiet().catch(() => {})
		return null
	}
}

/**
 * Write a file only the current user can read, creating parent directories. Atomic: it's written
 * and locked down under a temporary name, then renamed over `path`, so a crash never leaves a
 * half-written file and the file is never readable by others, even briefly.
 * `Bun.write`'s `mode` option only applies to file-to-file copies (Bun 1.4), hence the chmod.
 */
export async function writePrivate(
	path: string,
	contents: string,
): Promise<void> {
	const temp = `${path}.${crypto.randomUUID()}.tmp`
	try {
		await Bun.write(temp, contents, { createPath: true })
		await Bun.$`chmod 600 ${temp}`.quiet()
		await Bun.$`mv -f ${temp} ${path}`.quiet()
	} catch (error) {
		await Bun.$`rm -f ${temp}`.quiet().catch(() => {})
		throw error
	}
}

export const writeJsonPrivate = (path: string, value: unknown) =>
	writePrivate(path, JSON.stringify(value, null, 2))
