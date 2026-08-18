import type { Review } from "../triage/types.js";
import type { CaptureLegOutcome } from "./types.js";

/** `now_iso()` (capture.py): second-precision UTC, the exact shape every capture record's timestamps carry. */
export function captureNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * `ADAPTERS.md` rule 1 / `run-protocol.md` §7: **"A dead leg emits an
 * UNAVAILABLE tombstone for the run record, never a silent zero"** — the two
 * are opposite facts, and a zero is read downstream as "nothing to answer"
 * rather than "this integration is broken."
 *
 * `capture.py`'s appstore leg is the one place legacy shows the shape (it
 * returns `[record(..., capture_tier="UNAVAILABLE", unavailable_reason=...)]`
 * on a dead feed); `triage.py`'s main loop already has the matching branch,
 * emitting a NO_ACTION row with `signals: ["capture_unavailable"]` and
 * incrementing `summary.unavailable`. This helper is what actually produces
 * the row so that branch can ever fire.
 *
 * `review_id` is synthetic but STABLE (`<platform>:<listing_id>:__unavailable__`)
 * rather than legacy's date-stamped `unavailable-<YYYY-MM-DD>`: a stable key
 * means a leg that is down for a week produces one identity rather than seven,
 * which is what every downstream key in this port (the NO_ACTION decision id,
 * the seen ledger, the annotations cache) actually wants. `annotations` is
 * absent entirely — never `null` — because `review-schema.md` makes the
 * fixtures the shape authority and a tombstone is never classified.
 */
export function unavailableTombstone(args: {
  platform: string;
  source: string;
  listingId: string;
  listingLabel?: string | undefined;
  reason: string;
  capturedAt?: string;
}): Review {
  const ts = args.capturedAt ?? captureNowIso();
  return {
    review_id: `${args.platform}:${args.listingId}:__unavailable__`,
    platform: args.platform,
    source: args.source,
    capture_tier: "UNAVAILABLE",
    listing_id: args.listingId,
    listing_label: args.listingLabel ?? null,
    rating: null,
    author: null,
    author_badge: null,
    language: null,
    text: null,
    created_at: ts,
    updated_at: null,
    owner_response: null,
    url: null,
    captured_at: ts,
    raw_sha256: null,
    unavailable_reason: args.reason,
  };
}

/**
 * The one way a capture adapter reports a dead leg: the leg-level
 * `status`/`reason` (kept for the tool contract and for the workflow's own
 * human-facing "Google: capture failed, reason X" line) AND the tombstone
 * review that carries the same fact into the triage envelope.
 */
export function unavailableLeg(args: {
  leg: string;
  platform: string;
  source: string;
  listingId: string;
  listingLabel?: string | undefined;
  reason: string;
}): CaptureLegOutcome {
  return {
    leg: args.leg,
    status: "UNAVAILABLE",
    reason: args.reason,
    reviews: [
      unavailableTombstone({
        platform: args.platform,
        source: args.source,
        listingId: args.listingId,
        listingLabel: args.listingLabel,
        reason: args.reason,
      }),
    ],
  };
}
