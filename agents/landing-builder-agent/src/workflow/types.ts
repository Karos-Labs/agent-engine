import type { OutOfScopeItem } from "./feedback.js";

/** `OUTPUT_PATH/result.json`'s shape (AGENT-INVOCATION.md §3) — what the workflow returns. */
export interface LandingBuilderWorkflowResult {
  status: "ok" | "needs_human";
  client: string;
  sitePath: string;
  build: "pass" | "fail" | "skipped";
  gate: "pass" | "fail";
  assumptions: string[];
  preview: string;
  /** Non-empty only on a `MODE=rebuild` run — the requests classified as a fresh build, not this rebuild (FEEDBACK.md §3), surfaced for a human, never silently dropped. */
  outOfScope: OutOfScopeItem[];
  /**
   * The ledger deliverable id for this run's uploaded site bundle, and the
   * GCS prefix every uploaded file shares — `undefined` when
   * `landing.uploadSiteBundle` isn't registered (no `GCS_ARTIFACTS_BUCKET`
   * configured), matching every other GCS-gated tool's zero-config
   * degrade-gracefully behavior. A site has no single-URL "the bundle" the
   * way a one-file MP4/PNG deliverable does — `gcsPrefix` is a directory,
   * not a downloadable object.
   */
  deliverableId?: string;
  gcsPrefix?: string;
}
