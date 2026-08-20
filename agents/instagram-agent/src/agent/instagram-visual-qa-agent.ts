import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { VisualQaOutputSchema, type VisualQaOutput } from "../workflow/types.js";

/**
 * P0 parity-audit Fix 2: carousel-agent-v2 SKILL.md step 08 — "look at the
 * PNGs. The renderer proves pixels exist; it does not prove they are good.
 * Check the `check: 'render'` rules from the frozen config: nothing
 * overlapping, no near-empty slide, the closer carries a device. A fail here
 * is `RETURN: 05`." This repo has no real vision-capable image-inspection
 * tool wired in anywhere yet — the same documented class of gap as
 * `InstagramImageVettingAgent`'s own text-only candidate judging — so this
 * agent is a deliberate TEXT-PROXY stand-in for real pixel inspection: it is
 * handed the rendered attempt's own structured `fields`/`images` data (never
 * actual pixels) plus the frozen style config's `check: "render"` rules, and
 * judges plausibility from what's actually available — e.g. "does this
 * slide's field content suggest a bare number with no accompanying
 * device/figure note", "does the closer slide's `images` reference a photo
 * or device". This is honestly weaker than real pixel inspection (it cannot
 * see actual overlap, actual whitespace, or an actual empty-looking layout)
 * and is documented as such rather than overclaiming.
 *
 * A `pass: false` verdict is routed by the workflow into the SAME step-07
 * self-check retry loop already in place (`create-instagram-agent-workflow.ts`)
 * — visual QA failing is conceptually identical to "the assembled contract
 * didn't pass its own check," not a new retry mechanism.
 *
 * `allowedTools: []` — same reasoning as every other bounded agent in this
 * package: the workflow hand-assembles everything this step needs (the
 * rendered slides' fields/images, the frozen render-type rules) ahead of time.
 */
export class InstagramVisualQaAgent extends BaseAgent<VisualQaOutput> {
  protected readonly config: AgentStepConfig<VisualQaOutput> = {
    id: "instagram-visual-qa",
    description:
      "Judge a rendered carousel attempt's structured slide data (fields/images, never actual pixels) against the frozen style config's check:'render' rules, and report pass/fail with per-rule findings.",
    allowedTools: [],
    outputSchema: VisualQaOutputSchema,
    // Pinned — matches every other agent in this package (RFC-02 §5).
    modelPolicy: resolveModelPolicy("instagram-visual-qa", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "instagram-visual-qa@1",
  };
}
