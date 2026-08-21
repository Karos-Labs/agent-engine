/**
 * Mirrors karosCMO's real `DynamicAgentRunStep`/`DynamicAgentRunReport`
 * (`src/lib/types.ts`) — the portal-facing contract RFC-01 §7 targets, not
 * an idealized reinterpretation of it. Two fields are additive per RFC-01
 * §7.2 and marked as such below: `costUsd` and `tokensIn`/`tokensOut`. The
 * portal ignores them until its UI catches up; everything else is the exact
 * shape already shipping there.
 */
export interface DynamicAgentRunStepCapabilities {
  allowNetwork: boolean;
  allowClientData: boolean;
  networkHonored: boolean;
  clientDataHonored: boolean;
}

export interface DynamicAgentRunStepModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
}

export interface DynamicAgentRunStepUsage {
  totalCostUsd?: number;
  numTurns?: number;
  models: Record<string, DynamicAgentRunStepModelUsage>;
}

/**
 * One executed step, as persisted on the job (karosCMO's real shape). `error`
 * is a raw engine diagnostic with zero client-facing wording — the step bar
 * derives its own copy from `status`; never print `error` on a client screen.
 */
export interface DynamicAgentRunStep {
  stepId: string;
  type: "ai" | "code";
  label: string;
  /**
   * Binary-when-terminal by design (RFC-01 §7.2) — agent-engine's richer
   * taxonomy (`content_fail`/`tooling_error`/`budget_exceeded`) collapses to
   * `"failed"` here, with detail in `error`. `"running"` is additive
   * (real-time progress reporting): a step whose checkpoint exists but hasn't
   * reached a terminal state yet — the portal ignores it until its UI
   * catches up, same precedent as `costUsd`/`tokensIn`/`tokensOut`.
   */
  status: "done" | "failed" | "running";
  durationMs: number;
  /** Concrete model this step ran on — staff-facing audit of per-step routing. */
  model?: string;
  error?: string;
  capabilities?: DynamicAgentRunStepCapabilities;
  /** AI steps only — this step's own token/cost usage. */
  usage?: DynamicAgentRunStepUsage;
  /** Additive (RFC-01 §7.2) — the portal can ignore until its UI catches up. */
  costUsd?: number;
  tokensIn?: { cached: number; uncached: number };
  tokensOut?: number;
}

/**
 * The domain-level outcome vocabulary (RFC-01 §16.2 / RFC-02 §3) — a refinement
 * layered on top of the run's `completed` status, distinguishing "produced a
 * real deliverable" from two legitimate, non-failure empty results. Additive
 * on `DynamicAgentRunReport` (same precedent as `costUsd`/`tokensIn`/
 * `tokensOut`, RFC-01 §7.2) — the portal ignores it until its UI catches up.
 */
export type DynamicAgentDomainOutcome = "delivered" | "held" | "blocked_intake";

/**
 * A failed step fails the job at that step; `failedStepId`/`failedStepIndex`
 * and `hasPartialOutput` are persisted, not just rendered into an error
 * string (karosCMO's real shape, RFC-01 §7.1).
 */
export interface DynamicAgentRunReport {
  specId: string;
  specVersion: number;
  steps: DynamicAgentRunStep[];
  failedStepId?: string;
  failedStepIndex?: number;
  /** True when earlier steps produced output the client can still be shown. */
  hasPartialOutput?: boolean;
  /** Additive (RFC-01 §16.2) — present only when the run resolved to `completed`/`held`/`blocked_intake`. */
  domainOutcome?: DynamicAgentDomainOutcome;
  /** Explains a `held`/`blocked_intake` `domainOutcome` — absent for `delivered`. */
  domainOutcomeReason?: string;
}

/**
 * The authoring-time step manifest the serializer needs alongside the
 * engine's own execution records — labels and step "kind" that Layer 1's own
 * stores don't persist (they don't need them for resumability). Analogous to
 * one `DynamicAgentSpec.steps` entry on the portal side (RFC-01 §7.1).
 */
export interface DynamicAgentStepDescriptor {
  /** Must match the `id` passed to `step.code`/`step.agent`, or `${fanoutId}__${slotId}` for one fan-out slot. */
  stepId: string;
  label: string;
  type: "ai" | "code";
}
