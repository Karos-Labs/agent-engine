import { defineTool, success } from "@agent-engine/tool-common";
import { DEFAULT_TRIAGE_CONFIG } from "./config.js";
import { triage } from "./triage.js";
import { TriageToolInputSchema, type TriageToolInput } from "./schemas.js";
import type { TriageResult } from "./types.js";

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
    description:
      "The deterministic routing authority: scores and routes each review to RESPOND / FLAG / NO_ACTION and detects crisis conditions, using pure arithmetic over a frozen rubric. Never calls a model and never touches the network — \"the model extracts, arithmetic routes\".",
    version: TOOL_VERSION,
    inputSchema: TriageToolInputSchema,
    async execute({ payload, config }) {
      // No cast: TriageConfigSchema's platform_visibility now requires `default`
      // (z.object({default:z.number()}).catchall(z.number())), matching TriageConfig's
      // own `Record<string, number> & {default: number}` exactly — the bridge the old
      // `as TriageConfig` cast was papering over is now actually checked by the compiler
      // (a triage-config-hardening audit finding).
      const cfg = config ?? DEFAULT_TRIAGE_CONFIG;
      return success<TriageResult>(triage(payload, cfg));
    },
  });
}
