import { z } from "zod";

/**
 * The three-tier provider policy from RFC-01 §5.4.
 *
 * - `pinned`    — drafting, brand voice, the self-critique gate. Never
 *                 routed through a fallback — a pinned step's model is what
 *                 it is, or the step fails loudly.
 * - `portable`  — summarization, extraction, ranking. Same `llm.complete`
 *                 call shape regardless of backing model.
 * - `commodity` — embeddings, classification, dedupe. Routed to whatever
 *                 passes evals and is cheapest that week.
 *
 * This axis is orthogonal to `vendor` below: it governs *retry/fallback
 * semantics* (does this step ever swap models on failure?), not *which
 * company's model answers the call*. A `pinned` step can run on Claude,
 * Gemini, or a Model Garden partner model — "pinned" just means it never
 * silently substitutes a different one.
 */
export const ProviderPolicySchema = z.enum(["pinned", "portable", "commodity"]);
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

/**
 * Which model vendor answers this step's calls — independent of the
 * `pinned`/`portable`/`commodity` tier above, and independent of the
 * *route* a vendor is reached by (e.g. Claude's own `MODEL_PROVIDER`
 * env var, which picks Agent Platform vs the direct Anthropic API — a
 * choice this field never makes; the vendor is fixed, the transport isn't).
 *
 * - `anthropic`        — Claude. Reached via Google Cloud's Agent Platform
 *                        (default) or directly, per `MODEL_PROVIDER`
 *                        (`create-model-router-from-env.ts`).
 * - `gemini`           — Google's own Gemini models. Reached via Agent
 *                        Platform/Vertex (ADC, default) only as of AU59/
 *                        SCRUM-358 — `GEMINI_ROUTE=direct` still parses but
 *                        has no adapter behind it, since `GEMINI_API_KEY` is
 *                        wired in neither prep nor prod.
 * - `model-garden`     — a third-party/open model served through Agent
 *                        Platform's own Model-as-a-Service (MaaS)
 *                        OpenAI-compatible endpoint (Llama, Mistral, and
 *                        similar Model Garden partner models). Still Agent
 *                        Platform, still ADC — just a different wire shape.
 * - `openai-compatible` — anything reachable through an OpenAI-shaped
 *                        chat-completions endpoint that ISN'T Agent
 *                        Platform: the real OpenAI API, or a self-hosted
 *                        gateway (LiteLLM) fronting whatever it fronts. No
 *                        longer wired from environment configuration as of
 *                        AU59/SCRUM-358 (models are served through Vertex AI
 *                        only) — still a valid value for a caller that
 *                        builds and passes its own adapter directly.
 *
 * Absent (`undefined`) means `anthropic` — every step written before this
 * field existed keeps behaving exactly as it did.
 */
export const ModelVendorSchema = z.enum(["anthropic", "gemini", "model-garden", "openai-compatible"]);
export type ModelVendor = z.infer<typeof ModelVendorSchema>;

/**
 * `fallbackModel` is only meaningful for `portable`/`commodity` steps — a
 * `pinned` step never silently swaps models (RFC-01 §5.4), so a fallback
 * declared alongside `pinned` is rejected here rather than silently ignored.
 * A fallback always resolves against the same `vendor` as the primary model
 * — swapping vendor mid-step on a transient failure would mean a different
 * structured-output mechanism, a different pricing row, and a different
 * failure mode all changing at once, silently.
 */
export const ModelPolicySchema = z
  .object({
    policy: ProviderPolicySchema,
    /** e.g. "claude-opus-4-8", "claude-sonnet-4-6", "gemini-2.5-pro", "meta/llama-3.1-70b-instruct-maas". */
    model: z.string().min(1),
    fallbackModel: z.string().min(1).optional(),
    vendor: ModelVendorSchema.optional(),
    /**
     * AU34 (SCRUM-312). Marks a step that produces CLIENT-FACING COPY — text
     * the client publishes in their own language, as opposed to research
     * notes, extraction, tagging, or an internal verdict, which are read by
     * this system and not by the client's audience.
     *
     * Only a step that opts in here is re-pointed by
     * `applyClientLanguagePolicy` when the client's brand kit states a
     * non-English content language (AU31/SCRUM-309's `language` field). Every
     * other step keeps its compiled/env-resolved model exactly as before — a
     * client's language is a fact about their published copy, and spending
     * premium-tier tokens on an extraction step because of it would be a cost
     * regression with no quality argument behind it.
     *
     * Opt-in rather than derived from the step id: `stepEnvPrefix` can derive
     * an env var name from an id safely because a wrong guess just means an
     * env var nobody sets, whereas guessing "is this copy?" from a substring
     * would silently re-tier spend on steps like `seo-geo-fix-draft` that
     * merely happen to be named like drafting.
     *
     * Absent means `false` — every step written before this field existed
     * keeps behaving exactly as it did.
     */
    contentLanguageSensitive: z.boolean().optional(),
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

/** `policy.vendor` resolved to its concrete default — the single place "absent means anthropic" is decided. */
export function resolveModelVendor(policy: Pick<ModelPolicy, "vendor">): ModelVendor {
  return policy.vendor ?? "anthropic";
}
