import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ArtDirectorOutputSchema, type ArtDirectorOutput } from "../workflow/visual-direction.js";

/**
 * RFC-13 Phase 3, item Q, step `00d2-derive-visual-direction`: the six to ten
 * art-direction lines every generated image for this client inherits for a
 * quarter.
 *
 * ## What it replaces
 *
 * One sentence. `image.generate`'s brief falls back to `"Style: realistic
 * photography, natural lighting, clean composition."` whenever the caller
 * supplies no direction, and until this step existed the Instagram caller
 * always did: `artDirectionFor` read only `BrandTokens.aesthetic` /
 * `.lighting` / `.palette` / `.visualMood`, four optional fields no client
 * config in the fleet sets. Every generated slide for every client was drawn
 * to the same twelve words — the "generic stock" failure `buildBrief`'s own
 * doc comment warns about, and the image half of the owner's complaint that
 * the output reads as machine-made.
 *
 * ## Why an agent rather than a template over the brand kit
 *
 * `fallbackVisualDirection` IS that template, and it ships in the same change
 * as the insurance behind this step. It gets to about four flat lines because
 * a brand kit says what colour things are, not what a photograph of this
 * client's work is OF. Turning "a managed AI content engine for B2B founders"
 * plus eleven of the client's own high-engagement posts plus three pages of
 * their site into "a laptop on a kitchen table at 6am, not a boardroom" is
 * the judgment this call is for, and it is exactly the judgment no
 * deterministic derivation can make.
 *
 * ## Everything it reads is hand-assembled
 *
 * `allowedTools: []`, `maxSteps: 1`. `buildVisualDirectionInput` gathers the
 * client's visual-pattern profile (when consent exists — usually it does
 * not), the brand kit, the persisted `ClientBrief`, up to three of their own
 * site pages and `media.inspectImages` DESCRIPTIONS of their own post images.
 * That makes this a fixed one-call bill on the setup meter rather than an
 * open-ended research loop, the shape every agent in this package has.
 *
 * ## Model: Sonnet, pinned, and the cost that justifies it
 *
 * `claude-sonnet-4-6` — no Opus anywhere, per the owner's rule. ~5k in /
 * 1.2k out ≈ **$0.042, once per client per 90 days**
 * (`VISUAL_DIRECTION_TTL_DAYS`), on the SEPARATE per-client setup budget
 * (target $2.00, hard max $3.00 — `planSetupBudget`, whose fifth lever turns
 * this whole block off). At a weekly cadence that is roughly a third of a
 * cent per run amortised. Sonnet rather than Flash because these lines are
 * the standing brief for about thirteen posts' worth of generated images: a
 * flat line here is not one weak image, it is a quarter of them, and it is
 * the single cheapest place in the pipeline to buy taste.
 *
 * `contentLanguageSensitive: false`, deliberately and unlike
 * `InstagramBriefAgent` and `InstagramDesignBriefAgent`: the output is an
 * English generation brief addressed to an image model, never client-facing
 * copy. Hebrew and Arabic clients get Hebrew and Arabic SLIDES — that is
 * `target-language.ts`'s job — but "soft north light, shallow depth of
 * field" is instruction, and translating it would only degrade what the
 * image model understands.
 *
 * ## Failure posture
 *
 * A malformed answer is a `content_fail`, which `00d2` records as a warn.
 * The run then falls through to `fallbackVisualDirection`, so the direction
 * is weaker but never absent and the neutral one-liner still never ships.
 * Setup never blocks a run.
 */
export class InstagramArtDirectorAgent extends BaseAgent<ArtDirectorOutput> {
  protected readonly config: AgentStepConfig<ArtDirectorOutput> = {
    id: "instagram-art-director",
    description:
      "Derive this client's standing visual direction: six to ten generation-ready lines across subject, light, palette and treatment, an explicit forbid list and one style lock — each line grounded in a named basis (an evidence URL from the client's own posts, a brand-kit token, or a site page), and anything that cannot be grounded reported as a gap rather than asserted.",
    allowedTools: [],
    outputSchema: ArtDirectorOutputSchema,
    maxSteps: 1,
    // Ten lines with a basis and a confidence each, four axis arrays, the
    // forbid list, the style lock and the gaps. A turn that runs out of room
    // does not come back short, it comes back unparseable — and this runs
    // once per client per 90 days, so the headroom is free.
    maxTokens: 3_000,
    modelPolicy: resolveModelPolicy("instagram-art-director", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: false }),
    skillRef: "instagram-art-director@1",
  };
}
