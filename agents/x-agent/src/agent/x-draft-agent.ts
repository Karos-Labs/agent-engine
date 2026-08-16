import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/** A single X post (RFC-02 §3). */
export const XPostOutputSchema = z.object({
  text: z.string().min(1),
  hook: z.string().min(1),
  angle: z.string().min(1),
  targetHandle: z.string().min(1),
  mediaRefs: z.array(z.string()).default([]),
});
export type XPostOutput = z.infer<typeof XPostOutputSchema>;

/**
 * The RFC-02 §3 pilot agent: drafts exactly one X post per run (RFC-01
 * §16.2's "one post, one run" ruling). `skillRef` resolves the full craft
 * policy (voice, hook construction, formatting) dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` covers the mechanical render check and the three
 * content gates; `gate.lintPost` also runs as this agent's own self-critique,
 * bounded to one revision. `gateArgs: {platform: "x"}` pins that check to
 * X's real 280-character limit explicitly — the draft object handed to
 * self-critique is the model's raw turn output, before `outputSchema`
 * defaults ever apply, so leaving `platform` for the model to supply would
 * silently fall back to `gate.lintPost`'s generic 5000-character limit.
 */
export class XDraftAgent extends BaseAgent<XPostOutput> {
  protected readonly config: AgentStepConfig<XPostOutput> = {
    id: "x-draft",
    description: "Draft a single X post for the selected candidate topic and angle.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: XPostOutputSchema,
    // Pinned — RFC-02 §3: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "x-craft@1",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "x" } },
  };
}
