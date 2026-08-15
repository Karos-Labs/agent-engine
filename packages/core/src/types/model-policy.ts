import { z } from "zod";

/**
 * The three-tier provider policy from RFC-01 §5.4.
 *
 * - `pinned`    — drafting, brand voice, the self-critique gate. Direct to
 *                 Anthropic, never routed through a gateway.
 * - `portable`  — summarization, extraction, ranking. Same `llm.complete`
 *                 call shape regardless of backing model.
 * - `commodity` — embeddings, classification, dedupe. Routed to whatever
 *                 passes evals and is cheapest that week.
 */
export const ProviderPolicySchema = z.enum(["pinned", "portable", "commodity"]);
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

/**
 * `fallbackModel` is only meaningful for `portable`/`commodity` steps — a
 * `pinned` step never silently swaps models (RFC-01 §5.4), so a fallback
 * declared alongside `pinned` is rejected here rather than silently ignored.
 */
export const ModelPolicySchema = z
  .object({
    policy: ProviderPolicySchema,
    /** e.g. "claude-opus-4-8", "claude-sonnet-4-6", "gpt-4o-mini". */
    model: z.string().min(1),
    fallbackModel: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.policy === "pinned" && val.fallbackModel !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fallbackModel is only used for 'portable' / 'commodity' policies, never 'pinned' (RFC-01 §5.4)",
        path: ["fallbackModel"],
      });
    }
  });
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
