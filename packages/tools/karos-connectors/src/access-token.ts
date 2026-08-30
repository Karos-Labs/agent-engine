import { z } from "zod";
import { DEFAULT_RETRY_POLICY, describeFetchFailure, fetchWithRetry } from "@agent-engine/tool-common";
import type { ReadRuntime } from "./read.js";
import type { ConnectorCredentials, GoogleConnection } from "./types.js";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface MintedAccessToken {
  accessToken: string;
  /** Epoch ms this token stops being usable, when Google told us. */
  expiresAtMs?: number;
  /** The scopes Google actually granted — worth logging, never worth persisting (`security.exposure`: scope strings are zero-anon). */
  scope?: string;
}

export type MintAccessTokenResult = { ok: true; token: MintedAccessToken } | { ok: false; reason: string };

/**
 * Exchanges a client's refresh token for a short-lived access token.
 *
 * `connectors-config.data.ts:257`: *"access_token NOT persisted (minted in
 * memory each sync, gmail-sync risk-review fix)"* — so this returns the token
 * to its one caller and writes it nowhere. It is also the only place
 * `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` are used; the four
 * connector clients receive a bearer string and never see the app credentials.
 *
 * Not routed through `allowlistedRead`: the OAuth token endpoint is not one of
 * `connectors[].read_methods_allowlist`'s method tokens and pretending it were
 * would put a non-connector call inside the table that exists to fence
 * connector calls in. It uses the same shared bounded/retried stack.
 */
export async function mintAccessToken(
  connection: GoogleConnection,
  credentials: ConnectorCredentials,
  runtime: ReadRuntime,
): Promise<MintAccessTokenResult> {
  if (connection.revokedAt) {
    return { ok: false, reason: `client "${connection.clientId}" revoked the Google grant at ${connection.revokedAt}` };
  }
  // A caller that already minted one (the sync's own per-run cache) skips the round trip entirely.
  if (connection.accessToken) return { ok: true, token: { accessToken: connection.accessToken } };
  if (!connection.refreshToken) {
    return { ok: false, reason: `client "${connection.clientId}" has no stored Google refresh token` };
  }
  if (!credentials.oauthClientId || !credentials.oauthClientSecret) {
    return { ok: false, reason: "missing env GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET" };
  }

  const body = new URLSearchParams({
    client_id: credentials.oauthClientId,
    client_secret: credentials.oauthClientSecret,
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  });

  let response: Response;
  try {
    response = await fetchWithRetry(runtime.fetchImpl as (url: string, init?: RequestInit) => Promise<Response>, GOOGLE_TOKEN_ENDPOINT, {
      init: { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
      policy: runtime.policy ?? DEFAULT_RETRY_POLICY,
      ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
      ...(runtime.totalBudgetMs !== undefined ? { totalBudgetMs: runtime.totalBudgetMs } : {}),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.now ? { now: runtime.now } : {}),
    });
  } catch (err) {
    return { ok: false, reason: describeFetchFailure(err, "the Google OAuth token endpoint") };
  }

  if (!response.ok) {
    // 400 invalid_grant is the revoked/expired case the health probe exists to
    // catch (`security.cron`); it is reported, never retried into success.
    return { ok: false, reason: `the Google OAuth token endpoint returned HTTP ${response.status}` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { ok: false, reason: `the Google OAuth token endpoint returned a body that is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `the Google OAuth token endpoint response did not match the expected shape: ${parsed.error.message}` };
  }

  const now = runtime.now ?? Date.now;
  const token: MintedAccessToken = { accessToken: parsed.data.access_token };
  if (parsed.data.expires_in !== undefined) token.expiresAtMs = now() + parsed.data.expires_in * 1000;
  if (parsed.data.scope !== undefined) token.scope = parsed.data.scope;
  return { ok: true, token };
}
