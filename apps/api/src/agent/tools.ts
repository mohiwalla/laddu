/**
 * Runs laddu's own commands (runtime/: `memory`, `recall`) for a user, where their Codex runs:
 * inside their container, or on the host against that user's data directories.
 */
import type { BotConfig } from "../config"
import { paths } from "../config"
import type { TurnUser } from "./turn"
import { CONTAINER_TOOLS_DIR, ensureContainer, TOOLS_DIR } from "./containers"

/** Host runtime: where each user's memory and history live (the commands read these env vars). */
export function hostToolEnv(user: TurnUser) {
	const owner = `${user.teamId}-${user.userId}`
	return {
		LADDU_MEMORY_DIR: `${paths.dataDir}/memory/${owner}`,
		LADDU_HISTORY_DIR: `${paths.dataDir}/history/${owner}`,
		LADDU_CODE_DIR: `${paths.dataDir}/code/${owner}`,
	}
}

export async function runTool(
	config: BotConfig,
	user: TurnUser,
	args: [string, ...string[]],
	stdin?: string,
): Promise<string> {
	const [name, ...rest] = args
	const input = new TextEncoder().encode(stdin ?? "")
	if (config.runtime === "host") {
		return Bun.$`${TOOLS_DIR}/${name} ${rest} < ${input}`
			.env({ ...Bun.env, ...hostToolEnv(user) })
			.quiet()
			.text()
	}
	const container = await ensureContainer(config, user.teamId, user.userId)
	return Bun.$`docker exec -i ${container} ${CONTAINER_TOOLS_DIR}/${name} ${rest} < ${input}`
		.quiet()
		.text()
}
