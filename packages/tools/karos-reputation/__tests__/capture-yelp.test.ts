import { describe, expect, it, vi } from "vitest";
import { captureYelp } from "../src/capture/yelp.js";
import type { YelpLegRequest } from "../src/capture/types.js";

const baseReq: YelpLegRequest = { leg: "yelp", listingId: "fern-yelp", listingLabel: "Fern & Filter", inRoster: true, businessId: "biz-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("captureYelp (mocked Yelp Fusion key contract)", () => {
  it("reports UNAVAILABLE when YELP_API_KEY is missing", async () => {
    const fetchImpl = vi.fn();
    const outcome = await captureYelp(baseReq, {}, fetchImpl as unknown as typeof fetch);
    expect(outcome.leg).toBe("yelp");
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toBe("missing env YELP_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ADAPTERS.md rule 1: a dead leg is a tombstone, never a silent zero.
  it.each([
    ["a missing credential", {} as Record<string, string | undefined>, () => vi.fn(), "missing env YELP_API_KEY"],
    ["a non-2xx response", { YELP_API_KEY: "key" }, () => vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })), "HTTP 429"],
    ["a network exception", { YELP_API_KEY: "key" }, () => vi.fn().mockRejectedValue(new Error("ETIMEDOUT")), "ETIMEDOUT"],
  ])("emits exactly one UNAVAILABLE tombstone review on %s, never an empty reviews[]", async (_label, env, makeFetch, reasonFragment) => {
    const outcome = await captureYelp(baseReq, env, makeFetch() as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reviews).toHaveLength(1);
    const tombstone = outcome.reviews[0]!;
    expect(tombstone).toMatchObject({
      review_id: "yelp:fern-yelp:__unavailable__",
      platform: "yelp",
      source: "yelp_fusion",
      capture_tier: "UNAVAILABLE",
      rating: null,
    });
    expect(tombstone.unavailable_reason).toContain(reasonFragment);
    expect("annotations" in tombstone).toBe(false);
  });

  it("normalizes Fusion's excerpt reviews and always sets text_truncated: true (ADAPTERS.md: ~160-char excerpts only)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        reviews: [
          { id: "rev-1", rating: 1, user: { name: "T. B." }, text: "scam", time_created: "2026-07-17 14:00:00", url: "https://y/rev-1" },
        ],
      }),
    );
    const outcome = await captureYelp(baseReq, { YELP_API_KEY: "key" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews[0]).toMatchObject({
      review_id: "yelp:fern-yelp:rev-1",
      platform: "yelp",
      source: "yelp_fusion",
      capture_tier: "MEASURED",
      text_truncated: true,
      created_at: "2026-07-17T14:00:00Z",
    });
  });

  it("reports UNAVAILABLE on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const outcome = await captureYelp(baseReq, { YELP_API_KEY: "key" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("429");
  });
});
