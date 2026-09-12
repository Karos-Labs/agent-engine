import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import type { z } from "zod";
import { ConceptSchema } from "../workflow/concept-direction.js";

/**
 * What this step RETURNS, derived from the schema rather than imported by
 * name: `concept-direction.ts` owns the shape, and deriving it here means a
 * field added there cannot drift from what this agent is typed to.
 *
 * `z.infer` (the parsed OUTPUT type), deliberately, and not
 * `concept-direction.ts`'s own `Concept` alias, which is `z.input` — the
 * difference is `usesPermittedMarks`, optional on the way in and always an
 * array on the way out because the schema defaults it. `BaseAgent` hands
 * callers the PARSED object, so the output type is the honest one: a caller
 * checking the permitted-marks allowlist (L9) must not have to narrow an
 * `undefined` the parser already filled in.
 */
export type ConceptOutput = z.infer<typeof ConceptSchema>;

/**
 * RFC-16 §2.2, step `04n-design-concept`: the one step in the pipeline that
 * asks what the VISUAL METAPHOR for this story is.
 *
 * ## What it adds that Phase 3 did not
 *
 * Phase 3 replaced `image.generate`'s one hardcoded fleet-wide sentence
 * ("Style: realistic photography, natural lighting, clean composition") with
 * per-client art direction and a style lock. That solved STYLE — what an
 * image looks like. It did not solve CONCEPT — what the image IS OF. The
 * writer's scene brief describes a scene; nothing asked for the metaphor, and
 * a metaphor is what makes an image arresting rather than merely on-brand.
 * This step answers that question, for one slide, on the minority of runs
 * where `04m-concept-eligibility` found a story whose SHAPE can carry one
 * (§1.5's nine preconditions, ceiling 25% of posts, one slide per carousel).
 *
 * ## Everything it reads is hand-assembled
 *
 * `allowedTools: []`, `maxSteps: 1` — the art director's shape, and here it
 * is also the safety property. The step is handed no request, no query and no
 * web access: it receives the client's brief, six fact cards, the chosen
 * angle, the recognised entities, the ELIGIBLE pattern subset, the subject
 * palette, the frozen style lock and the likeness permit, and it is asked to
 * dramatise one of those cards with one of those subjects. That is why the
 * audit's headline failure — a real-estate carousel generated for an AI
 * marketing agency, because a step took a request verbatim as a web query
 * with no client grounding — is structurally unreachable from here rather
 * than merely discouraged. `checkConceptLegibility` then re-checks the pair
 * it named (L1 the claim, L2 the subject) in code.
 *
 * ## Model: Sonnet, pinned, and the cost that justifies it
 *
 * `claude-sonnet-4-6` — NO OPUS IN A RUN, per the owner's rule. ~6.2k in /
 * ~0.65k out = 6,200 x $3/1M + 650 x $15/1M = $0.0186 + $0.00975 =
 * **$0.0284**, priced `concept: 0.029` in `run-budget.ts` and booked
 * unconditionally by the estimator (`RunShape.conceptPossible`) so an
 * estimate that flatters itself cannot pull the wrong lever. Against the
 * $1.00 target / $1.50 hard max that is affordable only out of the first
 * dollar: precondition 7 requires `meter.posture === "normal"`, so a run past
 * target never buys this call at all.
 *
 * Sonnet rather than Flash ($0.0033) for the same reason the art director is
 * Sonnet: this is the one call in the run that is pure judgment, it fires on
 * at most a quarter of runs, and a flat concept is worse than no concept —
 * it spends a $0.039 generated image on a picture nobody decodes, and then
 * loses the re-vet to the photograph the slide already had (§6.4) anyway.
 *
 * `maxTokens: 1_200`: eleven short fields, the longest capped at 240
 * characters by `ConceptSchema`. The whole object is well under 400 tokens;
 * the headroom is for a model that thinks out loud before committing.
 *
 * `contentLanguageSensitive: false`, like the art director and unlike the
 * copy and brief agents: the output is an English brief addressed to a
 * diffusion model and to deterministic checks, never client-facing copy.
 * Hebrew and Arabic clients get Hebrew and Arabic SLIDES — that is
 * `target-language.ts`'s job — and the one place the target language does
 * reach this step is `typeZone`, which the prompt requires to be a horizontal
 * band precisely so the composition holds in RTL.
 *
 * ## Failure posture
 *
 * A malformed answer is a `content_fail` and `04m` records it as a warn. The
 * slide then keeps the writer's original scene brief and its already-retrieved
 * photograph — `04n` never mutates `slide.visualNeed` — so the run proceeds on
 * exactly today's path and completes. The same is true of every legibility
 * clause L1-L10: a concept is discarded silently, never retried, never held.
 * Budgets adapt, never hold.
 */
export class InstagramConceptAgent extends BaseAgent<ConceptOutput> {
  protected readonly config: AgentStepConfig<ConceptOutput> = {
    id: "instagram-concept",
    description:
      "Design ONE image for ONE slide: name the visual metaphor for this story as a pattern, an anchor drawn verbatim from the client's own subject palette, the single unexpected situation it is in, the brand colour's role as an object in frame, the cleared type zone, and the fact-card claim it rests on — the run's style lock still decides how it is shot.",
    allowedTools: [],
    outputSchema: ConceptSchema,
    maxSteps: 1,
    maxTokens: 1_200,
    modelPolicy: resolveModelPolicy("instagram-concept", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: false }),
    skillRef: "instagram-concept@1",
  };
}
