/**
 * Bolt receiver for Slack Socket Mode on Bun's native WebSocket.
 *
 * Bolt's built-in receiver (@slack/socket-mode) calls `ping` from undici, which Bun's built-in
 * undici doesn't export, so it drops the connection every few seconds. The protocol is small
 * enough to own: https://docs.slack.dev/apis/events-api/using-socket-mode
 */
import type { App, Receiver } from "@slack/bolt";

type Envelope = {
  type: "hello" | "disconnect" | "events_api" | "interactive" | "slash_commands" | string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
  retry_attempt?: number;
  retry_reason?: string;
  reason?: string;
};

const HEARTBEAT_MS = 10_000;
/** Reconnect when nothing (pong or message) has arrived for this long. */
const DEAD_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export class BunSocketModeReceiver implements Receiver {
  private app?: App;
  private ws?: WebSocket;
  private heartbeat?: Timer;
  private lastSeen = 0;
  private stopped = true;
  private reconnecting = false;

  constructor(private readonly appToken: string) {}

  init(app: App) {
    this.app = app;
  }

  async start() {
    this.stopped = false;
    await this.connect();
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.ws?.close(1000, "stopping");
  }

  private async openUrl(): Promise<string> {
    const response = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
    if (!body.ok || !body.url) throw new Error(`apps.connections.open failed: ${body.error ?? response.status}`);
    return body.url;
  }

  /** Opens a new connection and swaps it in once Slack says hello; the old one is closed after. */
  private async connect(): Promise<void> {
    const ws = new WebSocket(await this.openUrl());

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        this.lastSeen = Date.now();
        const envelope = JSON.parse(String(event.data)) as Envelope;
        if (envelope.type === "hello") {
          const previous = this.ws;
          this.ws = ws;
          previous?.close(1000, "replaced");
          resolve();
          return;
        }
        void this.handle(ws, envelope);
      });
      ws.addEventListener("pong", () => (this.lastSeen = Date.now()));
      ws.addEventListener("error", () => reject(new Error("Socket Mode connection failed")));
      ws.addEventListener("close", () => {
        reject(new Error("Socket Mode connection closed before hello"));
        // Only the live connection matters; replaced ones close on purpose.
        if (ws === this.ws && !this.stopped) void this.reconnect("connection closed");
      });
    });
  }

  private async handle(ws: WebSocket, envelope: Envelope) {
    if (envelope.type === "disconnect") {
      // Slack asks to refresh (e.g. "warning", "refresh_requested"); open the next connection first.
      void this.reconnect(`Slack requested disconnect (${envelope.reason})`);
      return;
    }
    if (!envelope.envelope_id || !envelope.payload) return;

    const envelopeId = envelope.envelope_id;
    try {
      await this.app!.processEvent({
        body: envelope.payload,
        retryNum: envelope.retry_attempt,
        retryReason: envelope.retry_reason,
        ack: async (response?: unknown) => {
          ws.send(JSON.stringify(response === undefined ? { envelope_id: envelopeId } : { envelope_id: envelopeId, payload: response }));
        },
      });
    } catch (error) {
      console.error(`[socket-mode] ${envelope.type} handler failed:`, error);
    }
  }

  private checkAlive() {
    if (this.stopped || this.reconnecting || !this.ws) return;
    if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
      void this.reconnect("no pong from Slack");
      return;
    }
    this.ws.ping();
  }

  private async reconnect(reason: string) {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    console.warn(`[socket-mode] reconnecting: ${reason}`);
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await this.connect();
        console.log("[socket-mode] reconnected");
        break;
      } catch (error) {
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
        console.error(`[socket-mode] reconnect failed, retrying in ${delay / 1000}s: ${(error as Error).message}`);
        await Bun.sleep(delay);
      }
    }
    this.reconnecting = false;
  }
}
