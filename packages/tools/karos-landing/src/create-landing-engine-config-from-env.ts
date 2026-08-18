import * as path from "node:path";
import type { LandingEngineConfig } from "./config.js";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

export interface CreateLandingEngineConfigFromEnvOptions {
  /** Defaults to `process.env`. Override for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolves the three Landing Builder roots from environment configuration,
 * mirroring `createWorkspaceStoreFromEnv`'s shape. Unlike the
 * `WorkspaceStoreLike` backends, there is no sensible zero-config default for
 * `templateRoot` (a checked-out copy of `engine/template/` has to exist
 * *somewhere* concrete) — callers that don't set `LANDING_ENGINE_TEMPLATE_ROOT`
 * fall back to `<cwd>/.landing-engine/template`, which is intentionally
 * useless in production (fails fast the first time `landing.copyTemplate`
 * looks for a real kit there) but harmless for any test/composition-root
 * code path that never actually touches the Landing Builder tools.
 */
export function createLandingEngineConfigFromEnv(options: CreateLandingEngineConfigFromEnvOptions = {}): LandingEngineConfig {
  const env = options.env ?? process.env;
  const root = readEnv(env, "LANDING_ENGINE_ROOT") ?? path.join(process.cwd(), ".landing-engine");
  return {
    templateRoot: readEnv(env, "LANDING_ENGINE_TEMPLATE_ROOT") ?? path.join(root, "template"),
    engineClientsRoot: readEnv(env, "LANDING_ENGINE_CLIENTS_ROOT") ?? path.join(root, "clients"),
    bundlesRoot: readEnv(env, "LANDING_ENGINE_BUNDLES_ROOT") ?? path.join(root, "bundles"),
  };
}
