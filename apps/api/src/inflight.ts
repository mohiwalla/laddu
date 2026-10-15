/**
 * Turns in progress, on disk, so a restart can pick up what it cut off (idea from Hermes Agent's
 * gateway). An entry is written when a turn starts, gets its reply message once posted, and is
 * removed when the turn ends, however it ends.
 */
import { paths } from "./config";
import { readJson, writeJsonPrivate } from "./files";
import type { Trigger } from "./slack/context";

export type Inflight = {
  trigger: Trigger;
  startedAt: number;
  /** The reply message, once posted; `streaming` says whether it's a Slack stream. */
  reply?: { ts: string; streaming: boolean };
};

const file = `${paths.dataDir}/inflight.json`;
let entries: Record<string, Inflight> | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Applies a change and saves, one at a time so concurrent turns don't lose each other's writes. */
function change(apply: (all: Record<string, Inflight>) => void): Promise<void> {
  const next = chain.then(async () => {
    entries ??= (await readJson<Record<string, Inflight>>(file)) ?? {};
    apply(entries);
    await writeJsonPrivate(file, entries);
  });
  chain = next.catch((error) => console.error("[inflight] couldn't save:", error));
  return next;
}

export const markStarted = (key: string, trigger: Trigger) =>
  change((all) => void (all[key] = { trigger, startedAt: Date.now() }));

export const markReply = (key: string, reply: { ts: string; streaming: boolean }) =>
  change((all) => void (all[key] && (all[key].reply = reply)));

export const markDone = (key: string) => change((all) => void delete all[key]);

/** Every turn a previous process left unfinished; clears the record. */
export async function takeInterrupted(): Promise<Inflight[]> {
  let taken: Inflight[] = [];
  await change((all) => {
    taken = Object.values(all);
    for (const key of Object.keys(all)) delete all[key];
  });
  return taken;
}
