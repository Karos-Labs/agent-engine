import type { ClientBrand, ClientProfile, Competitor } from "@agent-engine/tools";

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
}
