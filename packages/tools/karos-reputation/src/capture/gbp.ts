import { createHash } from "node:crypto";
import { z } from "zod";
import { describeFetchFailure, fetchWithDeadline } from "./http.js";
import type { Review } from "../triage/types.js";
import { unavailableLeg } from "./tombstone.js";
import type { CaptureLegOutcome, ReputationFetchImpl, GbpLegRequest } from "./types.js";

const GBP_STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// SCRUM-296 (AU11): output validation at this external boundary. The page
// itself is validated as a whole (a body that isn't shaped like the GBP API
// contract at all is a leg failure, same as appstore.ts's feed schema) but
// each REVIEW is validated individually and a bad one is skipped rather than
// thrown: `rev.name.split("/")` below used to run on an un-narrowed cast, so
// one review missing `name` (a renamed/optional field on Google's side) threw
// past this file's per-page loop, was caught by captureGbp's outer try/catch,
// and turned the WHOLE leg — every review on every page already captured —
// into a single UNAVAILABLE tombstone. A malformed record is exactly the
// kind of partial failure this codebase otherwise treats as "skip it, keep
// going" (see appstore.ts's own rating-label handling); it should cost one
// review, not the leg.
const GbpReviewApiSchema = z.object({
  name: z.string().min(1),
  starRating: z.string().optional(),
  reviewer: z.object({ displayName: z.string().optional() }).optional(),
  comment: z.string().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  reviewReply: z.object({ comment: z.string().optional(), updateTime: z.string().optional() }).optional(),
});

const GbpApiResponseSchema = z.object({
  reviews: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});

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

      const response = await fetchWithDeadline(fetchImpl, url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        return dead(`GBP API returned HTTP ${response.status}`);
      }
      const raw = await response.text();
      const json: unknown = JSON.parse(raw);
      const parsed = GbpApiResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`GBP API response did not match the expected shape: ${parsed.error.message}`);
      }
      const rawSha256 = sha256Hex(raw);

      for (const rawReview of parsed.data.reviews ?? []) {
        const reviewParsed = GbpReviewApiSchema.safeParse(rawReview);
        if (!reviewParsed.success) continue; // one malformed review costs itself, not the leg
        const rev = reviewParsed.data;
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
      pageToken = parsed.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    return dead(describeFetchFailure(err, "the GBP API"));
  }

  return { leg: "gbp", status: "ok", reviews: records };
}
