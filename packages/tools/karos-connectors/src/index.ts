import type { AgentToolRegistry } from "@agent-engine/core";
import { createGoogleDataSync, type CreateGoogleDataSyncOptions } from "./google-data-sync-tool.js";

export * from "./allowlist.js";
export * from "./types.js";
export * from "./env.js";
export * from "./read.js";
export * from "./access-token.js";
export * from "./gsc.js";
export * from "./crux.js";
export * from "./ga4.js";
export * from "./gbp.js";
export * from "./google-data-sync-tool.js";

/**
 * The Google first-party connector pack (SCRUM-232 / T-A6).
 *
 * ## Why this is its own package
 *
 * `packages/tools/karos-seo-geo` is deliberately network-free — a pure port of
 * the lab-spec scoring configs whose whole value is that a fixture-locked set
 * of inputs produces bit-identical scores (`reproducibility.rule`). Putting an
 * HTTP client in it would break that guarantee, so the connectors live here
 * and hand their results across as frozen snapshot hashes, exactly the way
 * `scorer_reads_snapshot_only` describes: *"Google is never re-asked live;
 * captured-once-then-frozen like every other input."*
 *
 * ## Why it is not in `createAllKarosTools()`
 *
 * Same reason `media.*` is not: this bundle reaches third-party APIs on a
 * credential, and a caller that asks for "all karos tools" should not silently
 * acquire egress to a client's Search Console, Analytics and Business Profile.
 * A composition root wires it in explicitly, as `apps/agent-server` does for
 * `media.*`/`video.*`/`landing.*`.
 */
export function createKarosConnectorsTools(options: CreateGoogleDataSyncOptions = {}): AgentToolRegistry {
  return {
    "connectors.googleDataSync": createGoogleDataSync(options),
  };
}
