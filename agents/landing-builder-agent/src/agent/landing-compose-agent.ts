import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { LANDING_SECTION_TAXONOMY } from "@agent-engine/tool-karos-landing";

export const LandingComposeOutputSchema = z.object({
  /** The ordered section manifest (ENGINE-SPEC §7) — `nav`/`hero`/`footer` always present, everything else included only when `landing-copy`'s draft actually supplied that section's content. Order here becomes `page.tsx`'s JSX order. Named `manifest`, not `sections`, to keep this unambiguous from `LandingCopyOutput.sections` (a content record, not a section list) wherever both flow through the same code path. */
  manifest: z.array(z.enum(LANDING_SECTION_TAXONOMY)).min(1),
  /** Which manifest section each `carryForward[]` item is wired into — every item must be placed somewhere (ENGINE-SPEC §3), and `signatureShowcase` is the canonical home for the one bespoke set-piece (ENGINE-SPEC §13). */
  carryForwardPlacement: z.array(z.object({ what: z.string().min(1), section: z.enum(LANDING_SECTION_TAXONOMY) })).default([]),
});
export type LandingComposeOutput = z.infer<typeof LandingComposeOutputSchema>;

/**
 * Phase 3 COMPOSE (ENGINE-SPEC §5/§7): choose sections from the fixed
 * taxonomy — content-driven, never template-forced. A section is included
 * only if `landing-copy`'s draft actually supplied its content; the taxonomy
 * itself never dictates inclusion.
 */
export class LandingComposeAgent extends BaseAgent<LandingComposeOutput> {
  protected readonly config: AgentStepConfig<LandingComposeOutput> = {
    id: "landing-compose",
    description: "Choose which taxonomy sections to include and in what order, from the sections the copy draft actually supplied content for, and place every carry-forward item into a section.",
    allowedTools: [],
    outputSchema: LandingComposeOutputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "landing-compose@1",
  };
}
