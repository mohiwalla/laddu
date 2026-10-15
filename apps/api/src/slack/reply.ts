/**
 * The bot's reply while a turn runs. Uses Slack's streaming messages: each step is a native task card
 * (spinner, then done or failed) with its command tucked into the card's details, and the answer
 * lands in the same message. Falls back to editing a plain placeholder if streaming is unavailable.
 */
import type { App } from "@slack/bolt";
import type { Step } from "../agent/steps";

type WebClient = App["client"];
type Chunk = NonNullable<Parameters<WebClient["chat"]["appendStream"]>[0]["chunks"]>[number];
type TaskChunk = Extract<Chunk, { type: "task_update" }>;

export type ReplyTarget = { channel: string; threadTs: string; userId: string; teamId: string };

export type Reply = {
  step(step: Step): void;
  /** Posts the answer; an empty answer (files only) just closes the progress. */
  finish(text: string): Promise<void>;
  fail(message: string): Promise<void>;
};

/** Slack's limit for `markdown_text`. */
const MAX_MARKDOWN = 12_000;
/** Slack's limit for task and plan chunk fields. */
const MAX_TASK_TEXT = 256;
const STREAM_FLUSH_MS = 800;
const PLACEHOLDER_INTERVAL_MS = 2_500;

/** Split on paragraph, then line, boundaries so each part fits in one Slack message. */
export function chunkMarkdown(text: string, max = MAX_MARKDOWN - 500): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, "");
  }
  chunks.push(rest);
  return chunks;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function taskChunk(step: Step): TaskChunk {
  const chunk: TaskChunk = { type: "task_update", id: step.id, title: clip(step.title, MAX_TASK_TEXT), status: step.status };
  // Code fence around the command; clipped inside so the fence always closes.
  if (step.details) chunk.details = `\`\`\`\n${clip(step.details, MAX_TASK_TEXT - 8)}\n\`\`\``;
  return chunk;
}

export async function openReply(client: WebClient, target: ReplyTarget): Promise<Reply> {
  try {
    return await openStream(client, target);
  } catch (error) {
    const reason = (error as { data?: { error?: string } })?.data?.error ?? error;
    console.warn("[reply] streaming unavailable, using a placeholder:", reason);
    return openPlaceholder(client, target);
  }
}

async function openStream(client: WebClient, target: ReplyTarget): Promise<Reply> {
  const started = Date.now();
  const { channel } = target;
  // Shown until Codex's first step, so there's a spinner from the start.
  const opening: Step = { id: "opening", title: "Reading the conversation", status: "in_progress" };
  const { ts } = await client.chat.startStream({
    channel,
    thread_ts: target.threadTs,
    recipient_user_id: target.userId,
    recipient_team_id: target.teamId,
    task_display_mode: "plan",
    chunks: [{ type: "plan_update", title: "Working on it" }, taskChunk(opening)],
  });
  if (!ts) throw new Error("chat.startStream returned no ts");

  // Latest state per step, sent in batches. Slack updates a task in place by id but appends its
  // details on every update, so they're sent once.
  const steps = new Map<string, Step>([[opening.id, opening]]);
  const detailed = new Set<string>();
  const toChunks = (batch: Map<string, Step>) =>
    [...batch.values()].map((step) => {
      const chunk = taskChunk(detailed.has(step.id) ? { ...step, details: undefined } : step);
      if (step.details) detailed.add(step.id);
      return chunk;
    });
  let pending = new Map<string, Step>();
  let timer: Timer | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const chunks = toChunks(pending);
    pending = new Map();
    chain = chain.then(() => client.chat.appendStream({ channel, ts, chunks })).catch((error) => console.warn("[reply] append failed:", error));
  };
  const update = (step: Step) => {
    steps.set(step.id, step);
    pending.set(step.id, step);
    timer ??= setTimeout(flush, STREAM_FLUSH_MS);
  };
  /** Settles every step still running and waits for queued updates. */
  const settle = async (status: Step["status"]) => {
    clearTimeout(timer);
    timer = undefined;
    await chain;
    for (const step of steps.values()) if (step.status === "in_progress") pending.set(step.id, { ...step, status });
    const chunks = toChunks(pending);
    pending = new Map();
    return chunks;
  };
  const elapsed = () => `${Math.max(1, Math.round((Date.now() - started) / 1000))}s`;

  return {
    step(step) {
      if (steps.get(opening.id)?.status === "in_progress") update({ ...opening, status: "complete" });
      update(step);
    },
    async finish(text) {
      const tasks = await settle("complete");
      const [first, ...rest] = text ? chunkMarkdown(text) : [];
      const done: Chunk[] = [...tasks, { type: "plan_update", title: `Done in ${elapsed()}` }];
      try {
        await client.chat.stopStream({ channel, ts, chunks: first ? [...done, { type: "markdown_text", text: first }] : done });
      } catch (error) {
        // Some Markdown (e.g. tables) may not stream: close the progress, post the answer on its own.
        console.warn("[reply] answer didn't fit the stream, posting separately:", error);
        await client.chat.stopStream({ channel, ts, chunks: done }).catch(() => {});
        if (first) rest.unshift(first);
      }
      for (const part of rest) await client.chat.postMessage({ channel, thread_ts: target.threadTs, markdown_text: part });
    },
    async fail(message) {
      const tasks = await settle("error");
      await client.chat.stopStream({
        channel,
        ts,
        chunks: [...tasks, { type: "plan_update", title: "Something went wrong" }, { type: "markdown_text", text: `:warning: ${message}` }],
      });
    },
  };
}

/** Pre-streaming behaviour: one message reading "Working on it…", edited with the latest step. */
async function openPlaceholder(client: WebClient, target: ReplyTarget): Promise<Reply> {
  const { channel, threadTs } = target;
  const working = "_Working on it…_";
  const placeholder = await client.chat.postMessage({ channel, thread_ts: threadTs, markdown_text: working });
  const ts = placeholder.ts!;

  let latest: string | null = null;
  let lastSent = 0;
  let timer: Timer | undefined;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const flush = () => {
    timer = undefined;
    if (closed || latest === null) return;
    const status = latest;
    latest = null;
    lastSent = Date.now();
    chain = chain.then(() => client.chat.update({ channel, ts, markdown_text: `${working}\n\n${status}` })).catch(() => {});
  };
  /** Stops updates and waits for any in-flight edit, so it can't overwrite the final message. */
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    await chain;
  };

  return {
    step(step) {
      latest = step.title;
      timer ??= setTimeout(flush, Math.max(0, lastSent + PLACEHOLDER_INTERVAL_MS - Date.now()));
    },
    async finish(text) {
      await close();
      if (!text) {
        await client.chat.delete({ channel, ts }).catch(() => {});
        return;
      }
      const [first, ...rest] = chunkMarkdown(text);
      await client.chat.update({ channel, ts, markdown_text: first! }).catch(async (error) => {
        // Slack won't edit a message into different block types (e.g. a Markdown table): post it fresh.
        if (error?.data?.error !== "block_mismatch") throw error;
        await client.chat.postMessage({ channel, thread_ts: threadTs, markdown_text: first! });
        await client.chat.delete({ channel, ts }).catch(() => {});
      });
      for (const part of rest) await client.chat.postMessage({ channel, thread_ts: threadTs, markdown_text: part });
    },
    async fail(message) {
      await close();
      await client.chat.update({ channel, ts, markdown_text: `:warning: ${message}` });
    },
  };
}
