import { describe, expect, it } from "vitest";
import type { GraphRuntime } from "../src/graph-client.js";
import { fetchFollowerCount, fetchMediaInsights, listRecentMedia, resolveInstagramBusinessAccountId } from "../src/insights.js";
import { createKarosMetaTools } from "../src/index.js";

/**
 * ## Why this mock is a router and not a stub
 *
 * Same reasoning as `karos-connectors/__tests__/connectors.test.ts`: a fake
 * that answers the same canned object regardless of what was asked proves
 * only that the code can read a variable. This router checks the path and
 * the `access_token`/`metric`/`fields` query params each call actually sends,
 * and answers with Meta's real error envelope shape when told to fail.
 */

const SYSTEM_USER_TOKEN = "EAAtest-system-user-token";
const PAGE_ID = "1234567890";
const IG_USER_ID = "17841400000000000";

interface RecordedCall {
  url: URL;
}

interface MockOptions {
  /** HTTP status to answer for a given route id; absent means 200 with the real payload. */
  statusFor?: Record<string, number>;
  /** Meta error body to serve alongside a non-200 status. */
  errorBodyFor?: Record<string, { code?: number; error_subcode?: number; message?: string }>;
}

function metaApiMock(options: MockOptions = {}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const classify = (url: URL): string => {
    if (url.pathname === `/v20.0/${PAGE_ID}`) return "resolveAccount";
    if (url.pathname === `/v20.0/${IG_USER_ID}/media`) return "listMedia";
    if (url.pathname.endsWith("/insights")) return "mediaInsights";
    if (url.pathname === `/v20.0/${IG_USER_ID}`) return "followerCount";
    return `unrouted:${url.pathname}`;
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ url });
    const routeId = classify(url);

    const status = options.statusFor?.[routeId];
    if (status !== undefined && status !== 200) {
      const errBody = options.errorBodyFor?.[routeId] ?? { message: `injected ${status}` };
      return json({ error: errBody }, status);
    }

    switch (routeId) {
      case "resolveAccount":
        return json({ instagram_business_account: { id: IG_USER_ID } });
      case "listMedia":
        return json({
          data: [
            { id: "media-feed-1", media_type: "IMAGE", timestamp: "2026-09-10T10:00:00+0000", permalink: "https://instagram.com/p/1" },
            { id: "media-reel-1", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-12T10:00:00+0000" },
          ],
        });
      case "mediaInsights": {
        const requested = (url.searchParams.get("metric") ?? "").split(",").filter(Boolean);
        const values: Record<string, number> = { reach: 500, views: 900, saved: 12, shares: 4, follows: 3, profile_visits: 7 };
        return json({ data: requested.map((name) => ({ name, values: [{ value: values[name] ?? 0 }] })) });
      }
      case "followerCount":
        return json({ followers_count: 12_345 });
      default:
        return json({ error: { message: `unrouted ${url.pathname}` } }, 404);
    }
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function runtimeFor(fetchImpl: typeof fetch): GraphRuntime {
  return { fetchImpl, policy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, retryableStatuses: [], maxRetryAfterMs: 0 } };
}

describe("resolveInstagramBusinessAccountId", () => {
  it("resolves the linked Instagram account id from a Page id", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await resolveInstagramBusinessAccountId(SYSTEM_USER_TOKEN, PAGE_ID, runtimeFor(fetchImpl));
    expect(outcome).toEqual({ method: "resolveInstagramBusinessAccount", status: "ok", payload: IG_USER_ID, attempts: 1 });
    expect(calls[0]!.url.searchParams.get("access_token")).toBe(SYSTEM_USER_TOKEN);
    expect(calls[0]!.url.searchParams.get("fields")).toBe("instagram_business_account");
  });

  it("returns null, not an error, when the Page has no linked Instagram account", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const outcome = await resolveInstagramBusinessAccountId(SYSTEM_USER_TOKEN, PAGE_ID, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toBeNull();
  });

  it("reports a dead-token hint on a 190 without retrying", async () => {
    const { fetchImpl, calls } = metaApiMock({
      statusFor: { resolveAccount: 401 },
      errorBodyFor: { resolveAccount: { code: 190, message: "Error validating access token" } },
    });
    const outcome = await resolveInstagramBusinessAccountId(SYSTEM_USER_TOKEN, PAGE_ID, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("dead or was revoked");
    expect(outcome.reason).toContain("Error validating access token");
    expect(calls).toHaveLength(1); // 401 is not in the (empty) retryableStatuses list here, and isn't retryable by DEFAULT_RETRY_POLICY either
  });

  it("reports an App Review hint on Meta's permission-pending shape", async () => {
    const { fetchImpl } = metaApiMock({
      statusFor: { resolveAccount: 403 },
      errorBodyFor: { resolveAccount: { code: 10, message: "Application does not have permission for this action" } },
    });
    const outcome = await resolveInstagramBusinessAccountId(SYSTEM_USER_TOKEN, PAGE_ID, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("has not cleared Meta App Review yet");
  });
});

describe("listRecentMedia", () => {
  it("normalizes media_product_type into the mediaType the caller needs for metricsForMediaType", async () => {
    const { fetchImpl } = metaApiMock();
    const outcome = await listRecentMedia(SYSTEM_USER_TOKEN, IG_USER_ID, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toEqual([
      { id: "media-feed-1", mediaType: "FEED", timestamp: "2026-09-10T10:00:00+0000", permalink: "https://instagram.com/p/1" },
      { id: "media-reel-1", mediaType: "REELS", timestamp: "2026-09-12T10:00:00+0000" },
    ]);
  });
});

describe("fetchMediaInsights", () => {
  it("returns all six metrics for a FEED post", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await fetchMediaInsights(SYSTEM_USER_TOKEN, "media-feed-1", "FEED", runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toEqual({ mediaId: "media-feed-1", reach: 500, views: 900, saved: 12, shares: 4, follows: 3, profileVisits: 7 });
    expect(calls[0]!.url.searchParams.get("metric")).toBe("reach,views,shares,saved,follows,profile_visits");
  });

  it("never requests follows/profile_visits for a Reel, and reports them null rather than 0", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await fetchMediaInsights(SYSTEM_USER_TOKEN, "media-reel-1", "REELS", runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toEqual({ mediaId: "media-reel-1", reach: 500, views: 900, saved: 12, shares: 4, follows: null, profileVisits: null });
    const requestedMetrics = calls[0]!.url.searchParams.get("metric")!.split(",");
    expect(requestedMetrics).not.toContain("follows");
    expect(requestedMetrics).not.toContain("profile_visits");
  });

  it("never requests saved for a Story, and reports it null", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await fetchMediaInsights(SYSTEM_USER_TOKEN, "media-story-1", "STORY", runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.saved).toBeNull();
    expect(calls[0]!.url.searchParams.get("metric")!.split(",")).not.toContain("saved");
  });
});

describe("fetchFollowerCount", () => {
  it("reads the account's current follower total", async () => {
    const { fetchImpl } = metaApiMock();
    const outcome = await fetchFollowerCount(SYSTEM_USER_TOKEN, IG_USER_ID, runtimeFor(fetchImpl));
    expect(outcome).toEqual({ method: "fetchFollowerCount", status: "ok", payload: 12_345, attempts: 1 });
  });
});

describe("createKarosMetaTools", () => {
  it("reports not_available when no META_SYSTEM_USER_TOKEN is configured, without making a network call", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const tools = createKarosMetaTools({ env: {}, fetchImpl });
    const context = { ctx: { runId: "test-run", clientSlug: "test-client", productId: "test-product" } } as Parameters<
      (typeof tools)["meta.fetchFollowerCount"]["execute"]
    >[1];
    const outcome = await tools["meta.fetchFollowerCount"]!.execute({ igUserId: IG_USER_ID }, context);
    expect(outcome.status).toBe("not_available");
    expect(calls).toHaveLength(0);
  });

  it("reaches the Graph API once a token is configured", async () => {
    const { fetchImpl } = metaApiMock();
    const tools = createKarosMetaTools({ env: { META_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN }, fetchImpl });
    const context = { ctx: { runId: "test-run", clientSlug: "test-client", productId: "test-product" } } as Parameters<
      (typeof tools)["meta.fetchFollowerCount"]["execute"]
    >[1];
    const outcome = await tools["meta.fetchFollowerCount"]!.execute({ igUserId: IG_USER_ID }, context);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.result).toEqual({ method: "fetchFollowerCount", status: "ok", payload: 12_345, attempts: 1 });
    }
  });
});
