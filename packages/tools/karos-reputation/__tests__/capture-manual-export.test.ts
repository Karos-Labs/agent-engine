import { describe, expect, it } from "vitest";
import { captureManualExport } from "../src/capture/manual-export.js";
import type { ManualExportLegRequest } from "../src/capture/types.js";

describe("captureManualExport (ADAPTERS.md: \"always the floor\" — a client with zero connected APIs can still run)", () => {
  it("forces source, and defaults an unstated capture_tier to MEASURED", () => {
    const req: ManualExportLegRequest = {
      leg: "manual_export",
      listingId: "biz-1",
      listingLabel: "Biz",
      inRoster: true,
      rows: [
        {
          review_id: "trustpilot:biz-1:rev-1",
          platform: "trustpilot",
          source: "apify_scrape" as never, // a caller claiming a different source is overridden
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
    };
    const outcome = captureManualExport(req);
    expect(outcome.status).toBe("ok");
    expect(outcome.reviews[0]).toMatchObject({ source: "manual_export", capture_tier: "MEASURED" });
  });

  // ADAPTERS.md rule 1: "Tier is set at capture and never upgraded." Stamping
  // MEASURED over a stated tier upgrades every one of them — including an
  // UNAVAILABLE tombstone a caller hand-carries in from a dead leg, which was
  // previously the ONLY thing standing between a tombstone and `triage()`.
  it.each(["ESTIMATED", "UNAVAILABLE"] as const)("preserves a caller-supplied %s capture_tier rather than upgrading it to MEASURED", (tier) => {
    const req: ManualExportLegRequest = {
      leg: "manual_export",
      listingId: "biz-1",
      listingLabel: "Biz",
      inRoster: true,
      rows: [
        {
          review_id: `trustpilot:biz-1:${tier === "UNAVAILABLE" ? "__unavailable__" : "rev-2"}`,
          platform: "trustpilot",
          capture_tier: tier,
          created_at: "2026-07-01T00:00:00Z",
          ...(tier === "UNAVAILABLE" ? { unavailable_reason: "export tool could not reach Trustpilot" } : {}),
        },
      ],
    };
    const outcome = captureManualExport(req);
    expect(outcome.reviews[0]!.capture_tier).toBe(tier);
    expect(outcome.reviews[0]!.source).toBe("manual_export");
  });

  it("an empty export is an honest ok, not a failure", () => {
    const req: ManualExportLegRequest = { leg: "manual_export", listingId: "biz-1", listingLabel: "Biz", inRoster: true, rows: [] };
    expect(captureManualExport(req)).toEqual({ leg: "manual_export", status: "ok", reviews: [] });
  });
});
