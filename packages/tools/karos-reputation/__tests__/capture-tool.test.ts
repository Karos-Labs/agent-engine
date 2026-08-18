import { describe, expect, it, vi } from "vitest";
import { createReputationCapture } from "../src/capture/capture-tool.js";

const ctx = { runId: "run_1", clientSlug: "acme", productId: "reputation-agent", runKind: "recurring" as const, metadata: {} };

describe("reputation.capture (aggregates every leg behind the three-outcome contract)", () => {
  it("skips a leg not in the client's roster without touching the network at all (ADAPTERS.md rule 3: no leg invention)", async () => {
    const fetchImpl = vi.fn();
    const tool = createReputationCapture({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await tool.execute(
      { legs: [{ leg: "gbp", listingId: "loc-1", listingLabel: "Main", inRoster: false, account: "a", location: "l" }] },
      { ctx },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.legs).toEqual([{ leg: "gbp", status: "not_in_roster", reviews: [] }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs manual_export with zero network dependency alongside a credential-gapped leg", async () => {
    const tool = createReputationCapture({ env: {}, fetchImpl: vi.fn() as unknown as typeof fetch });
    const outcome = await tool.execute(
      {
        legs: [
          { leg: "yelp", listingId: "fern-yelp", listingLabel: "Fern & Filter", inRoster: true, businessId: "biz-1" },
          {
            leg: "manual_export",
            listingId: "fern-csv",
            listingLabel: "Fern & Filter",
            inRoster: true,
            rows: [{ review_id: "google:fern-csv:rev-1", platform: "google", created_at: "2026-07-01T00:00:00Z" }],
          },
        ],
      },
      { ctx },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const [yelpOutcome, manualOutcome] = outcome.result.legs;
    expect(yelpOutcome).toMatchObject({ leg: "yelp", status: "UNAVAILABLE" });
    expect(manualOutcome).toMatchObject({ leg: "manual_export", status: "ok" });
    expect(manualOutcome!.reviews[0]).toMatchObject({ source: "manual_export", capture_tier: "MEASURED" });
  });
});
