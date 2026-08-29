import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchWithDeadline } from "./http.js";
import type { Review } from "../triage/types.js";
import { captureNowIso as nowIso, unavailableLeg } from "./tombstone.js";
import type { AppstoreLegRequest, CaptureLegOutcome, ReputationFetchImpl } from "./types.js";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// SCRUM-296 (AU11): output validation at this external boundary. Apple's RSS
// feed and lookup endpoints are the audit's own named example — an
// `"im:rating"` label of `"N/A"` (a real value Apple returns for a
// storefront that hides ratings) went through `Number.parseInt(...)` with no
// check on the result, turning into `NaN` and landing, un-flagged, in a
// `Review.rating` field every downstream aggregate (`baseline_rating_avg`,
// rating-dip detection) then does arithmetic on. `RatingLabelSchema` below
// is the fix: a label that is not a plain "1".."5" digit string safeParses
// to `undefined`, which this file turns into `rating: null` — the same
// "no rating" representation `gbp.ts` already uses for its own rating
// lookup miss, and a value `ReviewSchema` (`triage/types.ts`) already
// declares valid. The two response schemas below do the same for the
// response's own top-level shape: a page that 200s with JSON that is not
// shaped like Apple's feed/lookup contract is a parse failure, not a
// zero-review page (ADAPTERS.md rule 1 — a tombstone, never a silent zero).
const RssEntrySchema = z.object({
  "im:rating": z.object({ label: z.string() }).optional(),
  id: z.object({ label: z.string() }).optional(),
  author: z.object({ name: z.object({ label: z.string().optional() }).optional() }).optional(),
  title: z.object({ label: z.string().optional() }).optional(),
  content: z.object({ label: z.string().optional() }).optional(),
  updated: z.object({ label: z.string().optional() }).optional(),
});
type RssEntry = z.infer<typeof RssEntrySchema>;

const RssFeedResponseSchema = z.object({
  feed: z
    .object({
      entry: z.union([RssEntrySchema, z.array(RssEntrySchema)]).optional(),
    })
    .optional(),
});

/**
 * Apple's real rating labels are plain digit strings ("1".."5"). `"N/A"` and
 * anything else that is not one of those five values safeParses to
 * `undefined` here rather than silently becoming `NaN` via `Number.parseInt`.
 */
const RatingLabelSchema = z
  .string()
  .regex(/^[1-5]$/)
  .transform((label) => Number.parseInt(label, 10));

const LookupResponseSchema = z.object({
  resultCount: z.number().optional(),
  results: z
    .array(
      z.object({
        averageUserRating: z.number().nullable().optional(),
        userRatingCount: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

interface LookupResult {
  listed: boolean;
  official_rating_avg?: number | null;
  official_rating_count?: number | null;
}

/** The second keyless Apple endpoint: official rating + rating count for the storefront — tells "genuinely no reviews" apart from "the RSS feed is flaking" (ADAPTERS.md's documented 2026-07-31 finding). */
async function appstoreLookup(appId: string, country: string, fetchImpl: ReputationFetchImpl): Promise<LookupResult | null> {
  try {
    const response = await fetchWithDeadline(fetchImpl, `https://itunes.apple.com/lookup?id=${appId}&country=${country}`);
    if (!response.ok) return null;
    const json: unknown = await response.json();
    const parsed = LookupResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`itunes lookup response did not match the expected shape: ${parsed.error.message}`);
    }
    const data = parsed.data;
    if (!data.resultCount) return { listed: false };
    const result = data.results?.[0] ?? {};
    return { listed: true, official_rating_avg: result.averageUserRating ?? null, official_rating_count: result.userRatingCount ?? null };
  } catch {
    return null;
  }
}

async function appstorePages(req: AppstoreLegRequest, fetchImpl: ReputationFetchImpl): Promise<Review[]> {
  const records: Review[] = [];
  for (let page = 1; page <= req.maxPages; page++) {
    const url = `https://itunes.apple.com/${req.country}/rss/customerreviews/page=${page}/id=${req.appId}/sortby=mostrecent/json`;
    const response = await fetchWithDeadline(fetchImpl, url);
    if (!response.ok) break;
    const raw = await response.text();
    const rawSha256 = sha256Hex(raw);
    const json: unknown = JSON.parse(raw);
    const parsed = RssFeedResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`appstore RSS page ${page} did not match the expected feed shape: ${parsed.error.message}`);
    }
    let entries: RssEntry | RssEntry[] = parsed.data.feed?.entry ?? [];
    // iTunes RSS returns a single object (not an array) when a page has exactly
    // one entry — normalize so the loop never crashes on a one-review page.
    if (!Array.isArray(entries)) entries = [entries];

    let gotReview = false;
    for (const entry of entries) {
      if (!("im:rating" in entry) || !entry["im:rating"]) continue; // first entry on page 1 is app metadata
      gotReview = true;
      // A label outside "1".."5" (Apple's own "N/A" among them) safeParses to
      // `undefined` — recorded as `rating: null`, never the `NaN` this ticket
      // names as the live defect, and never silently dropping the review.
      const rating = RatingLabelSchema.safeParse(entry["im:rating"].label);
      records.push({
        review_id: `appstore:${req.listingId}:${entry.id?.label ?? ""}`,
        platform: "appstore",
        source: "appstore_rss",
        capture_tier: "MEASURED",
        listing_id: req.listingId,
        listing_label: req.listingLabel,
        rating: rating.success ? rating.data : null,
        author: entry.author?.name?.label ?? null,
        text: `${entry.title?.label ?? ""}\n${entry.content?.label ?? ""}`,
        created_at: entry.updated?.label ?? "",
        raw_sha256: rawSha256,
      });
    }
    if (!gotReview) break;
  }
  return records;
}

/**
 * `capture_appstore` (capture.py): the public keyless RSS feed
 * (`itunes.apple.com/<country>/rss/customerreviews/...`), roughly the most
 * recent 500 reviews per storefront — the one leg that runs today with zero
 * credentials. **Known flakiness** (ADAPTERS.md, observed live 2026-07-31):
 * the feed intermittently returns ZERO entries for an app/storefront that
 * has reviews. So: retry once, then cross-check the keyless lookup API — a
 * storefront that reports ratings but an empty feed is `UNAVAILABLE` with
 * the reason (never a fabricated zero); genuinely zero ratings is an honest
 * empty capture.
 *
 * `delayMs` is injectable (default a real `setTimeout`) purely so tests
 * exercise the real retry path without a real wall-clock wait.
 */
export async function captureAppstore(
  req: AppstoreLegRequest,
  fetchImpl: ReputationFetchImpl,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CaptureLegOutcome> {
  // Every dead-leg exit from this adapter goes through here — ADAPTERS.md rule 1: a
  // tombstone, never a silent zero. Hoisted above the fetch/parse below so a thrown
  // network error or a malformed-JSON page also resolves to a tombstone rather than an
  // uncaught exception — unlike gbp.ts/yelp.ts, this leg previously had no try/catch
  // around its fetch loop at all, so one flaky response aborted the whole multi-leg
  // capture call and erased the sibling legs' already-captured results (a tooling
  // isolation audit finding: capture-tool.ts's own per-leg try/catch is the other half
  // of this fix).
  const dead = (reason: string): CaptureLegOutcome =>
    unavailableLeg({ leg: "appstore", platform: "appstore", source: "appstore_rss", listingId: req.listingId, listingLabel: req.listingLabel, reason });

  let records: Review[];
  try {
    records = await appstorePages(req, fetchImpl);
    if (records.length === 0) {
      await delay(3000); // the feed flakes intermittently; one retry is cheap
      records = await appstorePages(req, fetchImpl);
    }
  } catch (err) {
    return dead(`App Store RSS feed request/parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const meta = await appstoreLookup(req.appId, req.country, fetchImpl);

  if (records.length > 0 || meta === null) {
    const outcome: CaptureLegOutcome = { leg: "appstore", status: "ok", reviews: records };
    if (meta) {
      outcome.listingMeta = { listing_id: req.listingId, captured_at: nowIso(), ...meta };
    }
    return outcome;
  }

  // Empty feed: honest only if the storefront really has nothing (the
  // tombstone rule — a dead leg is UNAVAILABLE, never a fabricated zero).
  if (!meta.listed) {
    return dead(`app not found in storefront "${req.country}" (check the client's platform roster)`);
  }
  if ((meta.official_rating_count ?? 0) > 0) {
    return dead(
      `RSS feed returned zero entries though the storefront reports ${meta.official_rating_count} ratings (known feed flakiness); retry next pulse`,
    );
  }
  // Genuinely nothing: an honest empty capture.
  return { leg: "appstore", status: "ok", reviews: [], listingMeta: { listing_id: req.listingId, captured_at: nowIso(), ...meta } };
}
