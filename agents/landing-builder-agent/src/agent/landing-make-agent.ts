import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

export const LandingMakeOutputSchema = z.object({
  /** Relative-to-`OUTPUT_PATH/site` paths this step actually wrote via `landing.writeSiteFile`. */
  filesWritten: z.array(z.string().min(1)).min(1),
  assumptions: z.array(z.string()).default([]),
});
export type LandingMakeOutput = z.infer<typeof LandingMakeOutputSchema>;

/**
 * Phase 4 MAKE (ENGINE-SPEC §5/§13 / RFC-07 §4): the one phase that is
 * "literal file read/write/edit — a coding-agent task," per the RFC's own
 * framing, which is why this is a bounded `BaseAgent` with real write tools
 * in `allowedTools` (RFC-01 §5.5's tool-sandboxing design) rather than a
 * hand-rolled deterministic template generator. Given the already-copied
 * template (`landing.copyTemplate` ran in the workflow's own MAKE step
 * before this agent runs), the copy draft, the composed section manifest,
 * and the brand tokens/fonts, this step re-skins `globals.css`'s token
 * block, wires the three `next/font/google` families, writes the content
 * file, composes `page.tsx`'s manifest, and builds any bespoke/carry-forward
 * component `page.tsx` needs — using `landing.readSiteFile` to check the
 * template's existing structure before editing it, and `landing.writeSiteFile`
 * (write-fenced to this client's `OUTPUT_PATH/site` alone, per the tool's own
 * contract) for every change. Never touches `engine/template/` — only the
 * already-copied site directory.
 */
export class LandingMakeAgent extends BaseAgent<LandingMakeOutput> {
  protected readonly config: AgentStepConfig<LandingMakeOutput> = {
    id: "landing-make",
    description: "Re-skin tokens/fonts, write the content file, compose page.tsx's section manifest, and wire any bespoke/carry-forward components into this client's already-copied site directory.",
    allowedTools: ["landing.writeSiteFile", "landing.readSiteFile"],
    outputSchema: LandingMakeOutputSchema,
    maxSteps: 24,
    modelPolicy: resolveModelPolicy("landing-make", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "landing-make@1",
  };
}
