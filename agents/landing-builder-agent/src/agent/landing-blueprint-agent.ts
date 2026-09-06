import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { PageBlueprintSchema, type PageBlueprint } from "@agent-engine/tool-karos-landing";

/**
 * Phase 1 BLUEPRINT (RFC-11 §4): every design and copy decision for one
 * client's page, in structured form, from everything the engine already
 * knows about the client: the portal brand kit, the six context documents,
 * the captured current site, the portal brief, and any hand-curated
 * `landing/brand.json`. The build step then implements this record; it does
 * not re-decide the brand or invent a fact.
 *
 * Opus, pinned: this is the one step where reading ~30k tokens of a
 * client's own documents and deciding what the page should SAY is the whole
 * job. Sonnet-tier drafts here were the v1 complaint ("not good enough"):
 * competent, generic, and blind to what the old site already did well.
 */
export class LandingBlueprintAgent extends BaseAgent<PageBlueprint> {
  protected readonly config: AgentStepConfig<PageBlueprint> = {
    id: "landing-blueprint",
    description:
      "Decide the page: point of view, palette and type from the brand kit, section plan and final copy from the client's own documents and current site, carry-forward items, sourced facts, banned phrases, the signature moment.",
    allowedTools: [],
    outputSchema: PageBlueprintSchema,
    maxTokens: 24_000,
    modelPolicy: resolveModelPolicy("landing-blueprint", { policy: "pinned", model: "claude-opus-4-8", contentLanguageSensitive: true }),
    skillRef: "landing-blueprint@1",
  };
}
