import { createHash } from "node:crypto";
import type { Review } from "../triage/types.js";
import { unavailableLeg } from "./tombstone.js";
import type { CaptureLegOutcome, ReputationFetchImpl, YelpLegRequest } from "./types.js";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

interface YelpReviewApi {
  id: string;
  rating?: number;
  user?: { name?: string };
  text?: string;
  time_created?: string;
  url?: string;
}

/**
 * `capture_yelp` (capture.py): Yelp Fusion returns only the TOP 3 review
 * EXCERPTS, truncated to ~160 characters, chosen by Yelp — every record
 * carries `text_truncated: true` (ADAPTERS.md). Full Yelp coverage needs
 * the scrape fallback leg; there is no reply API (approved responses are
 * published by the business by hand at every autonomy level).
 */
export async function captureYelp(
  req: YelpLegRequest,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: ReputationFetchImpl,
): Promise<CaptureLegOutcome> {
  /** Every dead-leg exit from this adapter goes through here — ADAPTERS.md rule 1: a tombstone, never a silent zero. */
  const dead = (reason: string): CaptureLegOutcome =>
    unavailableLeg({ leg: "yelp", platform: "yelp", source: "yelp_fusion", listingId: req.listingId, listingLabel: req.listingLabel, reason });

  const key = env["YELP_API_KEY"];
  if (!key) {
    return dead("missing env YELP_API_KEY");
  }

  try {
    const url = `https://api.yelp.com/v3/businesses/${req.businessId}/reviews?limit=3&sort_by=newest`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) {
      return dead(`Yelp Fusion returned HTTP ${response.status}`);
    }
    const raw = await response.text();
    const data = JSON.parse(raw) as { reviews?: YelpReviewApi[] };
    const rawSha256 = sha256Hex(raw);

    const records: Review[] = (data.reviews ?? []).map((rev) => ({
      review_id: `yelp:${req.listingId}:${rev.id}`,
      platform: "yelp",
      source: "yelp_fusion",
      capture_tier: "MEASURED",
      listing_id: req.listingId,
      listing_label: req.listingLabel,
      rating: rev.rating ?? null,
      author: rev.user?.name ?? null,
      text: rev.text ?? null,
      created_at: `${(rev.time_created ?? "").replace(" ", "T")}Z`,
      url: rev.url ?? null,
      raw_sha256: rawSha256,
      text_truncated: true,
    }));

    return { leg: "yelp", status: "ok", reviews: records };
  } catch (err) {
    return dead(`Yelp Fusion request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
