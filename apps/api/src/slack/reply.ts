/**
 * The bot's reply while a turn runs. Uses Slack's streaming messages: each step is a native task card
 * (spinner, then done or failed) with its command tucked into the card's details, and the answer
 * lands in the same message. Falls back to editing a plain placeholder if streaming is unavailable.
 */
import type { App } from "@slack/bolt";
import type { Step } from "../agent/steps";

type WebClient = App["client"];
type Chunk = NonNullable<
  Parameters<WebClient["chat"]["appendStream"]>[0]["chunks"]
>[number];
type TaskChunk = Extract<Chunk, { type: "task_update" }>;

export type ReplyTarget = {
  channel: string;
  threadTs: string;
  userId: string;
  teamId: string;
};

export type Reply = {
  /** The reply message; `streaming` when it's a Slack stream rather than a plain placeholder. */
  ts: string;
  streaming: boolean;
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
/**
 * The running clock in the progress title ticks every second, sharing Slack's budget for stream
 * updates (chat.appendStream, ~100 a minute per app) across every reply in progress: with several
 * at once, each ticks a bit slower. A tick is skipped while an update is still in flight.
 */
const CLOCK_TICK_MS = 1_000;
const CLOCK_UPDATES_PER_MINUTE = 80;
let liveStreams = 0;
const clockInterval = () => Math.max(CLOCK_TICK_MS, Math.ceil((liveStreams * 60_000) / CLOCK_UPDATES_PER_MINUTE));
const PLACEHOLDER_INTERVAL_MS = 2_500;

/** Split on paragraph, then line, boundaries so each part fits in one Slack message. */
export function chunkMarkdown(
  text: string,
  max = MAX_MARKDOWN - 500,
): string[] {
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

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function taskChunk(step: Step): TaskChunk {
  const chunk: TaskChunk = {
    type: "task_update",
    id: step.id,
    title: clip(step.title, MAX_TASK_TEXT),
    status: step.status,
  };
  // Code fence around the command; clipped inside so the fence always closes.
  if (step.details)
    chunk.details = `\`\`\`\n${clip(step.details, MAX_TASK_TEXT - 8)}\n\`\`\``;
  return chunk;
}

export async function openReply(
  client: WebClient,
  target: ReplyTarget,
): Promise<Reply> {
  try {
    return await openStream(client, target);
  } catch (error) {
    const reason =
      (error as { data?: { error?: string } })?.data?.error ?? error;
    console.warn("[reply] streaming unavailable, using a placeholder:", reason);
    return openPlaceholder(client, target);
  }
}

async function openStream(
  client: WebClient,
  target: ReplyTarget,
): Promise<Reply> {
  const started = Date.now();
  const { channel } = target;
  // Shown until Codex's first step, so there's a spinner from the start.
  const opening: Step = {
    id: "opening",
    title: "Reading the conversation",
    status: "in_progress",
  };
  const { ts } = await client.chat.startStream({
    channel,
    thread_ts: target.threadTs,
    recipient_user_id: target.userId,
    recipient_team_id: target.teamId,
    task_display_mode: "plan",
    chunks: [
      { type: "plan_update", title: "Working on it" },
      taskChunk(opening),
    ],
  });
  if (!ts) throw new Error("chat.startStream returned no ts");

  // Latest state per step, sent in batches. Slack updates a task in place by id but appends its
  // details on every update, so they're sent once.
  const steps = new Map<string, Step>([[opening.id, opening]]);
  const detailed = new Set<string>();
  const toChunks = (batch: Map<string, Step>) =>
    [...batch.values()].map((step) => {
      const chunk = taskChunk(
        detailed.has(step.id) ? { ...step, details: undefined } : step,
      );
      if (step.details) detailed.add(step.id);
      return chunk;
    });
  let pending = new Map<string, Step>();
  let timer: Timer | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let inFlight = 0;

  const elapsed = () => {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    return seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  };
  // Every update also refreshes the running clock in the title.
  const flush = () => {
    timer = undefined;
    const chunks: Chunk[] = [
      { type: "plan_update", title: `Working on it · ${elapsed()}` },
      ...toChunks(pending),
    ];
    pending = new Map();
    inFlight++;
    chain = chain
      .then(() => client.chat.appendStream({ channel, ts, chunks }))
      .catch((error) => console.warn("[reply] append failed:", error))
      .finally(() => inFlight--);
  };
  liveStreams++;
  let stopped = false;
  let clock: Timer | undefined;
  const tick = () => {
    if (stopped) return;
    if (!inFlight && !timer) flush();
    clock = setTimeout(tick, clockInterval());
  };
  clock = setTimeout(tick, clockInterval());
  const update = (step: Step) => {
    steps.set(step.id, step);
    pending.set(step.id, step);
    timer ??= setTimeout(flush, STREAM_FLUSH_MS);
  };
  /** Settles every step still running and waits for queued updates. */
  const settle = async (status: Step["status"]) => {
    if (!stopped) liveStreams--;
    stopped = true;
    clearTimeout(clock);
    clearTimeout(timer);
    timer = undefined;
    await chain;
    for (const step of steps.values())
      if (step.status === "in_progress")
        pending.set(step.id, { ...step, status });
    const chunks = toChunks(pending);
    pending = new Map();
    return chunks;
  };
  return {
    ts,
    streaming: true,
    step(step) {
      update(step);
      // Slack shows the whole plan as done once no task is in progress, which is the case between
      // steps while Codex thinks. The first row covers those gaps: it spins as "Thinking" whenever
      // no step runs, and rests while one does.
      const running = [...steps.values()].some(
        (other) => other.id !== opening.id && other.status === "in_progress",
      );
      const first = steps.get(opening.id)!;
      if (running && first.status === "in_progress")
        update({ ...first, status: "complete" });
      if (!running && first.status !== "in_progress")
        update({ ...first, title: "Thinking", status: "in_progress" });
    },
    async finish(text) {
      const tasks = await settle("complete");
      const [first, ...rest] = text ? chunkMarkdown(text) : [];
      const done: Chunk[] = [
        ...tasks,
        { type: "plan_update", title: `Done in ${elapsed()}` },
      ];
      try {
        await client.chat.stopStream({
          channel,
          ts,
          chunks: first
            ? [...done, { type: "markdown_text", text: first }]
            : done,
        });
      } catch (error) {
        // Some Markdown (e.g. tables) may not stream: close the progress, post the answer on its own.
        console.warn(
          "[reply] answer didn't fit the stream, posting separately:",
          error,
        );
        await client.chat
          .stopStream({ channel, ts, chunks: done })
          .catch(() => {});
        if (first) rest.unshift(first);
      }
      for (const part of rest)
        await client.chat.postMessage({
          channel,
          thread_ts: target.threadTs,
          markdown_text: part,
        });
    },
    async fail(message) {
      const tasks = await settle("error");
      await client.chat.stopStream({
        channel,
        ts,
        chunks: [
          ...tasks,
          { type: "plan_update", title: `Stopped after ${elapsed()}` },
          { type: "markdown_text", text: `:warning: ${message}` },
        ],
      });
    },
  };
}

/** Pre-streaming behaviour: one message reading "Working on it…", edited with the latest step. */
async function openPlaceholder(
  client: WebClient,
  target: ReplyTarget,
): Promise<Reply> {
  const { channel, threadTs } = target;
  const working = "_Working on it…_";
  const placeholder = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    markdown_text: working,
  });
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
    chain = chain
      .then(() =>
        client.chat.update({
          channel,
          ts,
          markdown_text: `${working}\n\n${status}`,
        }),
      )
      .catch(() => {});
  };
  /** Stops updates and waits for any in-flight edit, so it can't overwrite the final message. */
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    await chain;
  };

  return {
    ts,
    streaming: false,
    step(step) {
      latest = step.title;
      timer ??= setTimeout(
        flush,
        Math.max(0, lastSent + PLACEHOLDER_INTERVAL_MS - Date.now()),
      );
    },
    async finish(text) {
      await close();
      if (!text) {
        await client.chat.delete({ channel, ts }).catch(() => {});
        return;
      }
      const [first, ...rest] = chunkMarkdown(text);
      await client.chat
        .update({ channel, ts, markdown_text: first! })
        .catch(async (error) => {
          // Slack won't edit a message into different block types (e.g. a Markdown table): post it fresh.
          if (error?.data?.error !== "block_mismatch") throw error;
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            markdown_text: first!,
          });
          await client.chat.delete({ channel, ts }).catch(() => {});
        });
      for (const part of rest)
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          markdown_text: part,
        });
    },
    async fail(message) {
      await close();
      await client.chat.update({
        channel,
        ts,
        markdown_text: `:warning: ${message}`,
      });
    },
  };
}

/** Closes a reply left open by a previous bot process (it was restarted mid-turn). */
export async function closeInterrupted(
  client: WebClient,
  target: { channel: string; threadTs: string },
  reply: { ts: string; streaming: boolean },
  note: string,
) {
  const { channel } = target;
  if (!reply.streaming) {
    await client.chat.update({ channel, ts: reply.ts, markdown_text: note });
    return;
  }
  // This process never saw the steps; read the ones still spinning off the message itself.
  const page = await client.conversations
    .replies({
      channel,
      ts: target.threadTs,
      oldest: reply.ts,
      latest: reply.ts,
      inclusive: true,
      limit: 1,
    })
    .catch(() => null);
  const message = page?.messages?.find(
    (candidate) => candidate.ts === reply.ts,
  );
  // The SDK's block types predate plan blocks.
  type PlanBlock = {
    type: string;
    tasks?: { task_id: string; title: string; status: string }[];
  };
  const plan = (message?.blocks as PlanBlock[] | undefined)?.find(
    (block) => block.type === "plan",
  );
  const stuck: Chunk[] = (plan?.tasks ?? [])
    .filter((task) => task.status === "in_progress")
    .map((task) => ({
      type: "task_update",
      id: task.task_id,
      title: task.title,
      status: "error",
    }));
  await client.chat.stopStream({
    channel,
    ts: reply.ts,
    chunks: [
      ...stuck,
      { type: "plan_update", title: "Interrupted" },
      { type: "markdown_text", text: note },
    ],
  });
}
