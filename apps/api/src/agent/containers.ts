/**
 * One Docker container per Slack user. Codex runs inside it (see scripts/codex-docker.sh),
 * so commands it executes can't see the host: no home directory, keys, tokens or this repo.
 * A named volume keeps each user's workspace and Codex sessions across restarts.
 */
import type { BotConfig } from "../config"
import { paths } from "../config"
import { writePrivate } from "../files"
import { codexConfig } from "./codex-config"
import { startModelProxy, type ModelProxy } from "./model-proxy"
import { botApiUrl } from "./bot-api"

const appRoot = Bun.fileURLToPath(new URL("../../", import.meta.url))
const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"))

/** Paths inside the container. */
export const CONTAINER_HOME = "/home/dot"
export const CONTAINER_WORKDIR = `${CONTAINER_HOME}/workspace`

/** Commands for Codex (`memory`, `recall`) in runtime/; the host runtime uses them in place. */
export const TOOLS_DIR = `${appRoot}runtime`
/** The same commands in the runtime mount; scripts/codex-docker.sh puts them on PATH. */
export const CONTAINER_TOOLS_DIR = "/opt/dot/runtime/bin"

/** Port of the desktop's web viewer inside each container (runtime/desktop). */
export const DESKTOP_VIEWER_PORT = 6901

/** Stand-in `codex` executable that forwards into the container named by $DOT_CONTAINER. */
export const CODEX_DOCKER_WRAPPER = `${appRoot}scripts/codex-docker.sh`

const runtimeDir = `${paths.dataDir}/runtime`
const hostConfigToml = `${runtimeDir}/config.toml`
const hostModelCatalog = `${runtimeDir}/models.json`

let imageTag: string | null = null

/** The platform folder (bin/codex, its helper binaries and resources) of the @openai/codex package the SDK uses. */
async function codexDistribution() {
	const sdkDir = dirname(Bun.resolveSync("@openai/codex-sdk", appRoot))
	const codexPackageJson = Bun.resolveSync(
		"@openai/codex/package.json",
		sdkDir,
	)
	const { version } = (await Bun.file(codexPackageJson).json()) as {
		version: string
	}

	for (const platform of [
		"@openai/codex-linux-x64",
		"@openai/codex-linux-arm64",
	]) {
		let packageDir: string
		try {
			packageDir = dirname(
				Bun.resolveSync(
					`${platform}/package.json`,
					dirname(codexPackageJson),
				),
			)
		} catch {
			continue
		}
		const [codex] = await Array.fromAsync(
			new Bun.Glob("vendor/*/bin/codex").scan({
				cwd: packageDir,
				absolute: true,
			}),
		)
		if (codex) return { version, dir: dirname(dirname(codex)) }
	}
	throw new Error(
		"Could not find the Linux codex binary in node_modules (@openai/codex-linux-*)",
	)
}

/**
 * Writes Codex's bundled model catalog (from the codex build the SDK uses) with sub-agents
 * switched off for every model. Current models enable them from their catalog entry
 * (`multi_agent_version`) whatever `[features]` says, and a sub-agent's reply is an input item
 * the ChatGPT plan rejects, failing the turn. Regenerated each start, so it follows Codex updates.
 */
export async function writeModelCatalog(path: string): Promise<void> {
	const { dir } = await codexDistribution()
	// The bot's own CODEX_HOME, so this never reads or writes your personal ~/.codex.
	await Bun.$`mkdir -p ${paths.codexHome}`.quiet()
	const catalog = (await Bun.$`${dir}/bin/codex debug models --bundled`
		.env({ ...Bun.env, CODEX_HOME: paths.codexHome })
		.quiet()
		.json()) as { models: Record<string, unknown>[] }
	for (const model of catalog.models) model.multi_agent_version = null
	await writePrivate(path, JSON.stringify(catalog, null, "\t"))
}

/**
 * Builds the runtime image if this Dockerfile + codex version hasn't been built yet, starts the
 * model proxy and points the containers' Codex config at it. Returns the image tag and proxy.
 */
/** Builds the runtime image unless this Dockerfile + codex version is already built; returns its tag. */
export async function ensureImage(): Promise<string> {
	const dockerfile = await Bun.file(`${appRoot}docker/Dockerfile`).text()
	const { version, dir } = await codexDistribution()
	const tag = `dot-runtime:${version}-${Bun.hash(dockerfile).toString(16).slice(0, 8)}`

	const exists = await Bun.$`docker image inspect ${tag}`.quiet().nothrow()
	if (exists.exitCode !== 0) {
		console.log(`[containers] building ${tag}…`)
		// Throwaway build context: Dockerfile + the codex folder (symlinks resolved).
		const context = `${runtimeDir}/build-${tag.replace(/[^a-z0-9.-]/g, "-")}`
		await Bun.write(`${context}/Dockerfile`, dockerfile, {
			createPath: true,
		})
		await Bun.$`cp -RL ${dir} ${context}/codex`.quiet()
		await Bun.$`docker build --quiet --tag ${tag} ${context}`.quiet()
		await Bun.$`rm -r ${context}`.quiet()
		console.log(`[containers] built ${tag}`)
	}
	return tag
}

export async function prepareDocker(config: BotConfig): Promise<{
	tag: string
	proxy: ModelProxy
}> {
	const tag = await ensureImage()

	// Copied, not linked: the mount can't follow a symlink out of runtimeDir. Cleared first so
	// renamed or removed commands don't linger.
	await Bun.$`rm -rf ${runtimeDir}/bin`.quiet()
	for await (const name of new Bun.Glob("*").scan({
		cwd: TOOLS_DIR,
		onlyFiles: true,
	})) {
		await Bun.write(
			`${runtimeDir}/bin/${name}`,
			Bun.file(`${TOOLS_DIR}/${name}`),
			{ createPath: true },
		)
		await Bun.$`chmod 755 ${runtimeDir}/bin/${name}`.quiet()
	}
	// Bun-based tools run inside the same Linux container as Codex. Keep the executable in
	// the shared read-only runtime mount, so adding a helper doesn't rebuild every user's image.
	await Bun.write(`${runtimeDir}/bin/bun`, Bun.file(Bun.argv[0]!))
	await Bun.$`chmod 755 ${runtimeDir}/bin/bun`.quiet()

	await writeModelCatalog(hostModelCatalog)
	const proxy = await startModelProxy()
	// Bind-mounted into every container. Each run also passes its own proxy address (see codex.ts),
	// so another bot process rewriting this file can't point a run at the wrong proxy.
	await writePrivate(
		hostConfigToml,
		codexConfig({
			baseUrl: proxy.baseUrl,
			envKey: "DOT_PROXY_KEY",
			modelCatalog: "/opt/dot/runtime/models.json",
			desktop: config.desktop
				? `${CONTAINER_TOOLS_DIR}/desktop`
				: undefined,
		}),
	)
	imageTag = tag
	return { tag, proxy }
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

/** First name for a Slack user ID, set at startup (index.ts); only used to make names readable. */
let firstNameOf: (userId: string) => Promise<string> = async () => ""
export function nameContainersWith(
	lookup: (userId: string) => Promise<string>,
) {
	firstNameOf = lookup
}

/** `dot-<first name>-<team>-<user>`, e.g. dot-alex-t0123abcd-u0456efgh; the IDs keep it unique. */
export const containerName = (
	teamId: string,
	userId: string,
	firstName = "",
) => {
	const name = slug(firstName.normalize("NFKD")).slice(0, 20)
	return ["dot", name, slug(teamId), slug(userId)].filter(Boolean).join("-")
}

const pending = new Map<string, Promise<string>>()

/** Returns the running container for this Slack user, creating or restarting it as needed. */
export function ensureContainer(
	config: BotConfig,
	teamId: string,
	userId: string,
): Promise<string> {
	const key = `${teamId}/${userId}`
	const inflight = pending.get(key)
	if (inflight) return inflight

	const isolated = config.isolateNetwork
	const task = (async () => {
		if (!imageTag)
			throw new Error("prepareDocker() must run before ensureContainer()")
		const name = containerName(
			teamId,
			userId,
			await firstNameOf(userId).catch(() => ""),
		)
		// Found by its labels, so a container from before names had first names (or from before a
		// rename in Slack) is renamed in place rather than recreated.
		const existing = (
			await Bun.$`docker ps --all --filter label=dot.bot=1 --filter ${`label=dot.team=${teamId}`} --filter ${`label=dot.user=${userId}`} --format ${"{{.Names}}"}`.text()
		)
			.trim()
			.split("\n")[0]
		if (existing && existing !== name) {
			await Bun.$`docker rename ${existing} ${name}`.quiet()
			console.log(`[containers] renamed ${existing} to ${name}`)
		}
		const options = [
			"--init", // PID 1 reaps finished child processes
			"--hostname",
			"dot",
			"--label",
			"dot.bot=1",
			"--label",
			`dot.team=${teamId}`,
			"--label",
			`dot.user=${userId}`,
			// Groups them as one "dot" app in Docker Desktop and editor container views.
			"--label",
			"com.docker.compose.project=dot",
			// Part of the spec, so turning isolation off recreates the container without the rules.
			"--label",
			`dot.isolated=${isolated ? 1 : 0}`,
			"--restart",
			"unless-stopped",
			"--memory",
			config.desktop ? "3g" : "2g",
			// Chromium on the desktop needs more shared memory than Docker's 64 MB default.
			...(config.desktop ? ["--shm-size", "1g"] : []),
			"--cpus",
			"2",
			"--pids-limit",
			"512",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			// Always networked: Codex reaches the model through the proxy on the bridge gateway. With
			// ISOLATE_NETWORK on, it's then limited to the internet (see isolate()).
			"--volume",
			`dot-home-${slug(teamId)}-${slug(userId)}:${CONTAINER_HOME}`,
			// Directories, not files: a file bind mount keeps the old inode when an editor replaces the
			// file. scripts/codex-docker.sh links these into CODEX_HOME before every run.
			"--volume",
			`${config.workdir}:/opt/dot/persona:ro`,
			"--volume",
			`${runtimeDir}:/opt/dot/runtime:ro`,
			imageTag,
		]
		// Fingerprint of image + options; a container created from different ones gets recreated.
		const spec = Bun.hash(options.join("\n")).toString(16)

		const format = '{{.State.Running}} {{index .Config.Labels "dot.spec"}}'
		const inspect = await Bun.$`docker inspect --format ${format} ${name}`
			.quiet()
			.nothrow()
		const [running, currentSpec] = inspect.stdout
			.toString()
			.trim()
			.split(" ")
		if (inspect.exitCode === 0 && currentSpec === spec) {
			if (running !== "true") await Bun.$`docker start ${name}`.quiet()
		} else {
			// Missing, or created from an older image/options: (re)create it. The volume keeps the user's files.
			if (inspect.exitCode === 0)
				await Bun.$`docker rm --force ${name}`.quiet()
			await Bun.$`docker run --detach --name ${name} --label ${`dot.spec=${spec}`} ${options}`.quiet()
			console.log(`[containers] started ${name} for ${userId}`)
		}
		if (isolated) await isolate(name)
		await ensureWorkdir(name)
		return name
	})()

	pending.set(key, task)
	task.finally(() => pending.delete(key)).catch(() => {})
	return task
}

/**
 * If ~/workspace goes missing from the volume (dot deleted it), Docker recreates the image's
 * WORKDIR as root on the next start, and dot can't write there. The container has no
 * capabilities, so a short-lived root helper hands it back.
 */
async function ensureWorkdir(name: string): Promise<void> {
	const owner = await Bun.$`docker exec ${name} stat -c %U ${CONTAINER_WORKDIR}`
		.quiet()
		.nothrow()
	if (owner.exitCode === 0 && owner.stdout.toString().trim() === "dot") return
	await Bun.$`docker run --rm --volumes-from ${name} --user root --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --network none --entrypoint sh ${imageTag!} -c ${`mkdir -p ${CONTAINER_WORKDIR} && chown dot:dot ${CONTAINER_WORKDIR}`}`.quiet()
	console.log(`[containers] ${name}: gave ${CONTAINER_WORKDIR} back to dot`)
}

/** Addresses that aren't the public internet: this machine, the home network, other containers. */
const PRIVATE_RANGES = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"224.0.0.0/4",
	"240.0.0.0/4",
].join(",")

/** Container → the start time its rules were applied at; a restart (or reboot) clears them. */
const isolatedAt = new Map<string, string>()

/**
 * Internet only: blocks this machine's services (databases, SSH…), the home network and other
 * containers, except dot's model proxy and bot API, replies to the desktop viewer gateway, and
 * DNS to the container's nameservers.
 * The rules live in the container's own network namespace and are set from a short-lived root
 * helper with NET_ADMIN; the container itself has no capabilities, so it can't change them.
 * They're lost when the container restarts, so they're checked before every use.
 */
async function isolate(name: string): Promise<void> {
	const started = (
		await Bun.$`docker inspect --format ${"{{.State.StartedAt}}"} ${name}`.text()
	).trim()
	if (isolatedAt.get(name) === started) return

	const proxy = new URL((await startModelProxy()).baseUrl)
	const api = botApiUrl()
	const ports = [proxy.port, api && new URL(api).port].filter(Boolean)
	const nameservers = (
		await Bun.$`docker exec ${name} cat /etc/resolv.conf`.text()
	)
		.split("\n")
		.map(line => line.match(/^nameserver\s+(\d+\.\d+\.\d+\.\d+)/)?.[1])
		.filter(Boolean)
	const rules = [
		"*filter",
		":OUTPUT ACCEPT [0:0]",
		"-A OUTPUT -o lo -j ACCEPT",
		`-A OUTPUT -d ${proxy.hostname} -p tcp -m multiport --dports ${ports.join(",")} -j ACCEPT`,
		// Replies from the desktop's web viewer to the bot's gateway (see agent/desktop.ts).
		`-A OUTPUT -d ${proxy.hostname} -p tcp --sport ${DESKTOP_VIEWER_PORT} -j ACCEPT`,
		...nameservers.flatMap(server => [
			`-A OUTPUT -d ${server} -p udp --dport 53 -j ACCEPT`,
			`-A OUTPUT -d ${server} -p tcp --dport 53 -j ACCEPT`,
		]),
		`-A OUTPUT -d ${PRIVATE_RANGES} -j REJECT`,
		"COMMIT",
		"",
	].join("\n")
	await Bun.$`docker run --rm -i --network ${`container:${name}`} --user root --cap-drop ALL --cap-add NET_ADMIN --entrypoint iptables-restore ${imageTag!} < ${new Blob([rules])}`.quiet()
	isolatedAt.set(name, started)
	console.log(`[containers] ${name}: internet only`)
}

/** Writes a file into the container as its user, creating parent directories. */
export async function writeIntoContainer(
	container: string,
	path: string,
	data: Uint8Array,
): Promise<void> {
	await Bun.$`docker exec -i ${container} sh -c ${'mkdir -p "$(dirname "$1")" && cat > "$1"'} sh ${path} < ${data}`.quiet()
}

export async function makeDirInContainer(
	container: string,
	path: string,
): Promise<void> {
	await Bun.$`docker exec ${container} mkdir -p ${path}`.quiet()
}

/** The regular files directly inside a container directory, each read on demand. */
export async function listContainerDir(container: string, dir: string) {
	const listing =
		await Bun.$`docker exec ${container} find ${dir} -maxdepth 1 -type f -printf ${"%s %f\\n"}`
			.quiet()
			.nothrow()
			.text()
	return listing
		.split("\n")
		.filter(Boolean)
		.map(line => {
			const space = line.indexOf(" ")
			const name = line.slice(space + 1)
			const read = async () =>
				new Uint8Array(
					await Bun.$`docker exec ${container} cat ${`${dir}/${name}`}`
						.quiet()
						.arrayBuffer(),
				)
			return { name, size: Number(line.slice(0, space)), read }
		})
}

/** Ends one Codex run inside a container (Stop): the wrapper names it codex[turn=<id>]. */
export async function stopRun(
	container: string,
	turnId: string,
): Promise<void> {
	await Bun.$`docker exec ${container} pkill -f ${`^codex\\[turn=${turnId}\\]`}`
		.quiet()
		.nothrow()
}

/**
 * Stops Codex runs left in this workspace's containers by a previous bot process. Killing the bot
 * only ends `docker exec` on the host; the run inside keeps going and holds its thread's lock
 * ("already has an active writer"). Call at startup, before this process starts any turn.
 */
export async function stopOrphanedRuns(teamId: string): Promise<void> {
	const listing =
		await Bun.$`docker ps --filter label=dot.bot=1 --filter ${`label=dot.team=${teamId}`} --format ${"{{.Names}}"}`.text()
	for (const name of listing.split("\n").filter(Boolean)) {
		const killed =
			await Bun.$`docker exec ${name} pkill -f ${"^codex(\\[turn=[^]]*\\])? (exec|app-server)"}`
				.quiet()
				.nothrow()
		if (killed.exitCode === 0)
			console.warn(`[containers] stopped orphaned Codex run in ${name}`)
	}
}
