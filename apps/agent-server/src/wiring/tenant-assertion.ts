import type { TenantAssertionConfig } from "../auth/tenant-assertion.js";

/**
 * Builds the tenant-assertion configuration from environment variables
 * (AU46 / SCRUM-329), mirroring `wiring/auth.ts`'s
 * `createServiceIdentityConfigFromEnv` shape: `TENANT_ASSERTION_ENABLED`
 * defaults to **off**, which keeps local development and the existing test
 * suite working unchanged, and `TENANT_ASSERTION_SECRET` is the shared
 * HMAC secret with the portal (see `auth/tenant-assertion.ts`'s module
 * docstring for the wire format).
 *
 * Deliberately NOT wired into `cloudbuild.yaml`/`cloudbuild.promote.yaml` by
 * this ticket: decision 9 (SCRUM-333 comment 10404) says the portal signs
 * the assertion, but the portal-side signer does not exist in karosCMO yet
 * — flipping `TENANT_ASSERTION_ENABLED=true` in either deploy config before
 * that lands would 401 every real request from the one caller that exists
 * today. See `docs/decisions/AU46-tenant-identity.md` for the rollout
 * sequencing this leaves for a follow-up ticket.
 */
export function createTenantAssertionConfigFromEnv(env: Record<string, string | undefined> = process.env): TenantAssertionConfig {
  const enabled = env["TENANT_ASSERTION_ENABLED"] === "true" || env["TENANT_ASSERTION_ENABLED"] === "1";
  return {
    enabled,
    secret: env["TENANT_ASSERTION_SECRET"],
  };
}
