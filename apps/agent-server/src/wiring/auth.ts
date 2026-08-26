import { OAuth2Client } from "google-auth-library";
import type { ServiceIdentityConfig, VerifyIdToken } from "../auth/service-identity.js";

/**
 * The real `VerifyIdToken` — `google-auth-library`'s `verifyIdToken` already
 * throws on an invalid, expired, or wrong-audience token, which is exactly this
 * contract's failure mode, so no extra wrapping is needed. Mirrors
 * `createQueuePushVerifier`, differing only in returning the claims (this
 * service needs the `email` claim for the service-account allowlist).
 */
export function createIdTokenVerifier(): VerifyIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    return { sub: payload?.sub, email: payload?.email };
  };
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Builds the service-identity configuration from environment variables, using
 * the same names as `agent-middleware`'s settings so one operator reads one
 * vocabulary across both services: `AUTH_ENABLED`, `AUTH_AUDIENCE`,
 * `AUTH_ALLOWED_SERVICE_ACCOUNTS` (comma-separated), `AUTH_DEV_TOKEN`.
 *
 * `AUTH_ENABLED` defaults to **off**, which keeps local development and the
 * existing test suite working unchanged. It is switched on per environment in
 * `cloudbuild.yaml`/`cloudbuild.promote.yaml`, where `AUTH_AUDIENCE` is also
 * set to the service's own URL — the same URL the portal already mints its
 * tokens for (`karosCMO`'s `AGENT_ENGINE_AUDIENCE`). Those two values must
 * match exactly or every call 401s.
 *
 * Production is derived from `FIRESTORE_DATABASE_ID` — the identical prep/prod
 * signal `packages/telemetry/src/tracer.ts` already reads, rather than a second
 * environment variable that could disagree with it.
 */
export function createServiceIdentityConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  verifyIdToken: VerifyIdToken | undefined = undefined,
): ServiceIdentityConfig {
  const enabled = env["AUTH_ENABLED"] === "true" || env["AUTH_ENABLED"] === "1";
  return {
    enabled,
    audience: env["AUTH_AUDIENCE"],
    allowedServiceAccounts: splitList(env["AUTH_ALLOWED_SERVICE_ACCOUNTS"]),
    devToken: env["AUTH_DEV_TOKEN"],
    isProduction: env["FIRESTORE_DATABASE_ID"] !== "prep",
    // Built lazily: a deployment with auth off should not construct an
    // OAuth2Client it will never call.
    verifyIdToken: verifyIdToken ?? (enabled ? createIdTokenVerifier() : undefined),
  };
}
