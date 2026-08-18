import { createHash } from "node:crypto";
import type { Review } from "../triage/types.js";
import { unavailableLeg } from "./tombstone.js";
import type { CaptureLegOutcome, ReputationFetchImpl, GbpLegRequest } from "./types.js";

const GBP_STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

interface GbpReviewApi {
  name: string;
  starRating?: string;
  reviewer?: { displayName?: string };
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

/**
 * `capture_gbp` (capture.py): Google Business Profile API v4 reviews,
 * paginated. Requires Google-approved OAuth (`GOOGLE_BUSINESS_TOKEN`) —
 * until a client's credential lands, this leg reports `UNAVAILABLE` and the
 * caller falls back to the scrape leg or `manual_export` (ADAPTERS.md).
 */
export async function captureGbp(
  req: GbpLegRequest,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: ReputationFetchImpl,
): Promise<CaptureLegOutcome> {
  /** Every dead-leg exit from this adapter goes through here — ADAPTERS.md rule 1: a tombstone, never a silent zero. */
  const dead = (reason: string): CaptureLegOutcome =>
    unavailableLeg({ leg: "gbp", platform: "google", source: "gbp_api", listingId: req.listingId, listingLabel: req.listingLabel, reason });

  const token = env["GOOGLE_BUSINESS_TOKEN"];
  if (!token) {
    return dead("missing env GOOGLE_BUSINESS_TOKEN");
  }

  const records: Review[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const url = new URL(`https://mybusiness.googleapis.com/v4/accounts/${req.account}/locations/${req.location}/reviews`);
      url.searchParams.set("pageSize", "50");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        return dead(`GBP API returned HTTP ${response.status}`);
      }
      const raw = await response.text();
      const data = JSON.parse(raw) as { reviews?: GbpReviewApi[]; nextPageToken?: string };
      const rawSha256 = sha256Hex(raw);

      for (const rev of data.reviews ?? []) {
        const reply = rev.reviewReply;
        records.push({
          review_id: `google:${req.listingId}:${rev.name.split("/").pop()}`,
          platform: "google",
          source: "gbp_api",
          capture_tier: "MEASURED",
          listing_id: req.listingId,
          listing_label: req.listingLabel,
          rating: rev.starRating ? (GBP_STARS[rev.starRating] ?? null) : null,
          author: rev.reviewer?.displayName ?? null,
          author_badge: null, // GBP v4 does not expose Local Guide status; scrape legs may fill it
          text: rev.comment ?? null,
          created_at: rev.createTime ?? "",
          updated_at: rev.updateTime ?? null,
          owner_response: reply ? { text: reply.comment ?? "", responded_at: reply.updateTime ?? "" } : null,
          raw_sha256: rawSha256,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    return dead(`GBP API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { leg: "gbp", status: "ok", reviews: records };
}
