import type { LandingHostingConfig } from "./hosting/deploy-page-tool.js";

/**
 * Deployment-level configuration for the Landing Builder v2 tools. Only
 * Hosting needs any: the page is built in memory, checked in memory, rendered
 * from a string, and archived to the artifact store, so v1's three filesystem
 * roots (template / clients / bundles) are gone with the template kit.
 */
export interface LandingEngineConfig {
  /** Firebase Hosting target; `undefined` means "not configured", and `landing.deployPage` is then simply not registered. */
  hosting?: LandingHostingConfig;
}

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * `LANDING_HOSTING_PROJECT` names the Firebase project that owns the Hosting
 * sites (`karoscmo`, the one Firebase project this account has; prep and
 * prod both deploy there). `LANDING_HOSTING_SITE_PREFIX` keeps their sites
 * apart (`karos-prep-` vs `karos-`). Unset project => no Hosting: the run
 * still builds, checks, renders and archives, and the reviewer gets the
 * signed GCS URL instead of a `.web.app` one.
 */
export function createLandingEngineConfigFromEnv(options: { env?: Record<string, string | undefined> } = {}): LandingEngineConfig {
  const env = options.env ?? process.env;
  const projectId = readEnv(env, "LANDING_HOSTING_PROJECT");
  if (!projectId) return {};
  const ttlRaw = readEnv(env, "LANDING_HOSTING_PREVIEW_TTL_SECONDS");
  const ttl = ttlRaw ? Number(ttlRaw) : undefined;
  return {
    hosting: {
      projectId,
      sitePrefix: readEnv(env, "LANDING_HOSTING_SITE_PREFIX") ?? "karos-",
      ...(ttl && Number.isFinite(ttl) && ttl > 0 ? { previewTtlSeconds: ttl } : {}),
    },
  };
}
