import { z } from "zod";
import { SEO_GEO_VISIBILITY_ENGINES, SEO_GEO_CAPTURE_TIERS } from "./types.js";

const DataCoverageSchema = z.enum(["measured", "estimated", "unavailable"]);

// The seven discriminated-union variants below have no existing TSDoc to transcribe (SCRUM-293
// flag) — descriptions synthesized from each variant's own field names, matching the seven
// NormalizationKindSchema kinds a measurement's data can be scored under.
const InputMeasurementDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("boolean"), measured: z.boolean() }).describe("A yes/no measurement."),
  z.object({ kind: z.literal("count"), actual: z.number() }).describe("A raw count measurement, scored against a target count."),
  z.object({ kind: z.literal("ratio"), value: z.number() }).describe("A 0-1 ratio measurement, clamped when scored."),
  z.object({ kind: z.literal("percentage"), valuePct: z.number() }).describe("A 0-100 percentage measurement."),
  z.object({ kind: z.literal("stepped"), value: z.number() }).describe("A measurement scored on a stepped scale where lower is better."),
  z.object({ kind: z.literal("multiBool"), subBools: z.array(z.boolean()) }).describe("Several yes/no sub-checks combined into one measurement."),
  z.object({ kind: z.literal("combine"), fields: z.record(z.string(), z.union([z.number(), z.boolean()])) }).describe("Several named sub-values combined into one measurement."),
]);

export const InputMeasurementSchema = z.object({
  data: InputMeasurementDataSchema.describe("The measurement's own value, shaped by its kind."),
  gatePass: z.boolean().optional().describe("Whether this measurement passed its associated hard gate, if it has one."),
  coverage: DataCoverageSchema.describe("Whether this value was actually measured, estimated, or is unavailable — never conflating the three."),
});

export const ScoreInputSchema = z.object({
  seoMeasurements: z.record(z.string(), InputMeasurementSchema).default({}).describe("Every SEO recommendation's measurement, keyed by recId."),
  geoReadinessMeasurements: z.record(z.string(), InputMeasurementSchema).default({}).describe("Every GEO-readiness recommendation's measurement, keyed by recId."),
  visibility: z
    .object({
      cells: z.array(
        z.object({
          promptId: z.string().describe("Which prompt in the capture matrix this cell is for."),
          engine: z.enum(SEO_GEO_VISIBILITY_ENGINES).describe("Which AI-visibility engine this cell was captured from."),
          captureTier: z.enum(SEO_GEO_CAPTURE_TIERS).describe("Whether this cell was actually measured, estimated, or is unavailable."),
          brandMentioned: z.boolean().describe("Whether the client's brand was mentioned in this engine's answer."),
          brandFirstMentionCharOffset: z.number().optional().describe("Character offset of the brand's first mention, if mentioned."),
          brandCited: z.boolean().describe("Whether the client's brand was cited (linked) in this engine's answer."),
          brandFirstCitationOrdinal: z.number().optional().describe("Ordinal position of the brand's first citation among all citations, if cited."),
          competitorsNamed: z
            .array(z.object({ brandId: z.string(), charOffset: z.number() }))
            .default([])
            .describe("Competitor roster members named in this answer, each with the char offset of their first mention."),
          citations: z.array(z.object({ domain: z.string(), ordinal: z.number() })).default([]).describe("Every domain cited in this answer, in citation order."),
          mentionCounts: z.record(z.string(), z.number()).default({}).describe("How many times each named entity was mentioned."),
          sentimentPerMention: z
            .array(z.object({ mentionIndex: z.number(), label: z.enum(["pos", "neg", "neutral"]) }))
            .default([])
            .describe("The sentiment of each individual mention, by its index."),
        }),
      ).describe("Every captured (prompt x engine) AI-visibility cell feeding this score."),
      promptCount: z.number().int().positive().describe("Total prompts in the fixed capture matrix, used as the scoring denominator N."),
      clientDomains: z.array(z.string()).min(1).describe("The client's own domains, for detecting brand mentions/citations."),
      competitorRoster: z.array(z.string()).default([]).describe("Competitor brand ids tracked in this scoring pass."),
      /** brandId -> that competitor's own domains — enables BOTH-14's "first_cited" leg for competitors, symmetric to `clientDomains`. Optional: omitted entirely when no domain roster is known yet, in which case a competitor's "first" status is judged on the named leg alone (never fabricated). */
      competitorDomains: z
        .record(z.string(), z.array(z.string()))
        .default({})
        .describe(
          "brandId -> that competitor's own domains — enables BOTH-14's \"first_cited\" leg for competitors, symmetric to clientDomains. Omitted entirely when no domain roster is known yet.",
        ),
      /**
       * promptId -> `"known"` (the prompt names the client company — recognition)
       * or `"found"` (it doesn't — discovery). Classification is supplied, never
       * inferred; an unlisted prompt is reported as unclassified and counted in
       * neither cohort. The two cohorts are published separately and never averaged.
       */
      promptCohorts: z
        .record(z.string(), z.enum(["known", "found"]))
        .default({})
        .describe(
          "promptId -> \"known\" (the prompt names the company — recognition) or \"found\" (it doesn't — discovery). Reported separately and never averaged; an unlisted prompt is counted in neither cohort.",
        ),
      /** @deprecated The N-vs-N_e decision is resolved — see `VISIBILITY_DENOMINATOR_DECISION`. Accepted for compatibility; changes no number. */
      denominator: z
        .enum(["N", "N_e"])
        .default("N")
        .describe(
          "RETIRED: the N vs N_e denominator decision is resolved (per-engine rates use N_e, the blended index uses N, both always printed). Still accepted so existing callers compile, but it selects nothing — the value is echoed back on the metrics result as denominatorRequested.",
        ),
    })
    .optional()
    .describe("AI-visibility capture data feeding the GEO visibility sub-score. Omitted when visibility capture hasn't run."),
  hashInputs: z.record(z.string(), z.string()).default({}).describe("Raw values hashed into the score's provenance record, for audit/reproducibility."),
});
export type ScoreInput = z.infer<typeof ScoreInputSchema>;

const NormalizationKindSchema = z.enum([
  "boolean",
  "count_with_target",
  "ratio_clamp",
  "percentage",
  "lower_is_better_stepped",
  "multi_bool",
  "combine",
]);

// Fields below have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from
// evaluateScoreFamily's EvaluatedInput shape (recommend-tool.ts's own doc comment names it).
const RecommendInputInstanceSchema = z.object({
  recId: z.string().describe("Which recommendation this input's already-computed norm belongs to."),
  norm: z.number().describe("This input's already-computed normalized score (0-1), from seoGeo.score's per-input breakdown."),
  weight: z.number().describe("This input's weight in its score family."),
  normalization: NormalizationKindSchema.describe("Which normalization method produced norm — the same seven kinds InputMeasurementDataSchema's data can take."),
});

export const RecommendInputSchema = z.object({
  seoInputs: z
    .array(RecommendInputInstanceSchema)
    .default([])
    .describe("The flat EvaluatedInput[] from seoGeo.score's SEO run — pass its .inputs array here."),
  geoReadinessInputs: z
    .array(RecommendInputInstanceSchema)
    .default([])
    .describe("The flat EvaluatedInput[] from seoGeo.score's GEO Readiness run — pass its .inputs array here."),
});
export type RecommendInput = z.infer<typeof RecommendInputSchema>;
