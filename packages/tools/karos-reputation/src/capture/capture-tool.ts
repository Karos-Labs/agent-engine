import { defineTool, success } from "@agent-engine/tool-common";
import { captureAppstore } from "./appstore.js";
import { captureManualExport } from "./manual-export.js";
import { unavailableLeg } from "./tombstone.js";
import {
  CaptureToolInputSchema,
  type CaptureLegOutcome,
  type CaptureLegRequest,
  type CaptureToolInput,
  type CaptureToolResult,
  type ReputationFetchImpl,
} from "./types.js";

// 1.0.1 (SCRUM-296/AU11): appstore.ts now safeParses every external response
// at the boundary instead of trusting a bare cast (the "N/A" rating -> NaN
// defect this ticket names) — a real behavior change for this tool.
// 1.3.0 (2026-09-21): the `gbp` leg is removed. Google Business Profile API
// access is unapproved for this project (quota 0 — see the removed
// capability-catalogue "reputation-capture" row) and could never produce real
// data; the pulse now runs on App Store RSS and hand exports only.
const TOOL_VERSION = "1.3.0";

export interface CreateReputationCaptureOptions {
  /**
   * Defaults to `process.env` — injectable so a workflow (or a test) can
   * supply credentials without mutating the real process environment.
   * Unread by any leg wired today (the `gbp` leg was the only credentialed
   * one and is removed — 2026-09-21); kept for interface symmetry with the
   * rest of this codebase's tool constructors and for the next credentialed
   * leg (a Yelp adapter is documented as planned in `.env.example`).
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — injectable so tests supply canned responses instead of hitting real endpoints (RFC-08 task spec: "App Store should be genuinely testable"). */
  fetchImpl?: ReputationFetchImpl;
}

/**
 * Per-leg `platform`/`source`, used only to build a tombstone if that leg's
 * own adapter throws unexpectedly despite its own internal try/catch (every
 * adapter already tombstones its known failure modes — this is the backstop
 * for anything that still slips through). Keeps the per-leg catch below from
 * needing to know each adapter's internal platform/source vocabulary.
 */
const LEG_TOMBSTONE_META: Record<CaptureLegRequest["leg"], { platform: string; source: string }> = {
  appstore: { platform: "appstore", source: "appstore_rss" },
  manual_export: { platform: "manual_export", source: "manual_export" },
};

/**
 * `reputation.capture` (RFC-08 §9): wraps `capture.py`'s per-platform legs
 * behind the three-outcome-per-leg contract (`ok` / `UNAVAILABLE` /
 * `not_in_roster`) every downstream consumer (triage, drafting, crisis,
 * reporting) relies on. ADAPTERS.md rule 3, "no leg invention": a leg not
 * in the client's roster is skipped cleanly, never guessed at, and never
 * touches the network.
 */
export function createReputationCapture(options: CreateReputationCaptureOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<CaptureToolInput, CaptureToolResult>({
    name: "reputation.capture",
    description:
      "Captures reviews for each requested platform leg (App Store, or a manual export), each resolving to its own ok / UNAVAILABLE / not_in_roster outcome. A leg not in the client's roster is skipped cleanly, never guessed at; one leg's failure never erases another leg's already-captured outcome.",
    version: TOOL_VERSION,
    inputSchema: CaptureToolInputSchema,
    async execute({ legs }) {
      const outcomes: CaptureLegOutcome[] = [];
      for (const leg of legs) {
        if (!leg.inRoster) {
          outcomes.push({ leg: leg.leg, status: "not_in_roster", reviews: [] });
          continue;
        }
        // Isolates each leg's capture from its siblings (a tooling-isolation audit
        // finding): a bug in one adapter that throws instead of returning its own
        // tombstone must not abort this loop and erase every OTHER leg's already-
        // captured outcomes — the whole reputation.capture call would otherwise
        // collapse to a single tooling_error with zero legs reported.
        try {
          switch (leg.leg) {
            case "appstore":
              outcomes.push(await captureAppstore(leg, fetchImpl));
              break;
            case "manual_export":
              outcomes.push(captureManualExport(leg));
              break;
          }
        } catch (err) {
          const meta = LEG_TOMBSTONE_META[leg.leg];
          outcomes.push(
            unavailableLeg({
              leg: leg.leg,
              platform: meta.platform,
              source: meta.source,
              listingId: leg.listingId,
              listingLabel: leg.listingLabel,
              reason: `unexpected error capturing "${leg.leg}": ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
      }
      return success<CaptureToolResult>({ legs: outcomes });
    },
  });
}
