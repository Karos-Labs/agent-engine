import { z } from "zod";
import { SEO_GEO_VISIBILITY_ENGINES, SEO_GEO_CAPTURE_TIERS } from "./types.js";

const DataCoverageSchema = z.enum(["measured", "estimated", "unavailable"]);

const InputMeasurementDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("boolean"), measured: z.boolean() }),
  z.object({ kind: z.literal("count"), actual: z.number() }),
  z.object({ kind: z.literal("ratio"), value: z.number() }),
  z.object({ kind: z.literal("percentage"), valuePct: z.number() }),
  z.object({ kind: z.literal("stepped"), value: z.number() }),
  z.object({ kind: z.literal("multiBool"), subBools: z.array(z.boolean()) }),
  z.object({ kind: z.literal("combine"), fields: z.record(z.string(), z.union([z.number(), z.boolean()])) }),
]);

export const InputMeasurementSchema = z.object({
  data: InputMeasurementDataSchema,
  gatePass: z.boolean().optional(),
  coverage: DataCoverageSchema,
});

export const ScoreInputSchema = z.object({
  seoMeasurements: z.record(z.string(), InputMeasurementSchema).default({}),
  geoReadinessMeasurements: z.record(z.string(), InputMeasurementSchema).default({}),
  visibility: z
    .object({
      cells: z.array(
        z.object({
          promptId: z.string(),
          engine: z.enum(SEO_GEO_VISIBILITY_ENGINES),
          captureTier: z.enum(SEO_GEO_CAPTURE_TIERS),
          brandMentioned: z.boolean(),
          brandFirstMentionCharOffset: z.number().optional(),
          brandCited: z.boolean(),
          brandFirstCitationOrdinal: z.number().optional(),
          competitorsNamed: z.array(z.object({ brandId: z.string(), charOffset: z.number() })).default([]),
          citations: z.array(z.object({ domain: z.string(), ordinal: z.number() })).default([]),
          mentionCounts: z.record(z.string(), z.number()).default({}),
          sentimentPerMention: z
            .array(z.object({ mentionIndex: z.number(), label: z.enum(["pos", "neg", "neutral"]) }))
            .default([]),
        }),
      ),
      promptCount: z.number().int().positive(),
      clientDomains: z.array(z.string()).min(1),
      competitorRoster: z.array(z.string()).default([]),
      /** brandId -> that competitor's own domains — enables BOTH-14's "first_cited" leg for competitors, symmetric to `clientDomains`. Optional: omitted entirely when no domain roster is known yet, in which case a competitor's "first" status is judged on the named leg alone (never fabricated). */
      competitorDomains: z.record(z.string(), z.array(z.string())).default({}),
      denominator: z.enum(["N", "N_e"]).default("N"),
    })
    .optional(),
  hashInputs: z.record(z.string(), z.string()).default({}),
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

const RecommendInputInstanceSchema = z.object({
  recId: z.string(),
  norm: z.number(),
  weight: z.number(),
  normalization: NormalizationKindSchema,
});

export const RecommendInputSchema = z.object({
  seoInputs: z.array(RecommendInputInstanceSchema).default([]),
  geoReadinessInputs: z.array(RecommendInputInstanceSchema).default([]),
});
export type RecommendInput = z.infer<typeof RecommendInputSchema>;
