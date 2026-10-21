/**
 * OpenCode (https://opencode.ai) as dot's agent, on its free models: no sign-in, no plan. It runs
 * as an ACP agent inside the person's container (scripts/opencode-docker.sh, acp.ts), with the
 * same persona, commands, skills and computer as Codex. Docker runtime only.
 *
 * Free models may log what they're sent; dot is experimental, so that's accepted for now.
 */
import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk"
import { runAcpTurn } from "./acp"
import {
	CONTAINER_TOOLS_DIR,
	CONTAINER_WORKDIR,
	OPENCODE_DOCKER_WRAPPER,
	ensureContainer,
	ensureImage,
	stopRun,
} from "./containers"
import { stepTracker } from "./steps"
import { runTool } from "./tools"
import {
	childEnv,
	collectOutbox,
	containerWorkspace,
	loadMemory,
	memoryNote,
	newTurnId,
	outboxNote,
	saveAttachments,
	turnEnv,
	type ModelOption,
	type TurnFile,
	type TurnOptions,
	type TurnResult,
} from "./turn"

/** OpenCode's own config for dot's runs; the container is the boundary, so everything is allowed. */
const CONFIG = JSON.stringify({
	$schema: "https://opencode.ai/config.json",
	permission: { "*": "allow" },
	share: "disabled",
	autoupdate: false,
	// Its undo history: a git snapshot of the workspace after every step, which nobody uses here.
	snapshot: false,
})

let catalog: { models: Promise<ModelOption[]>; at: number } | null = null
const CATALOG_MS = 6 * 3600_000

/**
 * OpenCode's free models (what it offers without signing in), from the OpenCode in the runtime
 * image, cached for a few hours. Empty if they can't be read.
 */
export function listOpenCodeModels(): Promise<ModelOption[]> {
	if (catalog && Date.now() - catalog.at < CATALOG_MS) return catalog.models
	const models = (async () => {
		const image = await ensureImage()
		const listing =
			await Bun.$`docker run --rm --env OPENCODE_DISABLE_AUTOUPDATE=1 --entrypoint opencode ${image} models opencode --verbose`
				.quiet()
				.text()
		// Each model is its "provider/id" line, then its details as JSON.
		return listing
			.split(/^opencode\/\S+$/m)
			.slice(1)
			.map(block => JSON.parse(block) as OpenCodeModel)
			.filter(
				model =>
					model.status !== "deprecated" &&
					model.cost?.input === 0 &&
					model.cost?.output === 0,
			)
			.map(model => ({
				id: `opencode/${model.id}`,
				name: model.name,
				description: `Free${model.limit?.context ? ` · ${Math.round(model.limit.context / 1000)}k context` : ""}${model.capabilities?.input?.image ? " · sees images" : ""}`,
				efforts: [],
				defaultEffort: "",
				fast: false,
				images: model.capabilities?.input?.image === true,
			}))
	})().catch(error => {
		console.warn("[opencode] couldn't list models:", error)
		catalog = null
		return []
	})
	catalog = { models, at: Date.now() }
	return models
}

type OpenCodeModel = {
	id: string
	name: string
	status?: string
	cost?: { input?: number; output?: number }
	limit?: { context?: number }
	capabilities?: { input?: { image?: boolean } }
}

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
}

export async function runOpenCodeTurn(
	options: TurnOptions,
): Promise<TurnResult> {
	options.signal?.throwIfAborted()
	const { config, user } = options
	if (config.runtime !== "docker")
		throw new Error("OpenCode runs only in the Docker runtime.")
	const track = stepTracker(step => options.onStep?.(step))
	const turnId = newTurnId()
	const [container, models] = await Promise.all([
		ensureContainer(config, user.teamId, user.userId),
		listOpenCodeModels(),
	])
	const { outbox, saveFile, listOutbox } = await containerWorkspace(
		container,
		turnId,
	)
	options.signal?.throwIfAborted()
	const seesImages =
		models.find(model => model.id === config.model)?.images ?? false

	// Images go in as data when the model takes them; every file is also saved in the workspace.
	const attach = async (files: TurnFile[]) => {
		const { note, images } = await saveAttachments(
			files,
			saveFile,
			seesImages,
		)
		return {
			note,
			images: images.flatMap(({ file }): ContentBlock[] => {
				const mimeType =
					IMAGE_TYPES[
						file.fileName.split(".").pop()?.toLowerCase() ?? ""
					]
				return mimeType
					? [
							{
								type: "image",
								mimeType,
								data: file.data.toBase64(),
							},
						]
					: []
			}),
		}
	}
	const text = (value: string): ContentBlock => ({
		type: "text",
		text: value,
	})

	// Loaded once per conversation, like a system prompt; resumed ones already have it.
	const memory = options.threadId
		? null
		: await loadMemory(() => runTool(config, user, ["memory", "show"]))
	const { note, images } = await attach(options.files ?? [])
	const mcpServers: McpServer[] = config.desktop
		? [
				{
					name: "desktop",
					command: `${CONTAINER_TOOLS_DIR}/desktop`,
					args: ["mcp"],
					env: [],
				},
			]
		: []
	const result = await runAcpTurn(
		{
			command: [OPENCODE_DOCKER_WRAPPER],
			env: childEnv({
				DOT_CONTAINER: container,
				OPENCODE_CONFIG_CONTENT: CONFIG,
				...turnEnv(turnId, user, options.slack),
			}),
			cwd: CONTAINER_WORKDIR,
			mcpServers,
			model: config.model,
			stop: () => stopRun(container, turnId),
		},
		{
			sessionId: options.threadId,
			prompt: [
				text(
					[
						memoryNote(memory),
						options.input,
						note,
						outboxNote(outbox),
					]
						.filter(Boolean)
						.join("\n\n"),
				),
				...images,
			],
			signal: options.signal,
			onItem: track,
			onSteerable: steer =>
				options.onSteerable?.(
					steer &&
						(async (more, files = []) => {
							const { note, images } = await attach(files)
							return steer([
								text([more, note].filter(Boolean).join("\n\n")),
								...images,
							])
						}),
				),
		},
	)
	const { files, skipped } = await collectOutbox(await listOutbox())
	return {
		threadId: result.sessionId,
		text:
			result.text ||
			(files.length ? "" : "_(OpenCode finished without a reply.)_"),
		files,
		skipped,
	}
}
