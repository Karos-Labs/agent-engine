import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { gateOutcome, toGateVerdictFromPrefixedLines } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "graphic_qa.py";

export const GraphicsGateInputSchema = z.object({
  // No existing TSDoc on these two fields to transcribe (SCRUM-293 flag) — synthesized from assets-check.ts's identical field and execute()'s usage.
  profilePath: z.string().min(1).describe("Absolute or resolvable path to the client's brand-profile.json."),
  /** The footage timeline to test against (`base.mp4` — SKILL.md's per-overlay real-footage requirement). */
  videoPath: z.string().min(1).describe("The footage timeline to test against (base.mp4 — SKILL.md's per-overlay real-footage requirement)."),
  jobPath: z.string().min(1).describe("Path to the job's edit-decision file, including scheduled overlay placements/timing."),
});
export type GraphicsGateInput = z.infer<typeof GraphicsGateInputSchema>;

/**
 * `video.graphicsGate` (RFC-06 §2 stage 5 / PLAYBOOK §4c): wraps
 * `graphic_qa.py`, which already re-uses `brand_check.py`'s own palette
 * function internally (`graphic_qa.py` imports `check as palette_check`
 * directly — it is not a second subprocess) — so one script call covers all
 * four mandatory checks per overlay: palette, visibility over the ACTUAL
 * footage at its scheduled time/position, chroma safety under 4:2:0, and
 * motion sanity. FAIL = auto-remedy (heavier rim / reposition / thicken)
 * then re-gate; never ship a borderline graphic.
 */
export function createGraphicsGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<GraphicsGateInput, GateVerdict>({
    name: "video.graphicsGate",
    description:
      "Covers all four mandatory per-overlay checks in one call: palette, visibility over the actual footage at its scheduled time/position, chroma safety under 4:2:0, and motion sanity. A fail is auto-remedied (heavier rim / reposition / thicken) then re-gated — never ship a borderline graphic.",
    version: TOOL_VERSION,
    inputSchema: GraphicsGateInputSchema,
    async execute({ profilePath, videoPath, jobPath }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const args = [script.path, "--profile", profilePath, "--video", videoPath, "--job", jobPath];
      const result = await runtime.runner(runtime.pythonBin, args);
      return gateOutcome(toGateVerdictFromPrefixedLines(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
