import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { VisualQaOutputSchema } from "../workflow/types.js";

/**
 * The v5 wire shape: everything `VisualQaOutputSchema` already carries, plus
 * the CMO verdict.
 *
 * Declared HERE rather than in `types.ts` so this package's other work
 * packages are not editing the same file, and extended rather than redeclared
 * so `pass`/`findings` cannot drift from the shape every existing consumer
 * reads. A `VisualQaVerdict` IS a `VisualQaOutput` structurally, so nothing
 * downstream has to change to keep working.
 */
export const VisualQaVerdictSchema = VisualQaOutputSchema.extend({
  /**
   * *Would you publish this for a paying client?* — prompt @5 §6 question 5.
   *
   * Separate from `pass` because the two genuinely differ, and the gap between
   * them is the whole reason this phase exists: on 2026-09-16 three posts
   * passed every render rule and the owner rejected all three on sight. `pass`
   * is compliance; this is judgement.
   *
   * DEFAULTS TO TRUE, and the direction is deliberate. A model that omits the
   * field (an older prompt version replayed from a checkpoint, a malformed
   * turn salvaged by the router) must not be read as having condemned the
   * post: an absent judgement is not a negative one, and the workflow ships
   * this warn-only for its first three prep runs precisely because nobody has
   * yet seen its false-positive rate.
   */
  publishable: z.boolean().default(true),
});
export type VisualQaVerdict = z.infer<typeof VisualQaVerdictSchema>;

/**
 * P0 parity-audit Fix 2: carousel-agent-v2 SKILL.md step 08 — "look at the
 * PNGs. The renderer proves pixels exist; it does not prove they are good.
 * Check the `check: 'render'` rules from the frozen config: nothing
 * overlapping, no near-empty slide, the closer carries a device. A fail here
 * is `RETURN: 05`." This agent is a deliberate TEXT-PROXY stand-in for real
 * pixel inspection: it is handed the rendered attempt's own structured
 * `fields`/`images` data (never actual pixels) plus the frozen style config's
 * `check: "render"` rules, and judges plausibility from what's actually
 * available. This is honestly weaker than real pixel inspection and is
 * documented as such rather than overclaiming. (Since 2026-09 the workflow's 08a4 step
 * hands it `renderedInspections` — a vision model's reading of the actual
 * PNGs — when a vision backend is configured.)
 *
 * A `pass: false` verdict is routed by the workflow into the SAME step-07
 * self-check retry loop already in place — visual QA failing is
 * conceptually identical to "the assembled contract didn't pass its own
 * check," not a new retry mechanism.
 *
 * `allowedTools: []` — the workflow hand-assembles everything this step
 * needs (the rendered slides' fields/images, the frozen render-type rules,
 * and since 2026-09 the post `format`, so a single-image post is not judged
 * against a rule written for an eight-slide closer).
 *
 * SCRUM-324 (AU40), `@2`: the workflow also passes four ELEVATED criteria as
 * ordinary `renderRules` entries — composition richness, font hierarchy,
 * brand-asset integration, colour harmony (`visual-qa-pre-checks.ts`) — and,
 * when relevant, `brandAssetContext`/`brandPalette` facts the model must
 * treat as already-verified, never re-judge. Every factual half of those four
 * criteria is answered in code BEFORE this agent ever runs; this agent grades
 * only the aesthetic residue.
 *
 * ## Model (2026-09-16): Flash → Pro, and why the tier rises here
 *
 * Gemini 2.5 **Pro** on Vertex, `pinned`. $0.011 → **$0.046** a call, about
 * $0.035 a run and ~3% of a typical run's bill.
 *
 * This is the ONLY place in the workflow where a model is asked *"is this
 * good"*, and since @5 it reads a CONTACT SHEET of every plate at once on top
 * of ~29k tokens of structured evidence — which is exactly the shape of work a
 * stronger judge is worth paying for. The evidence it is worth it: on
 * 2026-09-16 the Flash judge returned `pass: false` on geektime with three
 * correct findings while missing a badge that rendered as `{ FIELD` on all
 * eight plates and three plates that carried nothing but words, and the owner
 * found all of those in seconds. Under the standing ruling that quality comes
 * before cost, a judge reading the whole post is not optional spend.
 *
 * Still `standard` tier, so RFC-15 §8's no-premium-model rule is untouched,
 * and still retargetable per deployment
 * (`MODEL_STEP_INSTAGRAM_VISUAL_QA_VENDOR/_MODEL`) and per run in Studio.
 */
export class InstagramVisualQaAgent extends BaseAgent<VisualQaVerdict> {
  protected readonly config: AgentStepConfig<VisualQaVerdict> = {
    id: "instagram-visual-qa",
    description:
      "Judge a rendered carousel attempt's structured slide data (fields/images, never actual pixels) against the frozen style config's check:'render' rules plus the elevated composition/font-hierarchy/brand-asset-integration/colour-harmony criteria, and report pass/fail with per-rule findings.",
    allowedTools: [],
    outputSchema: VisualQaVerdictSchema,
    modelPolicy: resolveModelPolicy("instagram-visual-qa", { policy: "pinned", model: "gemini-3.1-pro-preview", vendor: "gemini" }),
    // Pinned to "5" (2026-09-16): @5 re-centres the rubric on five POST-LEVEL
    // questions (would a reader stop and swipe; does the post pull forward or
    // repeat itself; is this one visual system or furniture on eight plates;
    // does any slide carry nothing but words; would you publish this for a
    // paying client), takes a CONTACT SHEET of every plate at once as its
    // primary evidence, and emits `publishable`. @4's per-slide rule sections
    // are kept — they catch real defects — but they are no longer what this
    // step is for. @3 and @4 stay frozen.
    skillRef: "instagram-visual-qa@5",
  };
}
