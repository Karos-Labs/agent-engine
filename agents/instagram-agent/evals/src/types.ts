import { z } from "zod";
import { ImageVettingOutputSchema, InstagramCopyOutputSchema, ResearchOutputSchema, StyleConfigSchema } from "../../src/workflow/types.js";

/**
 * A golden run for the Instagram agent (RFC-01 §12 bullet 1). Unlike
 * `linkedin-agent`'s golden run (one endorsed post, produced by a single
 * draft agent), this migration has no pilot run anywhere yet (RFC-03 §5:
 * "no pilot run exists anywhere... plan for a supervised first run
 * specifically to produce the golden run") — so this frozen fixture is a
 * hand-authored stand-in for that future supervised pilot, covering the
 * three judgment steps' outputs (research, copy, image vetting) plus the
 * frozen style config they were produced against.
 *
 * Deliberately scoped through step 07 only (RFC-03's own suggested fallback
 * when a full render-inclusive golden run is heavier than the eval needs to
 * be): `publish.renderCarousel`'s actual Chromium-backed rendering is
 * already covered by `packages/tools/karos-publish`'s own package tests
 * (`__tests__/render-carousel.test.ts`) and by this package's own
 * `__tests__/workflow-e2e.test.ts`, which really does invoke it end to end —
 * re-verifying Chromium here would only duplicate that coverage while making
 * this eval slower and environment-dependent (a real browser binary) for no
 * additional signal.
 */
export const InstagramGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  styleConfig: StyleConfigSchema,
  research: ResearchOutputSchema,
  endorsedCopy: InstagramCopyOutputSchema,
  endorsedSelections: ImageVettingOutputSchema,
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type InstagramGoldenRun = z.infer<typeof InstagramGoldenRunSchema>;

export const InstagramDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail"]),
  reason: z.string().optional(),
});
export type InstagramDeterministicAssertionResult = z.infer<typeof InstagramDeterministicAssertionResultSchema>;
