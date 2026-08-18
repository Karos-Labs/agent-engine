import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

export const LandingCopyOutputSchema = z.object({
  /** `LandingContent.lang` (content-schema.ts) — e.g. `"en-US"`, from `brand.voice.lang`. */
  lang: z.string().min(1),
  /** `LandingContent.meta` — the real `<html>`/`<head>` title + meta description this client's site ships, patched into `layout.tsx` by MAKE. Real marketing copy, not filler: the same on-brand discipline as every section below. */
  meta: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
  }),
  /** Keyed by a taxonomy section id (ENGINE-SPEC §7) — the copy for whichever sections the intake facts actually support. Left as `unknown` per key deliberately: the taxonomy spans ten structurally different section shapes, and over-specifying one rigid `LandingContent` schema here would recreate exactly the "one fintech template forced on every brand" problem ENGINE-SPEC §5 phase 3 exists to avoid. `landing-compose-agent` and `landing.gate`'s structure check are what actually validate the built output; this step's job is on-brand prose, not schema policing. */
  sections: z.record(z.string(), z.unknown()),
  /** Facts assumed rather than given (e.g. a placeholder used for missing media, per ENGINE-SPEC §13's media A/B/C options) — carried into `result.json.assumptions[]` (AGENT-INVOCATION.md §3). */
  assumptions: z.array(z.string()).default([]),
});
export type LandingCopyOutput = z.infer<typeof LandingCopyOutputSchema>;

/**
 * Phase 2 COPY (ENGINE-SPEC §5): raw intake facts -> on-brand copy, obeying
 * `brandLaw` + `voice` — never a client's raw sentences pasted in, never a
 * generic template's stock copy. `carryForward[]` items are echoed back into
 * whichever section they belong in (ENGINE-SPEC §3: "re-apply each restyled
 * to the new brand"), never silently dropped.
 */
export class LandingCopyAgent extends BaseAgent<LandingCopyOutput> {
  protected readonly config: AgentStepConfig<LandingCopyOutput> = {
    id: "landing-copy",
    description: "Write on-brand landing-page copy for every section the intake facts support, obeying brandLaw and voice, never a stock template's copy.",
    allowedTools: [],
    outputSchema: LandingCopyOutputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "landing-copy@1",
  };
}
