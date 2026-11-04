/**
 * Runs laddu's own commands (runtime/: `memory`, `recall`, `skills`) for a user, inside their
 * container, where their agent runs.
 */
import type { BotConfig } from "../config"
import type { TurnUser } from "./turn"
import { CONTAINER_TOOLS_DIR, ensureContainer } from "./containers"

export async function runTool(
	config: BotConfig,
	user: TurnUser,
	args: [string, ...string[]],
	stdin?: string,
): Promise<string> {
	const [name, ...rest] = args
	const input = new TextEncoder().encode(stdin ?? "")
	const container = await ensureContainer(config, user.teamId, user.userId)
	return Bun.$`docker exec -i ${container} ${CONTAINER_TOOLS_DIR}/${name} ${rest} < ${input}`
		.quiet()
		.text()
}
