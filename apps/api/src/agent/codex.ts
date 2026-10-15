/**
 * Runs Codex turns billed to the owner's ChatGPT plan via Sign in with ChatGPT.
 *
 * Each turn spawns `codex exec` (through the SDK) with a freshly refreshed access token,
 * so token renewal needs no long-lived process. Provider setup follows
 * https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
 *
 * Docker runtime (default): the SDK spawns scripts/codex-docker.sh instead of codex, which
 * runs codex inside the requesting user's container. Host runtime: codex runs here.
 */
import { Codex, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";
import type { BotConfig } from "../config";
import { paths } from "../config";
import { getAccessToken } from "../auth/siwc";
import { writePrivate } from "../files";
import { codexConfig } from "./codex-config";
import { CODEX_DOCKER_WRAPPER, CONTAINER_WORKDIR, ensureContainer } from "./containers";
import { startModelProxy } from "./model-proxy";

/** Host runtime: writes the bot's own CODEX_HOME/config.toml. */
export async function prepareCodexHome(): Promise<void> {
  await writePrivate(`${paths.codexHome}/config.toml`, codexConfig());
}

/** Env for the Codex child (or the docker wrapper): this process's env minus Slack secrets. */
function codexEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !key.startsWith("SLACK_")) env[key] = value;
  }
  return { ...env, ...extra };
}

/** The Slack user a turn runs for; picks their container in the Docker runtime. */
export type TurnUser = { teamId: string; userId: string };

async function createCodex(config: BotConfig, user: TurnUser) {
  const base: ThreadOptions = {
    model: config.model,
    modelReasoningEffort: config.reasoningEffort,
    skipGitRepoCheck: true,
    // Nobody is around to approve commands mid-turn.
    approvalPolicy: "never",
  };

  if (config.runtime === "host") {
    const env = codexEnv({ CODEX_HOME: paths.codexHome, ACCESS_TOKEN: await getAccessToken() });
    return {
      codex: new Codex({ env }),
      threadOptions: { ...base, sandboxMode: config.sandbox, networkAccessEnabled: config.network, workingDirectory: config.workdir },
    };
  }

  const [container, proxy] = await Promise.all([ensureContainer(config, user.teamId, user.userId), startModelProxy()]);
  return {
    codex: new Codex({ codexPathOverride: CODEX_DOCKER_WRAPPER, env: codexEnv({ DOT_CONTAINER: container, DOT_PROXY_KEY: proxy.key }) }),
    // The container is the boundary (network is set on the container), so no nested sandbox.
    threadOptions: { ...base, sandboxMode: "danger-full-access" as const, workingDirectory: CONTAINER_WORKDIR },
  };
}

/** A one-line, human-readable description of what Codex is doing, for the Slack progress message. */
export function describe(item: ThreadItem): string | null {
  switch (item.type) {
    case "command_execution":
      return `Running \`${item.command.length > 80 ? `${item.command.slice(0, 77)}...` : item.command}\``;
    case "mcp_tool_call":
      return `Calling ${item.server}.${item.tool}`;
    case "web_search":
      return `Searching the web for "${item.query}"`;
    case "file_change":
      return `Editing ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`;
    case "todo_list":
      return item.items.map((todo) => `${todo.completed ? "☑" : "☐"} ${todo.text}`).join("\n");
    case "reasoning":
      return "Thinking…";
    default:
      return null;
  }
}

export type TurnResult = { threadId: string; text: string };

export async function runTurn(options: {
  config: BotConfig;
  user: TurnUser;
  threadId?: string;
  input: string;
  onProgress?: (status: string) => void;
}): Promise<TurnResult> {
  const { config, input, onProgress } = options;

  const { codex, threadOptions } = await createCodex(config, options.user);
  const thread = options.threadId
    ? codex.resumeThread(options.threadId, threadOptions)
    : codex.startThread(threadOptions);

  const { events } = await thread.runStreamed(input);
  let threadId = options.threadId ?? null;
  let text = "";
  let completed = false;
  let lastError: string | null = null;

  for await (const event of events) {
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id;
        break;
      case "item.started":
      case "item.updated": {
        const status = describe(event.item);
        if (status) onProgress?.(status);
        break;
      }
      case "item.completed":
        if (event.item.type === "agent_message") text = event.item.text;
        break;
      case "turn.completed":
        completed = true;
        break;
      case "turn.failed":
        throw new Error(event.error.message);
      case "error":
        // Also used for retry notices ("Reconnecting... 1/5"); only turn.failed is fatal.
        lastError = event.message;
        break;
    }
  }

  if (!completed) throw new Error(lastError ?? "Codex stopped before finishing the turn");
  threadId ??= thread.id;
  if (!threadId) throw new Error("Codex did not report a thread id");
  return { threadId, text: text || "_(Codex finished without a reply.)_" };
}
