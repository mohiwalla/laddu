/**
 * Builds the npm package `create-laddu` in dist/: this CLI plus the bot (apps/api) it sets up and
 * runs. Bun runs the TypeScript as is, so it's a copy, not a bundle. Publish with
 * `npm publish dist` (CI does, on each version tag).
 */
const root = Bun.fileURLToPath(new URL("./", import.meta.url))
const api = Bun.fileURLToPath(new URL("../api/", import.meta.url))
const dist = `${root}dist`

const cli = await Bun.file(`${root}package.json`).json()
const bot = await Bun.file(`${api}package.json`).json()

await Bun.$`rm -rf ${dist} && mkdir -p ${dist}/cli ${dist}/bot`
await Bun.$`cp -a ${root}src/. ${dist}/cli/`
for (const path of [
	"src",
	"runtime",
	"docker",
	"scripts",
	"agent-home",
	"assets",
	"slack-manifest.yaml",
	".env.example",
])
	await Bun.$`cp -a ${api}${path} ${dist}/bot/`

// Tests, deployment-private files and local caches stay out.
const excluded = [
	"*.test.ts",
	"AGENTS.local.md",
	"skills.local",
	"__pycache__",
	"*.pyc",
]
await Bun.$`find ${dist} ${["(", ...excluded.flatMap((name, index) => [...(index ? ["-o"] : []), "-name", name]), ")"]} -prune -exec rm -rf {} +`

await Bun.write(
	`${dist}/bot/package.json`,
	`${JSON.stringify({ name: "@laddu/bot", private: true, type: "module" }, null, "\t")}\n`,
)
await Bun.write(
	`${dist}/package.json`,
	`${JSON.stringify(
		{
			name: "create-laddu",
			version: cli.version,
			description: cli.description,
			type: "module",
			license: "UNLICENSED",
			bin: { laddu: "cli/index.ts", "create-laddu": "cli/create.ts" },
			engines: { bun: ">=1.4" },
			os: ["linux"],
			dependencies: bot.dependencies,
		},
		null,
		"\t",
	)}\n`,
)
await Bun.$`cp ${root}README.md ${dist}/README.md`
await Bun.$`chmod 755 ${dist}/cli/index.ts ${dist}/cli/create.ts`
console.log(`Built laddu ${cli.version} in ${dist}`)
