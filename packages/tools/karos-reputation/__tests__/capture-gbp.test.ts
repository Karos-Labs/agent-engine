import { describe, expect, it, vi } from "vitest";
import { captureGbp } from "../src/capture/gbp.js";
import type { GbpLegRequest } from "../src/capture/types.js";

const baseReq: GbpLegRequest = { leg: "gbp", listingId: "loc-main", listingLabel: "Main St", inRoster: true, account: "acc-1", location: "loc-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("captureGbp (mocked Google-approved OAuth contract)", () => {
  it("reports UNAVAILABLE when GOOGLE_BUSINESS_TOKEN is missing — the honest credential-gap state", async () => {
    const fetchImpl = vi.fn();
    const outcome = await captureGbp(baseReq, {}, fetchImpl as unknown as typeof fetch);
    expect(outcome.leg).toBe("gbp");
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toBe("missing env GOOGLE_BUSINESS_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ADAPTERS.md rule 1 / run-protocol.md §7: "A dead leg emits an UNAVAILABLE
  // tombstone for the run record, never a silent zero" — a zero is read
  // downstream as "nothing to answer", the opposite fact.
  it.each([
    ["a missing credential", {} as Record<string, string | undefined>, () => vi.fn(), "missing env GOOGLE_BUSINESS_TOKEN"],
    [
      "a non-2xx response",
      { GOOGLE_BUSINESS_TOKEN: "tok" },
      () => vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
      "HTTP 403",
    ],
    ["a network exception", { GOOGLE_BUSINESS_TOKEN: "tok" }, () => vi.fn().mockRejectedValue(new Error("ECONNRESET")), "ECONNRESET"],
  ])("emits exactly one UNAVAILABLE tombstone review on %s, never an empty reviews[]", async (_label, env, makeFetch, reasonFragment) => {
    const outcome = await captureGbp(baseReq, env, makeFetch() as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reviews).toHaveLength(1);
    const tombstone = outcome.reviews[0]!;
    expect(tombstone).toMatchObject({
      review_id: "google:loc-main:__unavailable__",
      platform: "google",
      source: "gbp_api",
      capture_tier: "UNAVAILABLE",
      listing_id: "loc-main",
      rating: null,
      text: null,
    });
    expect(tombstone.unavailable_reason).toContain(reasonFragment);
    // A tombstone is never classified — `annotations` is absent, not null.
    expect("annotations" in tombstone).toBe(false);
  });

  it("maps a real GBP API response into the normalized record shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        reviews: [
          {
            name: "accounts/1/locations/1/reviews/rev-1",
            starRating: "TWO",
            reviewer: { displayName: "J. D." },
            comment: "Waited too long.",
            createTime: "2026-07-12T18:03:00Z",
            reviewReply: { comment: "Sorry to hear this.", updateTime: "2026-07-13T09:00:00Z" },
          },
        ],
      }),
    );
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]).toMatchObject({
      review_id: "google:loc-main:rev-1",
      platform: "google",
      source: "gbp_api",
      capture_tier: "MEASURED",
      rating: 2,
      author: "J. D.",
      owner_response: { text: "Sorry to hear this.", responded_at: "2026-07-13T09:00:00Z" },
    });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer tok" } });
  });

  it("paginates via nextPageToken until exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ reviews: [{ name: "a/b/reviews/r1", starRating: "FIVE" }], nextPageToken: "p2" }))
      .mockResolvedValueOnce(jsonResponse({ reviews: [{ name: "a/b/reviews/r2", starRating: "ONE" }] }));
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.reviews.map((r) => r.review_id)).toEqual(["google:loc-main:r1", "google:loc-main:r2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports UNAVAILABLE on a non-2xx response, never throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("403");
  });

  it("reports UNAVAILABLE on a network exception, never throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("ECONNRESET");
  });

  // SCRUM-296 (AU11): one malformed review record must cost itself, not the
  // whole leg. Before this ticket, `rev.name.split("/")` ran on a bare cast
  // with no narrowing — a review missing `name` threw, was caught by
  // `captureGbp`'s outer try/catch, and turned an otherwise-successful page
  // (with a perfectly good sibling review) into a single UNAVAILABLE
  // tombstone that discarded every review already captured.
  it("skips a malformed review (missing name) and keeps the rest of the page, rather than failing the whole leg", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        reviews: [
          { starRating: "ONE", comment: "no name field at all — a shape the real API has never sent, but the boundary must not trust that" },
          { name: "accounts/1/locations/1/reviews/rev-good", starRating: "FIVE", comment: "Great!" },
        ],
      }),
    );
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]).toMatchObject({ review_id: "google:loc-main:rev-good", rating: 5 });
  });

  it("reports UNAVAILABLE when the response body is valid JSON but not shaped like the GBP contract (e.g. reviews is a string, not an array)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ reviews: "not an array" }));
    const outcome = await captureGbp(baseReq, { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.reviews[0]!.capture_tier).toBe("UNAVAILABLE");
  });
});
