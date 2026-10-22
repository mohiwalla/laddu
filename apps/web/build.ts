/**
 * Builds laddu.wtf into dist/: the page bundled from index.html, plus the files fetched by their
 * own names (the OG image, robots.txt, favicon.ico) and the CLI's install.sh, so
 * `curl -fsSL https://laddu.wtf/install.sh | sh` works. The bundling happens in this process, so
 * it's whichever Bun runs this (on Vercel, the one bun.lock was made with); the log names it.
 */
const root = Bun.fileURLToPath(new URL("./", import.meta.url))
const dist = `${root}dist`

await Bun.$`rm -rf ${dist}`
const result = await Bun.build({
	entrypoints: [`${root}index.html`],
	outdir: dist,
	minify: true,
})
if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}

for (const [from, to] of [
	["public/og.png", "og.png"],
	["public/robots.txt", "robots.txt"],
	["public/favicon.ico", "favicon.ico"],
	["../cli/install.sh", "install.sh"],
])
	await Bun.write(`${dist}/${to}`, Bun.file(`${root}${from}`))

console.log(`Built laddu.wtf with Bun ${Bun.version} in ${dist}`)
