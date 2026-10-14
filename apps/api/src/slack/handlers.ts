/**
 * Slack → Codex → Slack. Every Slack thread maps to one Codex thread; replies always go in-thread.
 */
import type { App } from "@slack/bolt";
import type { BotConfig } from "../config";
import { runTurn } from "../agent/codex";
import { AuthError } from "../auth/siwc";
import { getSession, saveSession, serialize, sessionKey } from "../sessions";
import { buildTurnInput, type Trigger } from "./context";

type WebClient = App["client"];

/** Slack's limit for `markdown_text`. */
const MAX_MARKDOWN = 12_000;
const PROGRESS_INTERVAL_MS = 2_500;

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

/** Edits the placeholder with Codex's latest activity, at most once per interval. */
function progressReporter(update: (status: string) => Promise<unknown>) {
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
    chain = chain.then(() => update(status)).catch(() => {});
  };

  return {
    push(status: string) {
      latest = status;
      timer ??= setTimeout(flush, Math.max(0, lastSent + PROGRESS_INTERVAL_MS - Date.now()));
    },
    /** Stops updates and waits for any in-flight edit, so it can't overwrite the final answer. */
    async close() {
      closed = true;
      clearTimeout(timer);
      await chain;
    },
  };
}

async function react(client: WebClient, channel: string, ts: string, add: string, remove?: string) {
  if (remove) await client.reactions.remove({ channel, timestamp: ts, name: remove }).catch(() => {});
  await client.reactions.add({ channel, timestamp: ts, name: add }).catch(() => {});
}

async function handle(client: WebClient, config: BotConfig, botUserId: string, trigger: Trigger) {
  const threadTs = trigger.threadTs ?? trigger.ts;
  const key = sessionKey(trigger.channel, threadTs);
  await react(client, trigger.channel, trigger.ts, "eyes");

  await serialize(key, async () => {
    const placeholder = await client.chat.postMessage({
      channel: trigger.channel,
      thread_ts: threadTs,
      markdown_text: "_Working on it…_",
    });
    const placeholderTs = placeholder.ts!;
    const progress = progressReporter((status) =>
      client.chat.update({ channel: trigger.channel, ts: placeholderTs, markdown_text: `_Working on it…_\n\n${status}` }),
    );

    try {
      const session = await getSession(key);
      const input = await buildTurnInput({
        client,
        trigger,
        session,
        botUserId,
        contextMessages: config.contextMessages,
      });
      const result = await runTurn({ config, threadId: session?.codexThreadId, input, onProgress: progress.push });
      await saveSession(key, { codexThreadId: result.threadId, lastSeenTs: trigger.ts });

      await progress.close();
      const [first, ...rest] = chunkMarkdown(result.text);
      await client.chat.update({ channel: trigger.channel, ts: placeholderTs, markdown_text: first! });
      for (const chunk of rest) {
        await client.chat.postMessage({ channel: trigger.channel, thread_ts: threadTs, markdown_text: chunk });
      }
      await react(client, trigger.channel, trigger.ts, "white_check_mark", "eyes");
    } catch (error) {
      await progress.close();
      console.error(`[${key}]`, error);
      const message = error instanceof AuthError ? error.message : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      await client.chat.update({ channel: trigger.channel, ts: placeholderTs, markdown_text: `:warning: ${message}` }).catch(() => {});
      await react(client, trigger.channel, trigger.ts, "x", "eyes");
    }
  });
}

export function registerHandlers(app: App, config: BotConfig, botUserId: string) {
  const isOwner = (userId: string | undefined) => userId === config.ownerUserId;

  // @mentions in channels (and in threads inside channels).
  app.event("app_mention", async ({ event, client }) => {
    if (!isOwner(event.user)) return;
    void handle(client, config, botUserId, {
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
      isDm: false,
    });
  });

  // Every owner message in a DM with the bot; no mention needed there.
  app.message(async ({ message, client }) => {
    if (message.channel_type !== "im" || message.subtype !== undefined) return;
    if (!isOwner(message.user)) return;
    void handle(client, config, botUserId, {
      channel: message.channel,
      ts: message.ts,
      threadTs: message.thread_ts,
      isDm: true,
    });
  });
}
