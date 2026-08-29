import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { gateOutcome, toGateVerdictFromBullets } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "cut_check.py";

export const CutGateInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  jobPath: z.string().min(1).describe("Path to the job's edit-decision file (cut list) to check."),
  transcriptPath: z.string().min(1).describe("Path to the source footage's transcript, used to verify each removed span is filler-or-declared."),
  verbose: z.boolean().default(false).describe("Pass --verbose through to cut_check.py for more detailed evidence output."),
});
export type CutGateInput = z.infer<typeof CutGateInputSchema>;

/**
 * `video.cutGate` (RFC-06 §2 stage 2 / SKILL.md step 2): the mechanical
 * cut-craft gate — min segment length, max cut density, minimum retention,
 * and the HONESTY check that every removed span is filler-or-declared.
 * Nothing borderline builds; a `content_fail` here means fix the cut list
 * and re-check, never build anyway.
 */
export function createCutGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<CutGateInput, GateVerdict>({
    name: "video.cutGate",
    description:
      "The mechanical cut-craft gate: min segment length, max cut density, minimum retention, and the honesty check that every removed span is filler-or-declared. content_fail here means fix the cut list and re-check, never build anyway.",
    version: TOOL_VERSION,
    inputSchema: CutGateInputSchema,
    async execute({ jobPath, transcriptPath, verbose }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const args = [script.path, "--job", jobPath, "--transcript", transcriptPath, ...(verbose ? ["--verbose"] : [])];
      const result = await runtime.runner(runtime.pythonBin, args);
      return gateOutcome(toGateVerdictFromBullets(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
