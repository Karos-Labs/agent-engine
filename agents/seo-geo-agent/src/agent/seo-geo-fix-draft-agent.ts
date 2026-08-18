import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/** One fired recommendation's fix-relevant fields, exactly as the workflow hands them in (see `SeoGeoFixDraftAgent` input below) — never a fabricated projection. */
export const SeoGeoFixDraftInputRecommendationSchema = z.object({
  recId: z.string().min(1),
  recommendation: z.string().min(1),
  fireState: z.enum(["approaching", "fail"]),
  worstNorm: z.number(),
  impact: z.string(),
  effort: z.string(),
});
export type SeoGeoFixDraftInputRecommendation = z.infer<typeof SeoGeoFixDraftInputRecommendationSchema>;

export const SeoGeoFixDraftOutputSchema = z.object({
  fixes: z
    .array(
      z.object({
        recId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .max(5),
});
export type SeoGeoFixDraftOutput = z.infer<typeof SeoGeoFixDraftOutputSchema>;

/**
 * The RFC-04 §2 Phase 7 migration: drafts a short, grounded fix description
 * for each of the top few `agent-direct`-deliverable fired recommendations a
 * human has already approved at the `fix_generation_review` gate immediately
 * before this step runs. One bounded agent producing a small structured
 * list, per this migration's instructions — not a separate agent per fix
 * type (schema/FAQ/outreach/etc.), which the source skill's own Phase 7
 * describes but which this migration deliberately simplifies to a single
 * step given there's no real per-fix-type delivery backend wired up yet.
 *
 * No `selfCritique` here: `gate.numbersSourced` (the obvious content gate for
 * "don't fabricate a number") expects a single `{text, sources}` shape, but
 * this agent's output is a list of `{recId, title, description}` entries —
 * `selfCritique.gateArgs` only supports *static* fields merged onto the raw
 * draft (see `packages/core/src/types/agent-step.ts`), not a
 * draft-to-gate-input transform, so wiring it here would require flattening
 * `fixes` into one string first. The workflow's Phase 8 narrative step
 * already runs `gate.numbersSourced` explicitly (via `runGate`) against the
 * one place numeric claims actually reach the client in prose; this agent's
 * own craft policy (`seo-geo-fix-draft@1`) is the only enforcement here, same
 * as any bounded agent whose output isn't natural-language prose.
 */
export class SeoGeoFixDraftAgent extends BaseAgent<SeoGeoFixDraftOutput> {
  protected readonly config: AgentStepConfig<SeoGeoFixDraftOutput> = {
    id: "seo-geo-fix-draft",
    description: "Draft short, grounded fix descriptions for the top agent-direct-deliverable fired SEO/GEO recommendations.",
    allowedTools: [],
    outputSchema: SeoGeoFixDraftOutputSchema,
    // Pinned — same model pin as every other bounded craft step in this migration set (RFC-02 §5's convention).
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "seo-geo-fix-draft@1",
  };
}
