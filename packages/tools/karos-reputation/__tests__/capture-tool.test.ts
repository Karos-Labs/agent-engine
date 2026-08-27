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
          { leg: "gbp", listingId: "fern-gbp", listingLabel: "Fern & Filter", inRoster: true, account: "a", location: "l" },
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
    const [gbpOutcome, manualOutcome] = outcome.result.legs;
    expect(gbpOutcome).toMatchObject({ leg: "gbp", status: "UNAVAILABLE" });
    expect(manualOutcome).toMatchObject({ leg: "manual_export", status: "ok" });
    expect(manualOutcome!.reviews[0]).toMatchObject({ source: "manual_export", capture_tier: "MEASURED" });
  });

  it("preserves every sibling leg's outcome when one leg's network request fails (a tooling-isolation audit finding)", async () => {
    // gbp is credential-gapped (its adapter tombstones before ever calling fetch),
    // appstore's own fetch rejects outright, and manual_export SUCCEEDS — none of
    // this may abort the call and erase the others' outcomes. The successful leg is
    // the one that matters: a failure that discards captured data is worse than a
    // failure that discards tombstones.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const tool = createReputationCapture({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await tool.execute(
      {
        legs: [
          { leg: "gbp", listingId: "loc-1", listingLabel: "Main", inRoster: true, account: "a", location: "l" },
          { leg: "appstore", listingId: "app-1", listingLabel: "App", inRoster: true, appId: "123", country: "us", maxPages: 10 },
          {
            leg: "manual_export",
            listingId: "loc-1-csv",
            listingLabel: "Main",
            inRoster: true,
            rows: [{ review_id: "google:loc-1-csv:rev-1", platform: "google", created_at: "2026-07-01T00:00:00Z" }],
          },
        ],
      },
      { ctx },
    );

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.legs).toHaveLength(3);
    expect(outcome.result.legs.map((l) => l.leg)).toEqual(["gbp", "appstore", "manual_export"]);
    expect(outcome.result.legs.map((l) => l.status)).toEqual(["UNAVAILABLE", "UNAVAILABLE", "ok"]);
    // Every leg still carries its own review row — a tombstone for the two that
    // failed, the real exported row for the one that did not.
    expect(outcome.result.legs.every((l) => l.reviews.length === 1)).toBe(true);
  });
});
