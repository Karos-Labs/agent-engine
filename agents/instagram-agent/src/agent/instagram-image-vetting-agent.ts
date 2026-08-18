import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { ImageVettingOutputSchema, type ImageVettingOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 06: "source and vet one picture per slide" — real judgment,
 * not a rubber stamp. Phase 1 has no real internet image-search tool in this
 * repo yet (RFC-03 §1), so this agent is handed a small caller-provided pool
 * of repo-relative candidate image paths (a workflow input, standing in for
 * the real "fetch + open + look at it" tool call) and must judge, per slide,
 * whether any pool candidate actually satisfies that slide's `visualNeed` —
 * does it show what the slide claims, is it the right era, watermark-free,
 * etc. (as much as a text description of a candidate lets it judge).
 *
 * **The preserved legacy-defect fix (RFC-03 §1/§3, "this exact behavior"):**
 * when no candidate in the pool honestly satisfies a slide, this agent must
 * report that slide's `imagePath` as `null` rather than picking the
 * least-bad option or leaving the slide out of its `selections` array
 * entirely. The workflow (`create-instagram-agent-workflow.ts`, step 06)
 * checks for exactly this and throws `WorkflowHeld` for the *whole* post the
 * moment any slide comes back `null` — never a placeholder image, never a
 * silently-dropped slide. This agent's own job is only the honest per-slide
 * verdict; the "hold the whole post" decision is Layer 1's, not this
 * agent's (RFC-01 §4: Layer 2 makes no run-level judgments).
 *
 * **Rights/licence/watermark verification (P0 parity-audit Fix 4) and
 * cross-post reuse (Fix 3):** carousel-agent-v2 SKILL.md step 06 requires
 * "Is it rights-usable, watermark-free, and of the right era? Record per
 * image: the source URL, the licence, and the check verdict" — restored here
 * via `ImageSelectionSchema`'s `license`/`rightsUsable`/`watermarkFree`
 * fields (`workflow/types.ts`), which this agent's output schema now
 * requires per selection. This agent is also handed `usedImages` (every
 * image path already shipped in this client's prior posts, from
 * `ledger.listUsedImages`) and must never select one of them. The workflow
 * additionally, deterministically double-checks both — `rightsUsable:
 * false`/`watermarkFree: false`/a `usedImages` match are all treated exactly
 * like `imagePath: null` (the same `WorkflowHeld` path) — never trusting the
 * model's verdict alone for a "never ship this" guarantee.
 *
 * `allowedTools: []` — the candidate pool, each slide's need, and
 * `usedImages` are fully assembled by the workflow ahead of time; this
 * agent's single turn goes straight to a `final` verdict, same reasoning as
 * the other agents in this package.
 */
export class InstagramImageVettingAgent extends BaseAgent<ImageVettingOutput> {
  protected readonly config: AgentStepConfig<ImageVettingOutput> = {
    id: "instagram-image-vet",
    description: "Judge, per slide, whether any candidate in the supplied image pool actually satisfies that slide's visual need AND is rights-usable, watermark-free, and not already used in a prior post — report null, never a placeholder, when none does.",
    allowedTools: [],
    outputSchema: ImageVettingOutputSchema,
    // Pinned — matches every other agent in this repo (RFC-02 §5); no agent
    // in this codebase yet uses the "portable"/"commodity" tiers RFC-03 §4
    // suggested for this step, so this stays consistent with the other six
    // agents' established convention rather than introducing the first one.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "instagram-image-vet@1",
  };
}
