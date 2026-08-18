import { BaseAgent, GateVerdictSchema, type AgentStepConfig, type GateVerdict } from "@agent-engine/core";

/**
 * Phase 5 GATE, Layer 3 (ENGINE-SPEC §8 / RFC-07 §7): the one judgment pass
 * `gate.mjs`'s own header comment defers to "the landing-builder gate phase"
 * — reads the rendered page against, in strict order, (1) the client's
 * guidelines, (2) the 9-site craft floor (linear.app, tailwindcss.com,
 * resend.com, stripe.com/billing, pitch.com, framer.com,
 * vercel.com/templates, cruip.com, cuberto.com — a quality bar, never a look
 * to copy), (3) the "not boring" bar (>=1 real signature moment —
 * scroll-scrubbed/pinned/interactive, not just fades — showing contrast,
 * scale, or depth), (4) the first-pass bar (ENGINE-SPEC §3: client-ready on
 * v1, not a skeleton). Deliberately a bounded `BaseAgent` step, not a
 * `karos-landing` tool (RFC-07 §7: "likely a bounded agent step rather than
 * a tool, since it is a judgment call") — this is the one place in the
 * pipeline a model's taste, not a script, is the check. Its output IS a
 * `GateVerdict` (reused directly, not a superset) so the workflow's
 * gate-then-one-fix step (ENGINE-SPEC §8: "on fail -> one targeted fix pass
 * -> re-check") drives off the exact same three-way contract every other
 * gate in this repo does.
 */
export class LandingCraftVerdictAgent extends BaseAgent<GateVerdict> {
  protected readonly config: AgentStepConfig<GateVerdict> = {
    id: "landing-craft-verdict",
    description:
      "Judge the built landing page against, in order: the client's brand guidelines, the 9-site craft floor, the not-boring bar (>=1 real signature moment), and the first-pass bar. Return pass/fail with specific reasons.",
    allowedTools: [],
    outputSchema: GateVerdictSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "landing-craft-verdict@1",
  };
}
