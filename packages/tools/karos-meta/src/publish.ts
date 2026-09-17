import { z } from "zod";
import { graphGet, graphPost, omitPayload, type GraphRuntime } from "./graph-client.js";
import type { InstagramImagePostInput, MetaPublishResult, MetaReadOutcome } from "./types.js";

/**
 * Instagram publish — Graph API container flow. Server-side, agent-driven,
 * INTERNAL ONLY.
 *
 * ## Scope: Instagram, never a standalone Facebook Page post
 *
 * This file deliberately has no `publishFacebookFeedPost`/`/feed` call. An
 * Instagram professional account can only be reached through the Facebook
 * Graph API (it is always linked via a Page), so the Graph API is this
 * package's transport either way — but a function that posts directly to a
 * client's Facebook Page feed would make Facebook itself a product this
 * package can push content to, which is the exact thing "portal feedback
 * round 2, 2026-09: we don't work with Facebook" (`platforms.ts`) took off
 * the table. Albert confirmed this read on 2026-09-16: keep Instagram
 * publishing, drop the standalone Facebook Page post. If a client-facing
 * Facebook publish target is ever wanted again, that is a separate, explicit
 * product decision to reverse — not something to slip back in here because
 * the transport happens to support it.
 *
 * ## Internal-only, and off by default
 *
 * No new client-facing "Connect" flow exists anywhere for this — clients
 * already granted Karos Labs access for `instagram_insights` (`platforms.ts`)
 * via the Business Manager partner model, and that is the same grant this
 * file's calls run under. There is nothing for a client to additionally
 * "turn on" to make posting possible; it is Karos Labs staff/agents choosing
 * to use `meta.publishInstagramPost`, gated by `META_PUBLISH_ENABLED`
 * (`index.ts`) so a deployment can carry the code without it being reachable
 * yet — the explicit request was "write it now, don't let it actually post
 * until I say so in chat".
 *
 * ## Not yet handled: video/Reels, carousels
 *
 * Meta's container flow for `VIDEO`/`REELS`/carousel media needs polling
 * `{container-id}?fields=status_code` until `FINISHED` before
 * `media_publish` will succeed (an image container is normally ready
 * immediately, but Meta does not formally guarantee that — see
 * `waitForContainerReady` below, which this file always calls rather than
 * assuming). Extending `createInstagramMediaContainer` to accept
 * `video_url`/`media_type: REELS`/children ids is a follow-up once a caller
 * actually needs it — this cut covers the single-image post the request
 * described.
 */

export const CREATE_INSTAGRAM_MEDIA_CONTAINER = "createInstagramMediaContainer";
export const PUBLISH_INSTAGRAM_MEDIA_CONTAINER = "publishInstagramMediaContainer";
export const PUBLISH_INSTAGRAM_IMAGE_POST = "publishInstagramImagePost";

const MediaContainerCreatedSchema = z.object({ id: z.string() });

/**
 * `instagram_content_publish`, step 1 of 2: stage the image + caption as a
 * container. This does NOT post anything yet — nothing is visible on the
 * client's account until `publishInstagramMediaContainer` succeeds.
 */
export async function createInstagramMediaContainer(
  token: string,
  igUserId: string,
  input: InstagramImagePostInput,
  runtime: GraphRuntime,
): Promise<MetaReadOutcome<string>> {
  const params: Record<string, string> = { image_url: input.imageUrl };
  if (input.caption) params.caption = input.caption;
  const outcome = await graphPost(CREATE_INSTAGRAM_MEDIA_CONTAINER, `${igUserId}/media`, params, token, runtime, MediaContainerCreatedSchema);
  if (outcome.status !== "ok" || !outcome.payload) return omitPayload(outcome);
  return { ...outcome, payload: outcome.payload.id };
}

const ContainerStatusSchema = z.object({ status_code: z.string().optional(), status: z.string().optional() });

/**
 * Polls the container until Meta says it's ready to publish (`FINISHED`) or
 * gives up after `maxAttempts`. An image container is typically ready on the
 * first check, but this never assumes that — calling `media_publish` on a
 * container still `IN_PROGRESS` is a Graph API error, so this is the one
 * place that wait lives rather than every caller reimplementing it.
 */
export async function waitForContainerReady(
  token: string,
  containerId: string,
  runtime: GraphRuntime,
  options: { maxAttempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MetaReadOutcome<"FINISHED">> {
  const maxAttempts = options.maxAttempts ?? 5;
  const delayMs = options.delayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastAttempts: number | undefined;
  let lastStatusCode: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await graphGet("waitForContainerReady", containerId, { fields: "status_code,status" }, token, runtime, ContainerStatusSchema);
    lastAttempts = current.attempts;
    if (current.status !== "ok") return omitPayload(current);
    const statusCode = current.payload?.status_code;
    lastStatusCode = statusCode;
    if (statusCode === "FINISHED") return { ...omitPayload(current), payload: "FINISHED" };
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      return {
        method: "waitForContainerReady",
        status: "UNAVAILABLE",
        reason: `Meta reported the media container as ${statusCode} before it could be published`,
        ...(current.attempts !== undefined ? { attempts: current.attempts } : {}),
      };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return {
    method: "waitForContainerReady",
    status: "UNAVAILABLE",
    reason: `the media container did not reach FINISHED within ${maxAttempts} checks (last status: ${lastStatusCode ?? "unknown"})`,
    ...(lastAttempts !== undefined ? { attempts: lastAttempts } : {}),
  };
}

const MediaPublishedSchema = z.object({ id: z.string() });

/**
 * `instagram_content_publish`, step 2 of 2: THE call that makes the post go
 * live on the client's account. Everything before this point is reversible
 * (an un-published container simply expires); this is not.
 */
export async function publishInstagramMediaContainer(token: string, igUserId: string, containerId: string, runtime: GraphRuntime): Promise<MetaReadOutcome<string>> {
  const outcome = await graphPost(PUBLISH_INSTAGRAM_MEDIA_CONTAINER, `${igUserId}/media_publish`, { creation_id: containerId }, token, runtime, MediaPublishedSchema);
  if (outcome.status !== "ok" || !outcome.payload) return omitPayload(outcome);
  return { ...outcome, payload: outcome.payload.id };
}

const PermalinkSchema = z.object({ permalink: z.string().optional() });

/**
 * The full create → wait → publish orchestration for one image post. This is
 * the one function `index.ts`'s `meta.publishInstagramPost` tool calls — the
 * three-call sequence lives here so the tool layer stays a thin gate-check
 * plus a single call, and so a future caller (a workflow step, not just the
 * tool) gets the same correct sequencing without re-deriving it.
 */
export async function publishInstagramImagePost(token: string, igUserId: string, input: InstagramImagePostInput, runtime: GraphRuntime): Promise<MetaReadOutcome<MetaPublishResult>> {
  const container = await createInstagramMediaContainer(token, igUserId, input, runtime);
  if (container.status !== "ok" || !container.payload) return { ...omitPayload(container), method: PUBLISH_INSTAGRAM_IMAGE_POST };

  const ready = await waitForContainerReady(token, container.payload, runtime);
  if (ready.status !== "ok") return { ...omitPayload(ready), method: PUBLISH_INSTAGRAM_IMAGE_POST };

  const published = await publishInstagramMediaContainer(token, igUserId, container.payload, runtime);
  if (published.status !== "ok" || !published.payload) return { ...omitPayload(published), method: PUBLISH_INSTAGRAM_IMAGE_POST };

  // Best-effort: the post is already live at this point regardless of whether
  // this lookup succeeds, so a failure here degrades to "no permalink"
  // rather than reporting the whole publish as failed.
  const permalinkOutcome = await graphGet("fetchPublishedPermalink", published.payload, { fields: "permalink" }, token, runtime, PermalinkSchema);
  const permalink = permalinkOutcome.status === "ok" ? permalinkOutcome.payload?.permalink : undefined;

  return {
    method: PUBLISH_INSTAGRAM_IMAGE_POST,
    status: "ok",
    attempts: (container.attempts ?? 0) + (ready.attempts ?? 0) + (published.attempts ?? 0) + (permalinkOutcome.attempts ?? 0),
    payload: { mediaId: published.payload, ...(permalink ? { permalink } : {}) },
  };
}
