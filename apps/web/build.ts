/**
 * Builds laddu.wtf into dist/: runs Astro static build (which copies public/ assets like og.png,
 * robots.txt, favicon.ico, and mascots/), then adds the CLI's install.sh so
 * `curl -fsSL https://laddu.wtf/install.sh | sh` works on Vercel.
 */
const root = Bun.fileURLToPath(new URL("./", import.meta.url))
const dist = `${root}dist`

await Bun.$`astro build`.cwd(root)
await Bun.write(`${dist}/install.sh`, Bun.file(`${root}../cli/install.sh`))

console.log(`Built laddu.wtf with Astro + Bun ${Bun.version} in ${dist}`)
