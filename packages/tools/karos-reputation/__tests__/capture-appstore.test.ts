import { describe, expect, it, vi } from "vitest";
import { captureAppstore } from "../src/capture/appstore.js";
import type { AppstoreLegRequest } from "../src/capture/types.js";

const baseReq: AppstoreLegRequest = { leg: "appstore", listingId: "zumo-ios", listingLabel: "Zumo (iOS)", inRoster: true, appId: "123", country: "us", maxPages: 10 };

function feedResponse(entries: unknown[] | unknown): Response {
  return new Response(JSON.stringify({ feed: { entry: entries } }), { status: 200 });
}

function lookupResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const metaEntry = { "im:name": { label: "app meta, no rating" } };
function reviewEntry(id: string, rating: number, text = "Great app") {
  return {
    "im:rating": { label: String(rating) },
    id: { label: id },
    author: { name: { label: "quietseeker" } },
    title: { label: "Nice" },
    content: { label: text },
    updated: { label: "2026-07-19T09:00:00-07:00" },
  };
}

const noDelay = () => Promise.resolve();

describe("captureAppstore (the one keyless leg — genuinely testable, no credentials involved)", () => {
  it("paginates the RSS feed and stops at the first empty page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([metaEntry, reviewEntry("r1", 4)])) // page 1
      .mockResolvedValueOnce(feedResponse([reviewEntry("r2", 5)])) // page 2
      .mockResolvedValueOnce(feedResponse([])); // page 3, empty -> stop
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews.map((r) => r.review_id)).toEqual(["appstore:zumo-ios:r1", "appstore:zumo-ios:r2"]);
    // Stops once a page yields zero reviews — the lookup call for listingMeta is the only extra call.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("normalizes a single-entry page where the feed returns a dict instead of an array", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(reviewEntry("solo", 3))) // a bare object, not wrapped in an array
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(lookupResponse({ resultCount: 1, results: [{ averageUserRating: 4.2, userRatingCount: 100 }] }));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]!.review_id).toBe("appstore:zumo-ios:solo");
  });

  it("retries once when the first pass returns zero entries, and succeeds on the retry (the documented flakiness)", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([])) // first attempt, page 1: flaky empty
      .mockResolvedValueOnce(feedResponse([reviewEntry("r1", 4)])) // retry, page 1: succeeds
      .mockResolvedValueOnce(feedResponse([])); // retry, page 2: stop
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, delay);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews).toHaveLength(1);
    expect(delay).toHaveBeenCalledOnce();
  });

  it("reports UNAVAILABLE (never a fabricated zero) when both attempts are empty but the storefront reports real ratings", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([])) // first attempt
      .mockResolvedValueOnce(feedResponse([])) // retry
      .mockResolvedValueOnce(lookupResponse({ resultCount: 1, results: [{ averageUserRating: 4.7, userRatingCount: 5_300_000 }] }));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("5300000");
    // capture.py's own appstore leg returns `[record(..., capture_tier="UNAVAILABLE",
    // unavailable_reason=...)]` here — a tombstone, never an empty list.
    expect(outcome.reviews).toHaveLength(1);
    const tombstone = outcome.reviews[0]!;
    expect(tombstone).toMatchObject({
      review_id: "appstore:zumo-ios:__unavailable__",
      platform: "appstore",
      source: "appstore_rss",
      capture_tier: "UNAVAILABLE",
      rating: null,
    });
    expect(tombstone.unavailable_reason).toContain("5300000");
    expect("annotations" in tombstone).toBe(false);
  });

  it("reports an honest empty capture (status ok, zero reviews) when the storefront genuinely has no ratings", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(lookupResponse({ resultCount: 1, results: [{ averageUserRating: null, userRatingCount: 0 }] }));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews).toEqual([]);
  });

  it("reports UNAVAILABLE when the storefront lookup says the app isn't listed there at all", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(lookupResponse({ resultCount: 0 }));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("not found in storefront");
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]).toMatchObject({ review_id: "appstore:zumo-ios:__unavailable__", capture_tier: "UNAVAILABLE" });
  });

  it("falls back to whatever it captured (even zero) when the lookup cross-check itself fails, rather than blocking on it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([]))
      .mockResolvedValueOnce(feedResponse([]))
      .mockRejectedValueOnce(new Error("lookup down"));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews).toEqual([]);
    expect(outcome.listingMeta).toBeUndefined();
  });

  it("reports UNAVAILABLE (never an uncaught throw) when the feed request itself fails on both attempts — a tooling-isolation audit finding", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("ECONNRESET");
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]).toMatchObject({ review_id: "appstore:zumo-ios:__unavailable__", capture_tier: "UNAVAILABLE" });
  });

  it("reports UNAVAILABLE (never an uncaught throw) when the feed returns a 200 with malformed JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    const outcome = await captureAppstore(baseReq, fetchImpl as unknown as typeof fetch, noDelay);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reviews).toHaveLength(1);
  });
});
