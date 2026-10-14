/**
 * Turns Slack messages around a mention into a plain-text transcript for Codex.
 */
import type { App } from "@slack/bolt";
import type { Session } from "../sessions";

type WebClient = App["client"];

type SlackMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: { name?: string; title?: string }[];
};

export type Trigger = {
  channel: string;
  /** ts of the message that mentioned the bot. */
  ts: string;
  /** Parent ts when the mention is inside a thread. */
  threadTs?: string;
  isDm: boolean;
};

const names = new Map<string, string>();
const channels = new Map<string, string>();

async function userName(client: WebClient, userId: string): Promise<string> {
  const cached = names.get(userId);
  if (cached) return cached;
  const { user } = await client.users.info({ user: userId }).catch(() => ({ user: undefined }));
  const name = user?.profile?.display_name || user?.real_name || user?.name || userId;
  names.set(userId, name);
  return name;
}

async function channelName(client: WebClient, trigger: Trigger): Promise<string> {
  if (trigger.isDm) return "a direct message";
  const cached = channels.get(trigger.channel);
  if (cached) return cached;
  const { channel } = await client.conversations.info({ channel: trigger.channel }).catch(() => ({ channel: undefined }));
  const name = channel?.name ? `#${channel.name}` : trigger.channel;
  channels.set(trigger.channel, name);
  return name;
}

async function formatMessage(client: WebClient, message: SlackMessage, botUserId: string): Promise<string> {
  const author = message.user === botUserId ? "you (the bot)" : message.user ? await userName(client, message.user) : "a bot";
  const mention = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  const raw = message.text ?? "";
  const ids = new Set(Array.from(raw.matchAll(mention), (match) => match[1]!));
  const resolved = new Map(
    await Promise.all([...ids].map(async (id) => [id, id === botUserId ? "you" : await userName(client, id)] as const)),
  );
  const text = raw.replace(mention, (_, id: string) => `@${resolved.get(id)}`);
  const files = message.files?.map((file) => `[attached file: ${file.title ?? file.name ?? "untitled"}]`).join(" ");
  const time = new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `[${time} UTC] ${author}: ${[text, files].filter(Boolean).join(" ")}`;
}

/** Messages Codex hasn't seen yet, oldest first, ending with the trigger. */
async function fetchMessages(client: WebClient, trigger: Trigger, session: Session | undefined, limit: number) {
  let messages: SlackMessage[];
  if (trigger.threadTs) {
    const replies = await client.conversations.replies({ channel: trigger.channel, ts: trigger.threadTs, limit: 200 });
    messages = (replies.messages ?? []) as SlackMessage[];
  } else {
    // Top-level mention: the channel messages just before it are the surrounding context.
    const history = await client.conversations.history({ channel: trigger.channel, latest: trigger.ts, inclusive: true, limit });
    messages = ((history.messages ?? []) as SlackMessage[]).reverse();
  }

  return messages.filter((message) => {
    const ts = Number(message.ts);
    if (ts > Number(trigger.ts)) return false;
    if (session && ts <= Number(session.lastSeenTs)) return false;
    return !message.subtype || message.subtype === "thread_broadcast" || message.subtype === "file_share";
  });
}

/** Builds the Codex input for this turn. Follow-up turns only carry messages newer than the last turn. */
export async function buildTurnInput(options: {
  client: WebClient;
  trigger: Trigger;
  session: Session | undefined;
  botUserId: string;
  contextMessages: number;
}): Promise<string> {
  const { client, trigger, session, botUserId, contextMessages } = options;
  const messages = await fetchMessages(client, trigger, session, contextMessages);
  // On follow-ups Codex already knows what it said; skip the bot's own replies.
  const relevant = session ? messages.filter((message) => message.user !== botUserId) : messages;
  const lines = await Promise.all(relevant.map((message) => formatMessage(client, message, botUserId)));
  const where = await channelName(client, trigger);

  const header = session
    ? `New Slack messages in the same thread (${where}) since your last reply, oldest first:`
    : `You were mentioned in Slack (${where}${trigger.threadTs ? ", inside a thread" : ""}). Conversation so far, oldest first:`;
  return `${header}\n\n${lines.join("\n")}\n\nRespond to the last message. Your reply is posted back to Slack as-is.`;
}
