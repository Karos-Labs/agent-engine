import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { gateOutcome, toGateVerdictFromPrefixedLines } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "brand_check.py";

export const BrandGateInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from assets-check.ts's identical field.
  profilePath: z.string().min(1).describe("Absolute or resolvable path to the client's brand-profile.json."),
  /** One or more rendered PNGs (a graphic frame, a cutaway plate, an endcard) — every meaningfully-visible pixel must sit near the profile's palette. */
  imagePaths: z
    .array(z.string().min(1))
    .min(1)
    .describe("One or more rendered PNGs (a graphic frame, a cutaway plate, an endcard) — every meaningfully-visible pixel must sit near the profile's palette."),
});
export type BrandGateInput = z.infer<typeof BrandGateInputSchema>;

/**
 * `video.brandGate` (PLAYBOOK §4c layer 3 / Lola 2026-07-06): the standalone
 * palette + zero-tolerance-red gate, usable on any rendered image — a
 * cutaway plate, an endcard, a one-off asset — independent of the full
 * per-overlay `video.graphicsGate` pipeline.
 */
export function createBrandGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<BrandGateInput, GateVerdict>({
    name: "video.brandGate",
    description:
      "The standalone palette + zero-tolerance-red gate, usable on any rendered image — a cutaway plate, an endcard, a one-off asset — independent of the full per-overlay video.graphicsGate pipeline.",
    version: TOOL_VERSION,
    inputSchema: BrandGateInputSchema,
    async execute({ profilePath, imagePaths }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const args = [script.path, "--profile", profilePath, ...imagePaths];
      const result = await runtime.runner(runtime.pythonBin, args);
      return gateOutcome(toGateVerdictFromPrefixedLines(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
