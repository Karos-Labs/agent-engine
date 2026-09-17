import type { MetaCredentials } from "./types.js";

/**
 * The env names this package reads, and nothing else — mirrors
 * `karos-connectors`' `CONNECTOR_ENV_VARS` convention so `.env.example` and
 * any config-inventory check have one place to agree with.
 *
 * There is deliberately no per-client OAuth pair here. `META_SYSTEM_USER_TOKEN`
 * is Karos Labs' OWN long-lived Business Manager System User token — every
 * client that wants their Page/Instagram data read (or, once
 * `META_PUBLISH_ENABLED` is also set, posted to) grants it access by adding
 * Karos Labs as a partner in their own Meta Business Settings, not by an
 * individual OAuth consent. One token, every client's assets it was granted.
 *
 * `META_PUBLISH_ENABLED` is the second gate on `meta.publishInstagramPost`
 * (see `index.ts` and `publish.ts`'s module header) — mirrors this codebase's
 * existing gradually-enabled-capability flags (`ANALYTICS_LIVE_INGEST`,
 * `DYNAMIC_CODE_STEPS_ENABLED`): default OFF, a deployment turns it on
 * explicitly once it is ready for this package to actually post on a
 * client's behalf. Having a token configured is NOT enough by itself — a
 * deployment that only wants read insights must be able to set the token
 * without also silently switching publish on.
 */
export const META_ENV_VARS = ["META_SYSTEM_USER_TOKEN", "META_PUBLISH_ENABLED"] as const;

const TRUTHY = new Set(["1", "true", "TRUE", "yes"]);

/**
 * Builds the credential bag from an injected env bag. `systemUserToken` is
 * optional on purpose: a deployment with no token configured must produce an
 * honest `not_available` outcome at CALL time, never a construction-time
 * throw — the same rule `karos-connectors`/`karos-media` follow ("revoking
 * cannot error the product"). `publishEnabled` defaults to `false` for the
 * same reason: an unset flag must read as "off", not "unspecified".
 */
export function readMetaCredentialsFromEnv(env: Readonly<Record<string, string | undefined>>): MetaCredentials {
  const credentials: MetaCredentials = { publishEnabled: TRUTHY.has(env["META_PUBLISH_ENABLED"] ?? "") };
  const systemUserToken = env["META_SYSTEM_USER_TOKEN"];
  if (systemUserToken) credentials.systemUserToken = systemUserToken;
  return credentials;
}
