import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { gateOutcome, toGateVerdictFromBullets } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "cutaway_check.py";

export const CutawayGateInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and cut-gate.ts's identical field.
  jobPath: z.string().min(1).describe("Path to the job's edit-decision file, including its scheduled cutaways."),
  transcriptPath: z.string().min(1).describe("Path to the source footage's transcript, used to verify cutaway timing against spoken words."),
  /** PLAYBOOK §4d point 2: below a 30s+ runtime, schedule what the runtime allows and pass this — the approved exception, recorded in the run report, never a silent skip. */
  allowCount: z
    .boolean()
    .default(false)
    .describe(
      "PLAYBOOK §4d point 2: below a 30s+ runtime, schedule what the runtime allows and pass this — the approved exception, recorded in the run report, never a silent skip.",
    ),
});
export type CutawayGateInput = z.infer<typeof CutawayGateInputSchema>;

/**
 * `video.cutawayGate` (RFC-06 §2 stage 5b / SKILL.md step 5b): machine-
 * enforces the cutaway schedule before build — count (4-5 per video, unless
 * `allowCount`), the 80-150ms lead-the-word timing law, word-boundary exit,
 * mutual exclusion with motion-graphic overlays, and burst pacing.
 */
export function createCutawayGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<CutawayGateInput, GateVerdict>({
    name: "video.cutawayGate",
    description:
      "Machine-enforces the cutaway schedule before build: count (4-5 per video, unless allowCount), the 80-150ms lead-the-word timing law, word-boundary exit, mutual exclusion with motion-graphic overlays, and burst pacing.",
    version: TOOL_VERSION,
    inputSchema: CutawayGateInputSchema,
    async execute({ jobPath, transcriptPath, allowCount }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const args = [script.path, "--job", jobPath, "--transcript", transcriptPath, ...(allowCount ? ["--allow-count"] : [])];
      const result = await runtime.runner(runtime.pythonBin, args);
      return gateOutcome(toGateVerdictFromBullets(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
