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
}
