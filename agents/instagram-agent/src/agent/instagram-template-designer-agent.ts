import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { StudioTemplateDraftSchema, type StudioTemplateDraft } from "../workflow/template-studio.js";

/**
 * Phase 2, item N, steps `00c4-design-template-<archetypeId>` and
 * `00c7-repair-template-<archetypeId>`: authors ONE per-client slide template
 * — a `bodyHtml` fragment, a stylesheet, a sample and the evidence it derives
 * from — for a NAMED routable archetype.
 *
 * ## One call per template, not one for the set
 *
 * At ~$0.051 a call, six templates cost $0.31 of a $2.00 setup budget, and in
 * exchange two things get much better. A schema failure or a refused
 * validation gate costs ONE template instead of six (the set still ships,
 * one short, and the bundled archetype covers that slot). And each layout
 * gets the whole context window rather than a sixth of it, which matters
 * because what this call actually has to hold is a type scale, a ground, a
 * slot contract and an RTL-safe box model at once.
 *
 * ## What it may and may not author
 *
 * A FRAGMENT and a STYLESHEET, never a document. `buildStudioTemplateDocument`
 * writes the doctype, the head, the font links, the `:root` token block, the
 * reset, the fixed 1080x1440 canvas, the standing brand furniture and the
 * `window.__CAROUSEL_READY__` script the renderer waits on before it
 * screenshots. That boundary is not style: a model that can write the ready
 * flag can also write one that never fires (the render hangs) or one that
 * fires too early (the screenshot catches an unpainted page), and neither is
 * a judgment a validation gate could make.
 *
 * The privileged substitution forms are opt-in per template, and the studio
 * opts in only for what it declared: `{{image:hero}}` when the ground is
 * `image`, `{{html:device}}`/`{{html:recap}}`/`{{html:itemRows}}` when that
 * slot is declared — because those fragments are built by CODE. A
 * run-authored custom archetype keeps the stricter contract by passing no
 * options at all (`assertSafeMarkup`).
 *
 * Every draft then faces the eight-gate battery before it is stored: a
 * routable id, the slot contract against what `contentFor` can actually
 * supply, markup safety, code-owned document, a real Chromium render at
 * `canvas.scale: 2` of CODE-BUILT sample content, the item-L interest floor
 * at the declared role with a >= 0.05 calibration margin, contrast and
 * palette, and — for a non-Latin target language — an RTL render whose script
 * font must actually have loaded. **A template that is boring is refused at
 * generation rather than discovered in production**, which is the owner's
 * complaint answered in code.
 *
 * ## Model: Sonnet, and the cost that justifies it
 *
 * `claude-sonnet-4-6`, pinned, `contentLanguageSensitive`. Sonnet because a
 * weak layout is not one bad post — it is every post for this client until
 * the next setup, 120 days out; and `contentLanguageSensitive` because it
 * authors a type scale and a logical-property box model for the client's own
 * script (Hebrew's `typeScale: 0.94` and its wider glyph widths are the
 * difference between a headline that fits and one that clips).
 *
 * The bill: ~7k in / 2.0k out ≈ **$0.051 per template**, four to six per
 * client per 120 days, plus at most two repairs at ~$0.048, all on the
 * SEPARATE setup budget. No Opus, per the owner's rule.
 *
 * `allowedTools: []`, `maxSteps: 1` — `00c2`/`00c3` assemble every source, so
 * this is a fixed one-call bill. A repair call is the same agent with the
 * failing gates and their MEASURED NUMBERS in the input (`repairFindings`),
 * because a repair that is not told the number it missed is a re-roll.
 */
export class InstagramTemplateDesignerAgent extends BaseAgent<StudioTemplateDraft> {
  protected readonly config: AgentStepConfig<StudioTemplateDraft> = {
    id: "instagram-template-designer",
    description:
      "Author one per-client Instagram slide template for a named routable archetype: a bodyHtml fragment, a stylesheet, a sample filling every declared slot, and the measured format it derives from. A fragment and a stylesheet only — never a document, never a <script> — using logical CSS properties and the design tokens, and reading only the slots that archetype's content can fill.",
    allowedTools: [],
    outputSchema: StudioTemplateDraftSchema,
    maxSteps: 1,
    // HTML plus CSS plus a sample is ~2k output tokens for a real layout, and
    // a truncated stylesheet is an unparseable turn rather than a short one.
    maxTokens: 6_000,
    modelPolicy: resolveModelPolicy("instagram-template-designer", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "instagram-template-designer@1",
  };
}
