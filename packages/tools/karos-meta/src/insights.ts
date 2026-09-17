import { z } from "zod";
import { graphGet, omitPayload, type GraphRuntime } from "./graph-client.js";
import { MEDIA_TYPES, type MetaMediaInsights, type MetaMediaSummary, type MetaMediaType, type MetaReadOutcome } from "./types.js";

/**
 * Everything in THIS FILE is still read-only: resolving and reporting
 * Instagram performance data for a client's own Page/Instagram professional
 * account. This package as a whole is no longer read-only, though — see
 * `publish.ts` for the Instagram publish path, gated separately
 * (`META_PUBLISH_ENABLED`) from the reads this file does.
 *
 * Karos Labs' existing OAuth publish path (`karosCMO`'s
 * `src/lib/integrations/oauth.ts` + `publishers.ts`, per-client tokens) is a
 * separate, unrelated system; this file does not touch it and does not need
 * its scopes (`instagram_content_publish`, `pages_manage_posts` — those are
 * `publish.ts`'s scopes now, requested against the SAME shared System User
 * token this file already uses for reads).
 */

export const RESOLVE_INSTAGRAM_ACCOUNT = "resolveInstagramBusinessAccount";
export const LIST_RECENT_MEDIA = "listRecentMedia";
export const FETCH_MEDIA_INSIGHTS = "fetchMediaInsights";
export const FETCH_FOLLOWER_COUNT = "fetchFollowerCount";

const PageInstagramAccountSchema = z.object({
  instagram_business_account: z.object({ id: z.string() }).optional(),
});

/**
 * `pages_show_list` / `pages_read_engagement` territory: which Instagram
 * professional account is linked to this Facebook Page. A client hands over
 * their Page id (the thing they actually have on hand); this is the one
 * lookup that turns it into the id every other call in this file needs.
 */
export async function resolveInstagramBusinessAccountId(
  token: string,
  pageId: string,
  runtime: GraphRuntime,
): Promise<MetaReadOutcome<string | null>> {
  const outcome = await graphGet(RESOLVE_INSTAGRAM_ACCOUNT, pageId, { fields: "instagram_business_account" }, token, runtime, PageInstagramAccountSchema);
  if (outcome.status !== "ok") return omitPayload(outcome);
  return { ...outcome, payload: outcome.payload?.instagram_business_account?.id ?? null };
}

const MediaListSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        media_type: z.string().optional(),
        media_product_type: z.string().optional(),
        caption: z.string().optional(),
        timestamp: z.string().optional(),
        permalink: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * `media_product_type` is the field Meta actually uses to say "this is a
 * Reel" — a Reel's `media_type` is still `VIDEO`. STORY only ever shows up
 * here while it is live (expires 24h after posting), which is a known,
 * accepted gap for this connector: a client's stories are not retrievable
 * after they expire, by Meta's own design, not this package's.
 */
function normalizeMediaType(raw: { media_type?: string | undefined; media_product_type?: string | undefined }): MetaMediaType {
  if (raw.media_product_type === "REELS") return "REELS";
  if (raw.media_product_type === "STORY") return "STORY";
  return "FEED";
}

/** `instagram_basic`: the client's own recent posts/reels, newest first. */
export async function listRecentMedia(
  token: string,
  igUserId: string,
  runtime: GraphRuntime,
  limit = 25,
): Promise<MetaReadOutcome<MetaMediaSummary[]>> {
  const outcome = await graphGet(
    LIST_RECENT_MEDIA,
    `${igUserId}/media`,
    { fields: "id,media_type,media_product_type,caption,timestamp,permalink", limit: String(limit) },
    token,
    runtime,
    MediaListSchema,
  );
  if (outcome.status !== "ok" || !outcome.payload) return omitPayload(outcome);
  const media: MetaMediaSummary[] = outcome.payload.data.map((m) => ({
    id: m.id,
    mediaType: normalizeMediaType(m),
    ...(m.caption !== undefined ? { caption: m.caption } : {}),
    ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
    ...(m.permalink !== undefined ? { permalink: m.permalink } : {}),
  }));
  return { ...outcome, payload: media };
}

/**
 * Per Meta's documented `instagram-media/insights` metric support (checked
 * 2026-09-16): `saved` is FEED+REELS only; `follows`/`profile_visits` are
 * FEED+STORY only; `reach`/`views`/`shares` apply to all three. Requesting a
 * metric a media type does not support is itself a Graph API error, so this
 * function only ever asks for what applies — everything else in
 * `MetaMediaInsights` for that media comes back `null` (see `valueOf` in
 * `fetchMediaInsights`), never a guessed 0. This table is the one place that
 * rule is encoded; see the README for the same table as a reference.
 */
function metricsForMediaType(mediaType: MetaMediaType): string[] {
  const metrics = ["reach", "views", "shares"];
  if (mediaType === "FEED" || mediaType === "REELS") metrics.push("saved");
  if (mediaType === "FEED" || mediaType === "STORY") metrics.push("follows", "profile_visits");
  return metrics;
}

const MediaInsightsSchema = z.object({
  data: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.object({ value: z.number().optional() })).optional(),
      }),
    )
    .default([]),
});

/** `instagram_manage_insights`: the six metrics the portal reports, for one post/reel/story. */
export async function fetchMediaInsights(
  token: string,
  mediaId: string,
  mediaType: MetaMediaType,
  runtime: GraphRuntime,
): Promise<MetaReadOutcome<MetaMediaInsights>> {
  const metrics = metricsForMediaType(mediaType);
  const outcome = await graphGet(FETCH_MEDIA_INSIGHTS, `${mediaId}/insights`, { metric: metrics.join(",") }, token, runtime, MediaInsightsSchema);
  if (outcome.status !== "ok" || !outcome.payload) return omitPayload(outcome);

  const data = outcome.payload.data;
  const valueOf = (name: string): number | null => {
    if (!metrics.includes(name)) return null; // not requested for this media type — never a guessed 0
    return data.find((d) => d.name === name)?.values?.[0]?.value ?? 0;
  };

  return {
    ...outcome,
    payload: {
      mediaId,
      reach: valueOf("reach"),
      views: valueOf("views"),
      saved: valueOf("saved"),
      shares: valueOf("shares"),
      follows: valueOf("follows"),
      profileVisits: valueOf("profile_visits"),
    },
  };
}

const FollowerCountSchema = z.object({ followers_count: z.number().optional() });

/**
 * The account's current follower total — a plain field, not an insights
 * metric. This is the natural first writer for karosCMO's
 * `clientFollowerSnapshots` (`src/lib/follower-tracking.ts`), which today has
 * none: "the moment an ingestion cron writes to clientFollowerSnapshots...
 * the audience cell lights up on its own with no further change" (that
 * module's own comment).
 */
export async function fetchFollowerCount(token: string, igUserId: string, runtime: GraphRuntime): Promise<MetaReadOutcome<number | null>> {
  const outcome = await graphGet(FETCH_FOLLOWER_COUNT, igUserId, { fields: "followers_count" }, token, runtime, FollowerCountSchema);
  if (outcome.status !== "ok" || !outcome.payload) return omitPayload(outcome);
  return { ...outcome, payload: outcome.payload.followers_count ?? null };
}

export { MEDIA_TYPES };
export { metricsForMediaType as __metricsForMediaType_forTests };
