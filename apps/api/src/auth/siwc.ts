/**
 * Sign in with ChatGPT (SIWC) credentials: storage, host ID and token refresh.
 * Contract: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import { paths } from "../config";
import { readJson, writeJsonPrivate } from "../files";

export const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
export const JWKS_URL = `${AUTH_ISSUER}/.well-known/jwks.json`;
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`;

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 5 * 60_000;

const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export type Credentials = {
  /** Client ID issued at first registration. Never `dynamic_agent_client`. */
  client_id: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  /** Epoch ms. */
  expires_at?: number;
  /** Epoch ms; from the token response's `earliest_refresh_at`. */
  earliest_refresh_at?: number;
  account?: { sub: string; email?: string; name?: string };
  saved_at?: number;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  earliest_refresh_at?: number;
};

export class AuthError extends Error {}

/** Stable per-machine ID sent as `ext_agent_host_id`. Each machine running the bot needs its own. */
export async function getHostId(): Promise<string> {
  const saved = await readJson<{ host_id: string }>(paths.hostId);
  if (saved?.host_id) return saved.host_id;
  const host_id = `urn:uuid:${crypto.randomUUID()}`;
  await writeJsonPrivate(paths.hostId, { host_id });
  return host_id;
}

export const loadCredentials = () => readJson<Credentials>(paths.auth);
export const saveCredentials = (credentials: Credentials) =>
  writeJsonPrivate(paths.auth, { ...credentials, saved_at: Date.now() });

/** Merge a token endpoint response into the stored credentials. */
export function applyTokenResponse(credentials: Credentials, tokens: TokenResponse): Credentials {
  const now = Date.now();
  return {
    ...credentials,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token ?? credentials.id_token,
    scope: tokens.scope ?? credentials.scope,
    expires_at: now + tokens.expires_in * 1000,
    earliest_refresh_at: tokens.earliest_refresh_at ? tokens.earliest_refresh_at * 1000 : undefined,
  };
}

export function hasPlanUsage(credentials: Credentials): boolean {
  return credentials.scope?.split(" ").includes(PLAN_USAGE_SCOPE) ?? false;
}

async function refresh(credentials: Credentials): Promise<Credentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.client_id,
      refresh_token: credentials.refresh_token!,
      resource: RESOURCE,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string };

  if (!response.ok) {
    const code = body.error ?? `http_${response.status}`;
    if (TERMINAL_REFRESH_ERRORS.has(code)) {
      // Keep the registration (client_id), drop the dead tokens.
      await saveCredentials({ client_id: credentials.client_id });
      throw new AuthError(`ChatGPT session ended (${code}). Run \`bun run login\` again.`);
    }
    if (code === "invalid_client") {
      throw new AuthError("ChatGPT client registration rejected (invalid_client). Delete .data/chatgpt-auth.json and run `bun run login`.");
    }
    throw new Error(`Token refresh failed: ${code}`);
  }

  const updated = applyTokenResponse(credentials, body);
  await saveCredentials(updated);
  return updated;
}

let inflight: Promise<Credentials> | null = null;

/**
 * Returns a valid access token, refreshing first if it is close to expiry.
 * Refreshes are serialized because each one rotates the refresh token.
 */
export async function getAccessToken(): Promise<string> {
  if (inflight) return (await inflight).access_token!;

  const credentials = await loadCredentials();
  if (!credentials?.access_token || !credentials.refresh_token) {
    throw new AuthError("Not signed in to ChatGPT. Run `bun run login`.");
  }
  if (!hasPlanUsage(credentials)) {
    throw new AuthError("ChatGPT plan usage was not granted. Run `bun run login` and allow plan usage.");
  }

  const now = Date.now();
  const expiresSoon = (credentials.expires_at ?? 0) - now < REFRESH_SKEW_MS;
  const tooEarly = credentials.earliest_refresh_at !== undefined && now < credentials.earliest_refresh_at;
  const expired = (credentials.expires_at ?? 0) <= now;
  if (!expiresSoon || (tooEarly && !expired)) return credentials.access_token;

  inflight = refresh(credentials);
  try {
    return (await inflight).access_token!;
  } finally {
    inflight = null;
  }
}
