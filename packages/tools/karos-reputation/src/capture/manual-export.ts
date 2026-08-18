import type { Review } from "../triage/types.js";
import type { CaptureLegOutcome, ManualExportLegRequest } from "./types.js";

/**
 * `manual_export` (ADAPTERS.md): "always the floor" — a CSV/JSON the client
 * exports from their platform dashboard, normalized by hand into the record
 * shape, so a client with zero connected APIs can still run the product
 * (tier MEASURED, source `manual_export`). This leg touches no network at
 * all; its only job is fixing `source` (the identifier crosswalk table pins
 * it for this leg regardless of what the caller supplied) and DEFAULTING the
 * tier.
 *
 * `capture_tier` is deliberately a default, not an override: ADAPTERS.md rule
 * 1 is "tier is set at capture and never upgraded", and unconditionally
 * stamping `MEASURED` upgrades every tier a caller states — including an
 * `UNAVAILABLE` tombstone row a caller hand-carries in from a dead leg, which
 * is the exact fact this system is least allowed to lose ("never a silent
 * zero"). Absent tier still means MEASURED: a hand-normalized dashboard
 * export IS a measured capture.
 */
export function captureManualExport(req: ManualExportLegRequest): CaptureLegOutcome {
  const reviews: Review[] = req.rows.map((row) => ({
    ...row,
    source: "manual_export",
    capture_tier: row.capture_tier ?? "MEASURED",
  }));
  return { leg: "manual_export", status: "ok", reviews };
}
