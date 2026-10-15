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

const appRoot = Bun.fileURLToPath(new URL("../../", import.meta.url))
const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"))

/** Paths inside the container. */
export const CONTAINER_HOME = "/home/dot"
export const CONTAINER_WORKDIR = `${CONTAINER_HOME}/workspace`

/** Commands for Codex (`memory`, `recall`) in runtime/; the host runtime uses them in place. */
export const TOOLS_DIR = `${appRoot}runtime`
/** The same commands in the runtime mount; scripts/codex-docker.sh puts them on PATH. */
export const CONTAINER_TOOLS_DIR = "/opt/dot/runtime/bin"

/** Stand-in `codex` executable that forwards into the container named by $DOT_CONTAINER. */
export const CODEX_DOCKER_WRAPPER = `${appRoot}scripts/codex-docker.sh`

const runtimeDir = `${paths.dataDir}/runtime`
const hostConfigToml = `${runtimeDir}/config.toml`

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

export async function prepareDocker(): Promise<{
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

	const proxy = await startModelProxy()
	// Bind-mounted into every container; rewritten in place, so running containers see the new port.
	await writePrivate(
		hostConfigToml,
		codexConfig({ baseUrl: proxy.baseUrl, envKey: "DOT_PROXY_KEY" }),
	)
	imageTag = tag
	return { tag, proxy }
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
export const containerName = (teamId: string, userId: string) =>
	`dot-${slug(teamId)}-${slug(userId)}`

const pending = new Map<string, Promise<string>>()

/** Returns the running container for this Slack user, creating or restarting it as needed. */
export function ensureContainer(
	config: BotConfig,
	teamId: string,
	userId: string,
): Promise<string> {
	const name = containerName(teamId, userId)
	const inflight = pending.get(name)
	if (inflight) return inflight

	const task = (async () => {
		if (!imageTag)
			throw new Error("prepareDocker() must run before ensureContainer()")
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
			"--restart",
			"unless-stopped",
			"--memory",
			"2g",
			"--cpus",
			"2",
			"--pids-limit",
			"512",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			// Always networked: Codex reaches the model through the proxy on the bridge gateway.
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
			return name
		}
		// Missing, or created from an older image/options: (re)create it. The volume keeps the user's files.
		if (inspect.exitCode === 0)
			await Bun.$`docker rm --force ${name}`.quiet()

		await Bun.$`docker run --detach --name ${name} --label ${`dot.spec=${spec}`} ${options}`.quiet()
		console.log(`[containers] started ${name} for ${userId}`)
		return name
	})()

	pending.set(name, task)
	task.finally(() => pending.delete(name)).catch(() => {})
	return task
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
			await Bun.$`docker exec ${name} pkill -f ${"^codex(\\[turn=[^]]*\\])? exec"}`
				.quiet()
				.nothrow()
		if (killed.exitCode === 0)
			console.warn(`[containers] stopped orphaned Codex run in ${name}`)
	}
}
