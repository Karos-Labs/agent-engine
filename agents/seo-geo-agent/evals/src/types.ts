import { z } from "zod";

/**
 * RFC-04 §7's own definition of done calls for a scoring-fidelity golden run
 * that "reproduces the exact scores from at least the two real clients the
 * source skill was already proven against." That golden run's frozen inputs
 * and endorsed scores live in `karos-agents` (the legacy repo), not in this
 * one, and porting them is out of scope for this migration's Phase 1 (no
 * real crawler/AI-visibility-capture adapters exist here yet to reproduce
 * them against — see `src/workflow/measurements.ts`'s header comment). This
 * eval is therefore a structural golden run instead: it runs the full
 * 9-phase workflow end-to-end with `autoApprove: true` and asserts on the
 * shape and internal-consistency invariants of the final output — every
 * RFC-04 §4 gated decision stays visible, the reproducibility digest is a
 * real SHA-256, etc. — the thing this repo *can* honestly assert without a
 * ported reference score. Wiring the real two-client score-reproduction
 * suite is flagged as a follow-up once `karos-seo-geo`'s crawler/capture
 * adapters go from Phase-1 stand-ins to production.
 */
export const SeoGeoStructuralGoldenAssertionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});
export type SeoGeoStructuralGoldenAssertion = z.infer<typeof SeoGeoStructuralGoldenAssertionSchema>;
