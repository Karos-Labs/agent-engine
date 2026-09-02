import type { ClientBrand, ClientProfile, Competitor } from "@agent-engine/tools";
import type { DegradedContextGroundingMarker } from "@agent-engine/workflow";

/**
 * Step 00's output: the tenant context every later step reads from
 * (RFC-05 §3 step 1). `profile` is the only hard requirement — a missing
 * profile blocks the run entirely (same pattern as every other agent's
 * intake check); `brand`/`competitors` degrade gracefully to an empty
 * shape when the client hasn't set them up yet, since neither is required
 * to attempt a report (a client with no tracked competitors still gets
 * scored on their own content/positioning/etc.).
 */
export interface IntelReportClientContext {
  profile: ClientProfile;
  brand: ClientBrand;
  competitors: Competitor[];
}

/**
 * Step 01's output — the competitive research pull's result, carried
 * forward as both the draft agent's evidence base and (stringified) the
 * `sources` array `gate.numbersSourced` checks the generated report's
 * numeric claims against (RFC-05 §5).
 */
export interface IntelReportResearch {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
}

/**
 * What this workflow hands back to its caller: the deterministically
 * computed score/grade (never trusted to the model, RFC-05 §3 step 4 /
 * `karos-intel`'s `scoring.ts`) plus enough bookkeeping to find the
 * persisted deliverable and report record.
 */
export interface IntelReportAgentWorkflowResult {
  overallScore: number;
  overallGrade: string;
  competitorCount: number;
  deliverableId: string;
  /**
   * SCRUM-242/SCRUM-388 (T-A10) — present when this run's target-audience and
   * market-strategy context docs were both absent. Recurring runs never reach
   * this: intel-report-agent's row is BLOCK, not DEGRADED, so a recurring run
   * with zero grounding throws `WorkflowBlockedIntake` and never returns a
   * result at all. This field is reachable only via SCRUM-388's bootstrap
   * exemption — a `runKind: "setup"` run producing these documents for the
   * first time degrades instead of blocking, and a human/the portal must see
   * that this particular report is the ungrounded bootstrap one, not a
   * silently-degraded recurring report.
   */
  contextGrounding?: DegradedContextGroundingMarker;
}
