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
import { Codex, type ThreadOptions, type UserInput } from "@openai/codex-sdk";
import type { BotConfig } from "../config";
import { paths } from "../config";
import { getAccessToken } from "../auth/siwc";
import { writePrivate } from "../files";
import { codexConfig } from "./codex-config";
import {
  CODEX_DOCKER_WRAPPER,
  CONTAINER_WORKDIR,
  ensureContainer,
  listContainerDir,
  makeDirInContainer,
  writeIntoContainer,
} from "./containers";
import { startModelProxy } from "./model-proxy";
import { stepTracker, type Step } from "./steps";

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

/** A file attached in Slack; images are also shown to the model. */
export type TurnFile = { fileName: string; title: string; data: Uint8Array; image: boolean };

/** A file Codex left in the turn's outbox, to upload to Slack. */
export type OutFile = { name: string; data: Uint8Array };

/** What a turn's outbox holds, read lazily. */
type OutboxEntry = { name: string; size: number; read: () => Promise<Uint8Array> };

const MAX_OUT_FILES = 10;
const MAX_OUT_BYTES = 50 * 1024 * 1024;

/** Attachments are saved under `slack-files/`, the turn's outbox is `slack-outbox/<turn>/`. */
async function createCodex(config: BotConfig, user: TurnUser) {
  const base: ThreadOptions = {
    model: config.model,
    modelReasoningEffort: config.reasoningEffort,
    skipGitRepoCheck: true,
    // Nobody is around to approve commands mid-turn.
    approvalPolicy: "never",
  };
  const turnId = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-") + `-${crypto.randomUUID().slice(0, 4)}`;

  if (config.runtime === "host") {
    const env = codexEnv({ CODEX_HOME: paths.codexHome, ACCESS_TOKEN: await getAccessToken() });
    // Outside the workdir, which is the persona folder.
    const owner = `${user.teamId}-${user.userId}`;
    const outbox = `${paths.dataDir}/slack-outbox/${owner}/${turnId}`;
    await Bun.$`mkdir -p ${outbox}`.quiet();
    return {
      codex: new Codex({ env }),
      threadOptions: {
        ...base,
        sandboxMode: config.sandbox,
        networkAccessEnabled: config.network,
        workingDirectory: config.workdir,
        additionalDirectories: [outbox],
      },
      saveFile: async (file: TurnFile) => {
        const path = `${paths.dataDir}/slack-files/${owner}/${file.fileName}`;
        await Bun.write(path, file.data, { createPath: true });
        return path;
      },
      outbox,
      listOutbox: async (): Promise<OutboxEntry[]> => {
        const names = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: outbox, onlyFiles: true }));
        return names.map((name) => {
          const file = Bun.file(`${outbox}/${name}`);
          return { name, size: file.size, read: () => file.bytes() };
        });
      },
    };
  }

  const [container, proxy] = await Promise.all([ensureContainer(config, user.teamId, user.userId), startModelProxy()]);
  // In the user's workspace, so they can come back to these files later.
  const outbox = `${CONTAINER_WORKDIR}/slack-outbox/${turnId}`;
  await makeDirInContainer(container, outbox);
  return {
    codex: new Codex({ codexPathOverride: CODEX_DOCKER_WRAPPER, env: codexEnv({ DOT_CONTAINER: container, DOT_PROXY_KEY: proxy.key }) }),
    // The container is the boundary (network is set on the container), so no nested sandbox.
    threadOptions: { ...base, sandboxMode: "danger-full-access" as const, workingDirectory: CONTAINER_WORKDIR },
    saveFile: async (file: TurnFile) => {
      const path = `${CONTAINER_WORKDIR}/slack-files/${file.fileName}`;
      await writeIntoContainer(container, path, file.data);
      return path;
    },
    outbox,
    listOutbox: () => listContainerDir(container, outbox),
  };
}

/** The outbox's files to upload, and the names of ones skipped for count or size. */
async function collectOutbox(entries: OutboxEntry[]): Promise<{ files: OutFile[]; skipped: string[] }> {
  const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name));
  const kept = sorted.filter((entry) => entry.size > 0 && entry.size <= MAX_OUT_BYTES).slice(0, MAX_OUT_FILES);
  const files = await Promise.all(kept.map(async (entry) => ({ name: entry.name, data: await entry.read() })));
  return { files, skipped: sorted.filter((entry) => !kept.includes(entry)).map((entry) => entry.name) };
}

export type TurnResult = { threadId: string; text: string; files: OutFile[]; skipped: string[] };

export async function runTurn(options: {
  config: BotConfig;
  user: TurnUser;
  threadId?: string;
  input: string;
  files?: TurnFile[];
  onStep?: (step: Step) => void;
}): Promise<TurnResult> {
  const { config, input } = options;
  const track = stepTracker((step) => options.onStep?.(step));

  const { codex, threadOptions, saveFile, outbox, listOutbox } = await createCodex(config, options.user);
  // The CLI reads image paths itself, so files must exist where it runs (inside the container).
  const attached = await Promise.all((options.files ?? []).map(async (file) => ({ file, path: await saveFile(file) })));
  const images = attached.filter(({ file }) => file.image);
  const notes = [
    attached.length &&
      `Files attached in these messages, saved for you${images.length ? " (images are also shown below, in order)" : ""}:\n` +
        attached.map(({ file, path }) => `- ${file.title}: ${path}`).join("\n"),
    `To send files to Slack (CSV, images, documents, code…), save them directly in ${outbox}/. They're uploaded to this thread right after your reply, so refer to them by name, not path.`,
  ].filter(Boolean);
  const turnInput: UserInput[] = [
    { type: "text", text: [input, ...notes].join("\n\n") },
    ...images.map(({ path }) => ({ type: "local_image" as const, path })),
  ];
  const thread = options.threadId
    ? codex.resumeThread(options.threadId, threadOptions)
    : codex.startThread(threadOptions);

  const { events } = await thread.runStreamed(turnInput);
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
      case "item.updated":
      case "item.completed":
        // The last message is the answer; earlier ones are notes before actions (see steps.ts).
        if (event.type === "item.completed" && event.item.type === "agent_message") text = event.item.text;
        track(event.item, event.type === "item.completed");
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
  const { files, skipped } = await collectOutbox(await listOutbox());
  return { threadId, text: text || (files.length ? "" : "_(Codex finished without a reply.)_"), files, skipped };
}
