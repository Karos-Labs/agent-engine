import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { EntitySetSchema, type EntitySet } from "../workflow/entity-imagery.js";

/**
 * `04b3-extract-entities` — Phase 5.5, item A2.
 *
 * ## Why a step at all, when the fact cards are right there
 *
 * Because "which proper nouns in this evidence are things a photograph can be
 * OF" is a judgement, not a regex. A card that reads *"OpenAI shipped GPT-5.2
 * to ChatGPT Enterprise on Tuesday"* names three entities of two different
 * kinds, one of which (`ChatGPT`) has a screenshot-able interface, one of
 * which (`OpenAI`) has a press page, and one of which (`GPT-5.2`) has no
 * photographable surface at all. A proper-noun extractor returns all three
 * with equal confidence and the sourcing queue then spends its tiers on the
 * one that cannot be pictured.
 *
 * ## Why it is cheap, and why it must stay cheap
 *
 * `gemini-2.5-flash`, `maxTokens: 2_000`, once per run, over the deduped fact
 * cards plus the selected topic and chosen angle: ~$0.003. It runs BEFORE the
 * attempt loop, so a redraft never pays for it twice, and it is a
 * quality-affecting step under the owner's 2026-09-16 ruling — the budget
 * plan may reorder work around it and may never drop it.
 *
 * ## What code does after it, and why the schema alone is not the guard
 *
 * `groundEntities` drops any entity whose `name` does not appear verbatim in
 * a fact card or the angle. The schema requires `cardIds` to be non-empty,
 * but a required field is a field a model fills in — `cardIds` is the model's
 * CLAIM about where it read the name, and the code check is the repo's
 * standing answer to that class of claim (`numbers-gate-fed-urls-not-content`:
 * a gate fed a URL instead of the content it was supposed to check passed
 * everything for three weeks). The two together are belt and braces; the
 * schema alone is neither.
 *
 * ## No tools
 *
 * `allowedTools: []`. Everything this step reads is assembled by the workflow
 * from evidence the run already paid for, and an entity extractor with a web
 * search is an entity extractor that can invent a domain it then asks us to
 * fetch — which is the exact thing `officialDomain`'s own doc comment forbids.
 */
export class InstagramEntityAgent extends BaseAgent<EntitySet> {
  protected readonly config: AgentStepConfig<EntitySet> = {
    id: "instagram-entities",
    description:
      "Read this run's fact cards, selected topic and chosen angle, and list the real-world entities the post NAMES that a picture could be OF — product, company, person, event, place or work — each with the card ids that name it, whether a person is a public figure, the official domain only when a card cited it, and how central it is to the post.",
    allowedTools: [],
    outputSchema: EntitySetSchema,
    maxSteps: 1,
    // Eight entities at their schema maxima serialise to roughly 1,100
    // characters of JSON — ~300 tokens of English. 2,000 is ~6x the maximal
    // output, which is the headroom `setup-ceilings.test.ts` established as
    // the house rule after three setup agents came back `tooling_error` on
    // 2026-09-16 for having none. It is not raisable "for safety" past this:
    // a ceiling this far above the schema means a truncation here is a bug in
    // the prompt, not a budget, and it should look like one.
    maxTokens: 2_000,
    // Flash, pinned. This is extraction over text the workflow assembled, with
    // a closed vocabulary and a code guard behind it — the shape Flash is
    // reliable on and the shape a stronger model would buy nothing on. The
    // judgement that needed the tier rise this phase is the VET, which looks
    // at pictures (`instagram-image-vet@6`, now `gemini-2.5-pro`).
    modelPolicy: resolveModelPolicy("instagram-entities", { policy: "pinned", model: "gemini-3.8-flash", vendor: "gemini" }),
    skillRef: "instagram-entities@1",
  };
}
