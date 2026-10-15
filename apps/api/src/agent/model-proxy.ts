/**
 * Keeps the ChatGPT plan token out of user containers.
 *
 * Codex inside a container calls this proxy with a per-process random key; the proxy swaps in
 * the real SIWC access token and forwards to the OpenAI API. Commands a user runs in their
 * container can see the proxy key, but it only works here, only for model calls, and dies with
 * this process. Listens on the Docker bridge address, so it isn't reachable from the network.
 */
import { getAccessToken, RESOURCE } from "../auth/siwc";

/** Model calls Codex makes; everything else is refused. */
const ALLOWED = new Set(["POST /v1/responses", "GET /v1/models"]);

export type ModelProxy = { baseUrl: string; key: string };

let proxy: ModelProxy | null = null;

export async function startModelProxy(): Promise<ModelProxy> {
  if (proxy) return proxy;
  const gateway = (await Bun.$`docker network inspect bridge --format ${"{{(index .IPAM.Config 0).Gateway}}"}`.text()).trim();
  const key = crypto.randomUUID();
  const upstream = new URL(RESOURCE).origin;

  const server = Bun.serve({
    hostname: gateway,
    port: 0,
    idleTimeout: 0, // responses stream for as long as the model takes
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${key}`) return new Response("unauthorized", { status: 401 });
      if (!ALLOWED.has(`${request.method} ${url.pathname}`)) {
        console.warn(`[model-proxy] refused ${request.method} ${url.pathname}`);
        return new Response("not allowed", { status: 403 });
      }

      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${await getAccessToken()}`);
      headers.set("accept-encoding", "identity"); // pass the stream through untouched
      headers.delete("host");
      return fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body });
    },
  });

  proxy = { baseUrl: `http://${gateway}:${server.port}/v1`, key };
  return proxy;
}
