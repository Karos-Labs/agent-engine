import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

export const SeoGeoNarrativeOutputSchema = z.object({
  summary: z.string().min(1),
});
export type SeoGeoNarrativeOutput = z.infer<typeof SeoGeoNarrativeOutputSchema>;

/**
 * The RFC-04 §2 Phase 8 migration: drafts the report's one executive-summary
 * paragraph from already-computed, already-typed scoring data — the report
 * structure itself (scores, visibility, fired recs, fix drafts) assembles
 * from pure code (`create-seo-geo-agent-workflow.ts` step 16); this is the
 * only prose-drafting step in the whole pipeline. `gate.numbersSourced` runs
 * as an explicit workflow step immediately after this one (not as
 * `selfCritique`, since the workflow needs the exact same `sources` array it
 * already built for `seoGeo.score`'s own outputs — recomputing that inside
 * `selfCritique.gateArgs`, which only supports *static* fields, isn't
 * possible) — this is RFC-04 §2's own call-out that a
 * `gate.numbersSourced`-style check is "arguably more important here than
 * anywhere else in the whole agent portfolio, given the grade = measured
 * data only rule."
 *
 * v2 (T-A13/SCRUM-269): documents the workflow's newly-wired
 * `clientAttachedReferences` input field (client-attached "reference"-role
 * media metadata) and how this step may — and may not — use it. See
 * `create-seo-geo-agent-workflow.ts`'s `referenceMaterialsField`.
 *
 * v4: opens on what moved since the previous run. The prompt had always closed
 * by telling the client "the next run will compare against this one", and no
 * run ever did — this step's input carried the run in front of it and nothing
 * else, so four consecutive reports for one client shared most of their
 * wording. Step `09b-read-previous-run` now reads the snapshot step 20 has
 * been writing all along, and hands over the deltas already computed, because
 * §1 forbids this step doing arithmetic on the numbers it was given.
 */
export class SeoGeoNarrativeAgent extends BaseAgent<SeoGeoNarrativeOutput> {
  protected readonly config: AgentStepConfig<SeoGeoNarrativeOutput> = {
    id: "seo-geo-narrative",
    description: "Draft the SEO & GEO report's executive-summary paragraph from already-scored, already-typed data.",
    allowedTools: [],
    outputSchema: SeoGeoNarrativeOutputSchema,
    modelPolicy: resolveModelPolicy("seo-geo-narrative", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "seo-geo-narrative@4",
  };
}
