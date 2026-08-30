import type { ConnectorCredentials } from "./types.js";

/**
 * The env names this package reads, and nothing else. Kept as one exported
 * table so `.env.example` and `scripts/config-inventory.ts` have a single
 * place to agree with — the inventory's "read but undocumented" delta is a
 * hard CI failure (`apps/agent-server/__tests__/config-inventory.test.ts`).
 *
 * `GOOGLE_CLIENT_TOKEN_ENC_KEY` is deliberately NOT here. It is named in
 * `connectors-config.data.ts:257,263` as the AES-256-GCM secret for the
 * `client_google_tokens` table's `encrypted_refresh_token` column — and that
 * table is infrastructure this repo does not have. Decryption therefore
 * happens wherever that table lives; this package receives an already-
 * decrypted refresh token and reading the key here would be a second copy of
 * the blast radius for no gain.
 */
export const CONNECTOR_ENV_VARS = [
  "PSI_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GSC_SERVICE_ACCOUNT_KEY",
  "GSC_SITE_URL",
] as const;

/**
 * Builds the credential bag from an injected env bag. Every field is optional
 * on purpose: a missing credential must produce an honest `not_connected` /
 * `UNAVAILABLE` outcome per connector at CALL time, never a construction-time
 * throw — the same rule `karos-media` and `karos-video` follow, and the reason
 * `works_unconnected.guarantee` can hold ("revoking cannot error the product").
 */
export function readConnectorCredentialsFromEnv(env: Readonly<Record<string, string | undefined>>): ConnectorCredentials {
  const credentials: ConnectorCredentials = {};
  const psiApiKey = env["PSI_API_KEY"];
  if (psiApiKey) credentials.psiApiKey = psiApiKey;
  const oauthClientId = env["GOOGLE_OAUTH_CLIENT_ID"];
  if (oauthClientId) credentials.oauthClientId = oauthClientId;
  const oauthClientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (oauthClientSecret) credentials.oauthClientSecret = oauthClientSecret;
  const gscServiceAccountKey = env["GSC_SERVICE_ACCOUNT_KEY"];
  if (gscServiceAccountKey) credentials.gscServiceAccountKey = gscServiceAccountKey;
  const gscSiteUrl = env["GSC_SITE_URL"];
  if (gscSiteUrl) credentials.gscSiteUrl = gscSiteUrl;
  return credentials;
}
