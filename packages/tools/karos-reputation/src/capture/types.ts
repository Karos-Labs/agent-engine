import { z } from "zod";
import { ReviewSchema } from "../triage/types.js";
import type { Review } from "../triage/types.js";

/** The three capture-leg outcomes (RFC-08 task spec): a leg either produced records honestly (`ok`, which may itself carry an `UNAVAILABLE`-tier tombstone review — see appstore), is genuinely down (`UNAVAILABLE`), or was never part of this client's platform roster at all (`not_in_roster`, ADAPTERS.md rule 3: "no leg invention"). */
export const CAPTURE_LEG_STATUSES = ["ok", "UNAVAILABLE", "not_in_roster"] as const;
export type CaptureLegStatus = (typeof CAPTURE_LEG_STATUSES)[number];

export interface CaptureLegOutcome {
  leg: string;
  status: CaptureLegStatus;
  reason?: string;
  reviews: Review[];
  /** appstore-only: the storefront's official rating snapshot (flake-vs-empty evidence, ADAPTERS.md). */
  listingMeta?: {
    listing_id: string;
    captured_at: string;
    listed: boolean;
    official_rating_avg?: number | null;
    official_rating_count?: number | null;
  };
}

// listingId/listingLabel have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from their names and the capture-tool's own doc comment.
const LegRequestBaseSchema = z.object({
  listingId: z.string().min(1).describe("This listing's id on its own platform (e.g. a GBP location id, an App Store app id)."),
  listingLabel: z.string().min(1).describe("A human-readable label for this listing, for display and logging."),
  /** ADAPTERS.md rule 3 ("no leg invention"): a leg not in the client's `seeds.yaml` roster is skipped cleanly, never guessed at. */
  inRoster: z
    .boolean()
    .default(true)
    .describe("ADAPTERS.md rule 3 (\"no leg invention\"): a leg not in the client's seeds.yaml roster is skipped cleanly, never guessed at."),
});

export const GbpLegRequestSchema = LegRequestBaseSchema.extend({
  leg: z.literal("gbp"),
  // account/location have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from Google Business Profile's own account/location addressing.
  account: z.string().min(1).describe("The Google Business Profile account id this listing belongs to."),
  location: z.string().min(1).describe("The Google Business Profile location id to capture reviews for."),
});
export type GbpLegRequest = z.infer<typeof GbpLegRequestSchema>;

export const AppstoreLegRequestSchema = LegRequestBaseSchema.extend({
  leg: z.literal("appstore"),
  // These three fields have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from captureAppstore's usage.
  appId: z.string().min(1).describe("The App Store app id to capture reviews for."),
  country: z.string().min(2).default("us").describe("The App Store storefront country code to read reviews from."),
  maxPages: z.number().int().positive().default(10).describe("Maximum pages of the App Store RSS review feed to fetch."),
});
export type AppstoreLegRequest = z.infer<typeof AppstoreLegRequestSchema>;

export const ManualExportLegRequestSchema = LegRequestBaseSchema.extend({
  leg: z.literal("manual_export"),
  /** Rows the client exported from their platform dashboard, already normalized by hand into the record shape (ADAPTERS.md: "manual_export is always the floor"). */
  rows: z
    .array(ReviewSchema.partial({ source: true, capture_tier: true }))
    .default([])
    .describe(
      "Rows the client exported from their platform dashboard, already normalized by hand into the record shape (ADAPTERS.md: \"manual_export is always the floor\").",
    ),
});
export type ManualExportLegRequest = z.infer<typeof ManualExportLegRequestSchema>;

export const CaptureLegRequestSchema = z.discriminatedUnion("leg", [
  GbpLegRequestSchema,
  AppstoreLegRequestSchema,
  ManualExportLegRequestSchema,
]);
export type CaptureLegRequest = z.infer<typeof CaptureLegRequestSchema>;

export const CaptureToolInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the capture-tool's own doc comment.
  legs: z
    .array(CaptureLegRequestSchema)
    .min(1)
    .describe("The capture legs (platforms/listings) to run this call, each producing its own ok/UNAVAILABLE/not_in_roster outcome."),
});
export type CaptureToolInput = z.infer<typeof CaptureToolInputSchema>;

export interface CaptureToolResult {
  legs: CaptureLegOutcome[];
}

/** Injectable HTTP fetcher — every network-calling adapter takes this instead of reaching for the global `fetch` directly, so tests supply canned responses instead of hitting real endpoints. */
export type ReputationFetchImpl = typeof fetch;
