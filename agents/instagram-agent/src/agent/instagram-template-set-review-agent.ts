import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { StudioSetReviewOutputSchema, type StudioSetReviewOutput } from "../workflow/template-studio.js";

/**
 * Phase 2, item N, step `00c6-review-template-set`: per-template
 * `keep`/`repair`/`drop`, plus one note on whether the set reads as ONE
 * system.
 *
 * ## Why this call is small
 *
 * Everything factual about these templates has already been answered in code
 * before this runs: the eight validation gates (routable id, slot contract,
 * markup safety, code-owned document, a real Chromium render, the interest
 * floor at the declared role with a calibration margin, contrast and palette,
 * RTL and script fonts), the measured pixel metrics of each rendered sample,
 * and a `media.inspectImages` description of what those samples actually look
 * like. What is left is the residue — *do these five templates look like five
 * views of one design system, or five design systems* — which is a judgment
 * no measurement in this repo can make and no gate here pretends to.
 *
 * That is the same residue split `08a2`/`08b` already use, and the same
 * reason those two steps are on Flash.
 *
 * ## Honest about what it cannot catch
 *
 * The gates catch empty, illegible and incoherent. **None of them catches
 * dull.** This call is the cheapest available second opinion on dullness and
 * it is deliberately not the last one: every studio row is stored
 * `enabled: false` and a human approves the set at the review gate before a
 * single post renders through it. A `drop` here costs one template; a set
 * that reads badly to a person costs one `revise`, and `reviewTemplate`'s
 * -15 drops a disliked design out of contention immediately.
 *
 * ## Model: Gemini 2.5 Flash
 *
 * Pinned, ~6k in / 1k out ≈ **$0.004 per setup**, on the SEPARATE setup
 * budget — a rounding error next to the $0.25-$0.31 of authoring it grades,
 * and the first lever the budget pulls after the reference-image vision pass
 * (`planSetupBudget` lever 2), precisely because the eight gates still run
 * without it. Retargetable per deployment and per run in Studio, like every
 * other pinned step here.
 *
 * `allowedTools: []`, `maxSteps: 1` — `00c5` hands it the descriptions and the
 * numbers; it reads nothing on its own.
 */
export class InstagramTemplateSetReviewAgent extends BaseAgent<StudioSetReviewOutput> {
  protected readonly config: AgentStepConfig<StudioSetReviewOutput> = {
    id: "instagram-template-set-review",
    description:
      "Grade a freshly generated per-client Instagram template set: keep/repair/drop per template with a reason, plus one note on whether the set reads as one design system. Every factual check (slots, safety, render, interest floor, contrast, RTL) has already run in code — judge only the residue.",
    allowedTools: [],
    outputSchema: StudioSetReviewOutputSchema,
    maxSteps: 1,
    maxTokens: 2_000,
    modelPolicy: resolveModelPolicy("instagram-template-set-review", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
    skillRef: "instagram-template-set-review@1",
  };
}
