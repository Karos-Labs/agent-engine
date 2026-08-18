import { defineTool, success } from "@agent-engine/tool-common";
import { DEFAULT_TRIAGE_CONFIG } from "./config.js";
import { triage } from "./triage.js";
import { TriageToolInputSchema, type TriageToolInput } from "./schemas.js";
import type { TriageConfig, TriageResult } from "./types.js";

const TOOL_VERSION = "1.0.0";

/**
 * `reputation.triage` (RFC-08 §2/§9): the deterministic routing authority.
 * "The model extracts, arithmetic routes" — this tool never calls a model
 * and never touches the network; it is pure, stdlib-only arithmetic over a
 * frozen rubric, exposed as a tool purely for registry-call consistency with
 * every other Layer 3 capability (the RFC itself notes this could be called
 * in-process from a `wf.step.code` just as easily — it is still `code` tier
 * either way, never a model turn).
 */
export function createReputationTriage() {
  return defineTool<TriageToolInput, TriageResult>({
    name: "reputation.triage",
    version: TOOL_VERSION,
    inputSchema: TriageToolInputSchema,
    async execute({ payload, config }) {
      const cfg = (config ?? DEFAULT_TRIAGE_CONFIG) as TriageConfig;
      return success<TriageResult>(triage(payload, cfg));
    },
  });
}
