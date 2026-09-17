import { z } from "zod";
import type { AgentToolRegistry } from "@agent-engine/core";
import { DEFAULT_RETRY_POLICY, defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { readMetaCredentialsFromEnv } from "./env.js";
import type { GraphRuntime } from "./graph-client.js";
import { fetchFollowerCount, fetchMediaInsights, listRecentMedia, resolveInstagramBusinessAccountId } from "./insights.js";
import { publishInstagramImagePost } from "./publish.js";
import { MEDIA_TYPES, type MetaFetchImpl } from "./types.js";

export * from "./types.js";
export * from "./env.js";
export * from "./graph-client.js";
export * from "./insights.js";
export * from "./publish.js";

// 1.0.0 — first cut: read-only Instagram media insights + follower count via a System User token.
// 1.1.0 — added meta.publishInstagramPost (create-container -> media_publish), gated behind
//         META_PUBLISH_ENABLED in addition to the existing token gate. Internal-only: no new
//         client-facing "Connect" surface, and no Facebook Page post path — see publish.ts.
const TOOL_VERSION = "1.1.0";

export interface CreateKarosMetaToolsOptions {
  /** Defaults to `process.env` — injectable so a test supplies credentials without mutating the real process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — injectable so tests supply canned responses instead of hitting Meta. */
  fetchImpl?: MetaFetchImpl;
  /** Retry/deadline overrides, threaded straight into the shared `fetchWithRetry`. */
  runtime?: Omit<GraphRuntime, "fetchImpl">;
}

function notConfigured() {
  return notAvailable(
    "this deployment has no META_SYSTEM_USER_TOKEN configured — generate one in Meta Business Settings -> System Users once the app's Advanced Access is approved (see karosCMO's META_ADVANCED_ACCESS_APPROVED)",
  );
}

function publishNotEnabled() {
  return notAvailable(
    "META_PUBLISH_ENABLED is not set on this deployment — meta.publishInstagramPost is intentionally inert until it is explicitly turned on (a token alone does not enable posting)",
  );
}

/**
 * The Meta (Instagram) read connector pack.
 *
 * Not part of `createAllKarosTools()`, for the same reason `karos-connectors`
 * and `media.*` aren't: this reaches a third-party API on a shared
 * credential, so a caller asking for "all karos tools" should not silently
 * acquire Graph API egress. A composition root (`apps/agent-server`) wires
 * `createKarosMetaTools()` in explicitly.
 *
 * Two-tier degradation, same shape `connectors.googleDataSync` uses:
 * `not_available` is the DEPLOYMENT choice (no token configured at all, or
 * Meta has not approved Advanced Access yet), reported once per call;
 * `not_connected` / `UNAVAILABLE` (inside each `MetaReadOutcome`) is the
 * PER-CLIENT/per-read outcome — a missing Page id, a revoked Business
 * Manager partnership, or the Graph API call itself failing.
 */
export function createKarosMetaTools(options: CreateKarosMetaToolsOptions = {}): AgentToolRegistry {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = readMetaCredentialsFromEnv(env);
  const runtime: GraphRuntime = { fetchImpl, policy: DEFAULT_RETRY_POLICY, ...(options.runtime ?? {}) };

  return {
    "meta.resolveInstagramAccount": defineTool({
      name: "meta.resolveInstagramAccount",
      description:
        "Resolves the Instagram professional account linked to a client's Facebook Page, via Karos Labs' shared Business Manager System User token. Reports not_available when no token is configured; otherwise the Graph API outcome (ok/UNAVAILABLE), never a guess.",
      version: TOOL_VERSION,
      inputSchema: z.object({ pageId: z.string().min(1).describe("The client's Facebook Page id.") }),
      async execute({ pageId }) {
        if (!credentials.systemUserToken) return notConfigured();
        return success(await resolveInstagramBusinessAccountId(credentials.systemUserToken, pageId, runtime));
      },
    }),

    "meta.listRecentMedia": defineTool({
      name: "meta.listRecentMedia",
      description: "Lists a client's most recent Instagram posts/reels (id, media type, caption, timestamp, permalink), via the shared System User token.",
      version: TOOL_VERSION,
      inputSchema: z.object({
        igUserId: z.string().min(1).describe("The Instagram professional account id (from meta.resolveInstagramAccount)."),
        limit: z.number().int().positive().max(100).optional().describe("Max media items to return; defaults to 25."),
      }),
      async execute({ igUserId, limit }) {
        if (!credentials.systemUserToken) return notConfigured();
        return success(await listRecentMedia(credentials.systemUserToken, igUserId, runtime, limit));
      },
    }),

    "meta.fetchMediaInsights": defineTool({
      name: "meta.fetchMediaInsights",
      description:
        "Reads one post/reel/story's performance: reach, views, saved, shares, follows and profile visits. A metric the media type does not support (e.g. follows on a Reel) comes back null, never a fabricated 0.",
      version: TOOL_VERSION,
      inputSchema: z.object({
        mediaId: z.string().min(1),
        mediaType: z.enum(MEDIA_TYPES).describe("From meta.listRecentMedia's mediaType field — which metrics apply depends on this."),
      }),
      async execute({ mediaId, mediaType }) {
        if (!credentials.systemUserToken) return notConfigured();
        return success(await fetchMediaInsights(credentials.systemUserToken, mediaId, mediaType, runtime));
      },
    }),

    "meta.fetchFollowerCount": defineTool({
      name: "meta.fetchFollowerCount",
      description: "Reads a client's current Instagram follower total — the natural feed for karosCMO's clientFollowerSnapshots audience widget.",
      version: TOOL_VERSION,
      inputSchema: z.object({ igUserId: z.string().min(1).describe("The Instagram professional account id (from meta.resolveInstagramAccount).") }),
      async execute({ igUserId }) {
        if (!credentials.systemUserToken) return notConfigured();
        return success(await fetchFollowerCount(credentials.systemUserToken, igUserId, runtime));
      },
    }),

    /**
     * WRITE. Internal-only — no client-facing "Connect" flow calls this;
     * only Karos Labs staff/agents do, via this tool, against a client's
     * Instagram account through the same Business Manager grant
     * `instagram_insights` already reads under. Double-gated on purpose:
     * `notConfigured()` (no token at all) and `publishNotEnabled()`
     * (`META_PUBLISH_ENABLED` unset) are checked and can each independently
     * return `not_available` with ZERO network calls — a deployment can
     * carry this code with publish fully inert until someone explicitly
     * flips the flag. See `publish.ts`'s module header for why there is no
     * `meta.publishFacebookPost` sibling.
     */
    "meta.publishInstagramPost": defineTool({
      name: "meta.publishInstagramPost",
      description:
        "Publishes a single image post to a client's Instagram account via the shared System User token (create-container, then media_publish). INTERNAL ONLY — no client ever triggers this. Disabled unless this deployment has explicitly set META_PUBLISH_ENABLED; until then this always reports not_available and makes no network call.",
      version: TOOL_VERSION,
      inputSchema: z.object({
        igUserId: z.string().min(1).describe("The Instagram professional account id (from meta.resolveInstagramAccount)."),
        imageUrl: z.string().url().describe("Public HTTPS URL of the image to post — Meta's servers fetch it directly."),
        caption: z.string().optional(),
      }),
      async execute({ igUserId, imageUrl, caption }) {
        if (!credentials.systemUserToken) return notConfigured();
        if (!credentials.publishEnabled) return publishNotEnabled();
        return success(await publishInstagramImagePost(credentials.systemUserToken, igUserId, { imageUrl, ...(caption ? { caption } : {}) }, runtime));
      },
    }),
  };
}
