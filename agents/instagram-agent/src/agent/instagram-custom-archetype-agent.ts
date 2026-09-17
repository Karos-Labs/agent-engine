import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { CustomArchetypeMarkupSchema, type CustomArchetypeMarkup } from "../workflow/types.js";

/**
 * The output ceiling for `05f-author-custom-archetype`.
 *
 * `SlideCustomArchetypeSchema`'s markup half is at most 4,000 characters of
 * `bodyHtml`, 4,000 of `css`, 8 slot names and 8 values of 600 — about 13,300
 * characters, which at the Latin rate measured across the 2026-09-16 prep runs
 * (3.66 characters a token) is ~3,640 output tokens. 8,000 is 2.2x that, which
 * leaves the same kind of room for the model's own planning prose that the copy
 * step turned out to need and nobody had budgeted: on this step the plan is
 * shorter (one layout, not eight slides), but the lesson is the same one and it
 * was learned the expensive way.
 *
 * `InstagramTemplateDesignerAgent` sets 6,000 for a comparable job. This is
 * higher because that step authors against a design brief that has already
 * decided the type scale and the ground, and this one has to decide those too.
 */
export const CUSTOM_ARCHETYPE_MAX_TOKENS = 8_000;

/**
 * Phase 5.5, brief item B3, step `05f-author-custom-archetype`: author the
 * MARKUP for one writer-designed slide layout.
 *
 * ## Why this step exists at all
 *
 * It is a hoist, not a new capability. Until Phase 5.5 the copy step authored
 * `customArchetype.bodyHtml`, `.css` and `.fields` inside the draft: up to
 * 4,000 + 4,000 characters plus an UNBOUNDED record of 2,000-character values,
 * on a step that inherited a 16,384-token output ceiling and hit it on five of
 * six attempts across the three prep runs of 2026-09-16. Three things were
 * wrong with that arrangement and only one of them was the size:
 *
 *   1. It is markup, not copy. The step that decides what a carousel ARGUES was
 *      also the step writing CSS, and the prompt spent ~2,900 characters
 *      teaching it to, on every run, for a block most runs never emit (none of
 *      the six 2026-09-16 runs did).
 *   2. A markup mistake cost the WHOLE DRAFT. `assertSafeMarkup` runs after the
 *      draft parses, so a `<style>` tag in one slide's `bodyHtml` failed a
 *      $0.35 attempt out of three. Here it fails one $0.030 call and the slide
 *      degrades through `assembleSlidesData`'s existing ladder to the archetype
 *      its content fits, exactly as a `stat_callout` with no `stat` does.
 *   3. It made the copy schema's maximum infinite, so no test could hold the
 *      draft against the ceiling. See `__tests__/copy-schema-length.test.ts`.
 *
 * ## What it may and may not author
 *
 * The markup half ONLY: `bodyHtml`, `css`, `slots` and `fields`. The archetype's
 * IDENTITY — its id, its name and the one sentence saying which shape the
 * standard archetypes cannot make — stays with the writer and travels in
 * `SlideCustomArchetypeBrief`, so this step cannot quietly rename a design or
 * re-justify a choice it did not make. `composeCustomArchetype` is the only
 * join, and it takes the identity from the brief and the markup from here.
 *
 * A FRAGMENT and rules, never a document, and never a `<script>`, `<style>`,
 * `<link>`, `<iframe>`, an inline `style=` or an `on*=` handler:
 * `assertSafeMarkup` (`@agent-engine/tool-karos-templates`) is run by the
 * workflow on this output before anything renders, with no privileged
 * substitution options passed, which is the same strict contract the copy step
 * was held to. The boundary is not style. A model that can write the document
 * can also write a `window.__CAROUSEL_READY__` that never fires (the render
 * hangs) or one that fires early (the screenshot catches an unpainted page),
 * and neither is a judgement a validation gate could make.
 *
 * ## Model and cost
 *
 * `claude-sonnet-4-6`, pinned, `contentLanguageSensitive` — the same tier and
 * the same reason as `InstagramTemplateDesignerAgent`: this authors a type
 * scale and a logical-property box model for the client's own script, and
 * Hebrew's wider glyphs are the difference between a headline that fits and one
 * that clips. No Opus inside a run, per the standing rule.
 *
 * ~5.5k in / ~2.5k out = **$0.030 a call**, at most once per carousel and only
 * on a draft that asked for one. `allowedTools: []` and `maxSteps: 1`: the
 * workflow assembles the brief, the slide's own copy, the brand tokens and the
 * canvas, so this is a fixed one-call bill.
 *
 * ## It never holds
 *
 * Every failure mode here is a degrade. A `tooling_error`, a refused
 * `assertSafeMarkup`, a slot in `bodyHtml` that `fields` does not fill: each
 * one drops `layout: "custom"` for that slide and nothing else. The carousel
 * ships one designed layout short, which is what it would have shipped anyway
 * had the writer not reached for the escape hatch.
 */
export class InstagramCustomArchetypeAgent extends BaseAgent<CustomArchetypeMarkup> {
  protected readonly config: AgentStepConfig<CustomArchetypeMarkup> = {
    id: "instagram-custom-archetype",
    description:
      "Author the markup for one writer-designed Instagram slide layout: a bodyHtml fragment, a stylesheet and the value for every declared slot. A fragment and rules only, never a document and never a script, using logical CSS properties and the client's design tokens on a fixed 1080x1440 canvas.",
    allowedTools: [],
    outputSchema: CustomArchetypeMarkupSchema,
    maxSteps: 1,
    maxTokens: CUSTOM_ARCHETYPE_MAX_TOKENS,
    modelPolicy: resolveModelPolicy("instagram-custom-archetype", {
      policy: "pinned",
      model: "claude-sonnet-4-6",
      contentLanguageSensitive: true,
    }),
    skillRef: "instagram-custom-archetype@1",
  };
}
