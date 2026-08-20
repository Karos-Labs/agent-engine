import { BaseAgent, resolveModelPolicy, type AgentStepConfig, type BaseAgentRuntime } from "@agent-engine/core";
import { StyleExplorationOutputSchema, type StyleExplorationOutput } from "../workflow/types.js";

/**
 * The onboarding-only Style Exploration step (RFC-06 §1/§2 — the second of
 * the two judgment islands / SKILL.md "per-client onboarding" step 2):
 * proposes exactly three candidate style directions from the client's own
 * brand material. A human locks exactly one (the `style_exploration_lock`
 * gate); every video after that is mechanical. Runs once per client, ever —
 * never part of the per-upload pipeline.
 *
 * Wired with a `selfCritique` gate (`gate.styleTokenFidelity`, P1#6 audit
 * fix) enforcing SKILL.md's "token fidelity is a HARD GATE — off-palette
 * caps the score": unlike the graphics agent's archetype check, this one
 * fits `BaseAgent`'s built-in gate+revise loop cleanly, since the check runs
 * directly on the draft (no rendered file needed in between) — the exact
 * shape `gate.numbersSourced`/`gate.brandCompliance` already use elsewhere
 * in this codebase. `brand` is captured at construction time and merged
 * onto every draft via `gateArgs` (a `selfCritique.gateArgs` static field,
 * same convention `doctrine-gate`/`lint-post` document), since it's fixed
 * for the lifetime of one onboarding run, never something the model
 * supplies itself.
 */
export class BrandedShortsStyleExplorationAgent extends BaseAgent<StyleExplorationOutput> {
  protected readonly config: AgentStepConfig<StyleExplorationOutput>;

  constructor(runtime: BaseAgentRuntime, brand: Record<string, unknown>) {
    super(runtime);
    this.config = {
      id: "branded-shorts-style-exploration",
      description:
        "Propose exactly three candidate style directions (palette usage, caption treatment, graphics direction, endcard treatment) derived only from the client's own brand material — never an off-palette color, generic font, or invented device. Every literal hex code used must be declared in paletteTokensUsed.",
      allowedTools: [],
      outputSchema: StyleExplorationOutputSchema,
      modelPolicy: resolveModelPolicy("branded-shorts-style-exploration", { policy: "pinned", model: "claude-sonnet-4-6" }),
      skillRef: "branded-shorts-style-exploration@1",
      selfCritique: {
        gateTool: "gate.styleTokenFidelity",
        maxRevisions: 1,
        gateArgs: { brand },
      },
    };
  }
}
