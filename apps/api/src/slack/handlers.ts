/**
 * Slack → Codex → Slack. Every Slack thread maps to one Codex thread; replies always go in-thread.
 */
import type { App } from "@slack/bolt";
import type { BotConfig } from "../config";
import { runTurn } from "../agent/codex";
import { afterTurn } from "../agent/learning";
import { AuthError } from "../auth/siwc";
import { deleteSession, getSession, saveSession, serialize, sessionKey } from "../sessions";
import { buildTurnInput, type Trigger } from "./context";
import { downloadAttachments, uploadFiles } from "./attachments";
import { closeInterrupted, openReply, type Reply } from "./reply";
import { markDone, markReply, markStarted, takeInterrupted } from "../inflight";

type WebClient = App["client"];

/** Interrupted turns younger than this are retried after a restart; older ones just get a note. */
const RESUME_WITHIN_MS = 30 * 60 * 1000;
const DEDUPE_MS = 10 * 60 * 1000;

/** Slack can deliver an event twice (e.g. after a socket reconnect); answer each message once. */
const handled = new Map<string, number>();
function firstDelivery(trigger: Trigger): boolean {
  const now = Date.now();
  for (const [id, at] of handled) if (now - at > DEDUPE_MS) handled.delete(id);
  const id = `${trigger.channel}:${trigger.ts}`;
  if (handled.has(id)) return false;
  handled.set(id, now);
  return true;
}

async function react(client: WebClient, channel: string, ts: string, add: string, remove?: string) {
  if (remove) await client.reactions.remove({ channel, timestamp: ts, name: remove }).catch(() => {});
  await client.reactions.add({ channel, timestamp: ts, name: add }).catch(() => {});
}

async function handle(client: WebClient, config: BotConfig, botUserId: string, trigger: Trigger) {
  if (!firstDelivery(trigger)) return;
  const threadTs = trigger.threadTs ?? trigger.ts;
  // Per user: each person in a shared thread has their own Codex thread, in their own container.
  const key = sessionKey(trigger.channel, threadTs, trigger.userId);
  // Keyed by message, not session: several messages can be queued for one thread.
  const inflightKey = `${trigger.channel}:${trigger.ts}`;
  await markStarted(inflightKey, trigger).catch(() => {});
  await react(client, trigger.channel, trigger.ts, "eyes");

  await serialize(key, async () => {
    let reply: Reply | undefined;
    try {
      reply = await openReply(client, { channel: trigger.channel, threadTs, userId: trigger.userId, teamId: trigger.teamId });
      await markReply(inflightKey, { ts: reply.ts, streaming: reply.streaming }).catch(() => {});
      const session = await getSession(key);
      const turn = await buildTurnInput({
        client,
        trigger,
        session,
        botUserId,
        contextMessages: config.contextMessages,
      });
      const files = await downloadAttachments(config.slackBotToken, turn.attachments);
      const result = await runTurn({
        config,
        user: { teamId: trigger.teamId, userId: trigger.userId },
        threadId: session?.codexThreadId,
        input: turn.text,
        files,
        onStep: reply.step,
      });
      await saveSession(key, { codexThreadId: result.threadId, lastSeenTs: trigger.ts });
      await reply.finish(result.text);
      void afterTurn(config, { teamId: trigger.teamId, userId: trigger.userId }, {
        place: turn.place,
        thread: `${trigger.channel}:${threadTs}`,
        messages: turn.transcript,
        reply: result.text || `(sent files: ${result.files.map((file) => file.name).join(", ")})`,
      }).catch((error) => console.warn(`[${key}] after-turn work failed`, error));

      // After the answer is posted, so a failed upload doesn't replace it with an error.
      const problems: string[] = [];
      await uploadFiles(client, trigger.channel, threadTs, result.files).catch((error) => {
        console.error(`[${key}] upload failed`, error);
        problems.push(`Couldn't upload ${result.files.map((file) => file.name).join(", ")}: ${error instanceof Error ? error.message : error}`);
      });
      if (result.skipped.length) problems.push(`Not uploaded (empty, over 50 MB, or past 10 files): ${result.skipped.join(", ")}`);
      for (const problem of problems) {
        await client.chat.postMessage({ channel: trigger.channel, thread_ts: threadTs, markdown_text: `:warning: ${problem}` });
      }
      await react(client, trigger.channel, trigger.ts, "white_check_mark", "eyes");
    } catch (error) {
      console.error(`[${key}]`, error);
      const text = error instanceof Error ? error.message : String(error);
      // The plan route rejected something in the Codex history; resuming would fail forever.
      const poisoned = text.includes("subscription_sharing_unsupported_capability");
      if (poisoned) await deleteSession(key);
      const message =
        error instanceof AuthError
          ? error.message
          : poisoned
            ? "That hit something the ChatGPT plan can't run, so I've reset our conversation in this thread. Please ask again."
            : `Something went wrong: ${text}`;
      await reply?.fail(message).catch((failure) => console.error(`[${key}] couldn't report the error`, failure));
      await react(client, trigger.channel, trigger.ts, "x", "eyes");
    } finally {
      await markDone(inflightKey).catch(() => {});
    }
  });
}

/**
 * Picks up turns a previous bot process didn't finish (it was restarted or crashed mid-answer):
 * closes their half-done reply and answers again. Call after stopping orphaned Codex runs.
 */
export async function resumeInterrupted(client: WebClient, config: BotConfig, botUserId: string): Promise<void> {
  for (const { trigger, startedAt, reply } of await takeInterrupted()) {
    const retry = Date.now() - startedAt < RESUME_WITHIN_MS;
    const note = retry ? "_I was restarted mid-answer, so I'm starting over below._" : "_I was restarted mid-answer. Please ask again._";
    if (reply) await closeInterrupted(client, { channel: trigger.channel, threadTs: trigger.threadTs ?? trigger.ts }, reply, note).catch((error) => console.warn("[resume] couldn't close reply:", error));
    console.log(`[resume] ${retry ? "retrying" : "dropping"} ${trigger.channel}:${trigger.ts}`);
    if (retry) void handle(client, config, botUserId, trigger);
    else await react(client, trigger.channel, trigger.ts, "x", "eyes");
  }
}

export function registerHandlers(app: App, config: BotConfig, botUserId: string) {
  const isAllowed = (userId: string | undefined): userId is string =>
    userId !== undefined && userId !== botUserId && (config.allowedUsers === "*" || config.allowedUsers.has(userId));

  // @mentions in channels (and in threads inside channels).
  app.event("app_mention", async ({ event, client, context }) => {
    if (!isAllowed(event.user)) return;
    void handle(client, config, botUserId, {
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
      isDm: false,
      teamId: context.teamId!,
      userId: event.user,
    });
  });

  // Every message in a DM with the bot; no mention needed there.
  app.message(async ({ message, client, context }) => {
    // Plain messages and ones with attachments ("file_share"); edits, joins etc. carry other subtypes.
    if (message.channel_type !== "im" || (message.subtype !== undefined && message.subtype !== "file_share")) return;
    if (!isAllowed(message.user)) return;
    void handle(client, config, botUserId, {
      channel: message.channel,
      ts: message.ts,
      threadTs: message.thread_ts,
      isDm: true,
      teamId: context.teamId!,
      userId: message.user,
    });
  });
}
