import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { toGateVerdictFromPrefixedLines } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "brand_check.py";

export const BrandGateInputSchema = z.object({
  profilePath: z.string().min(1),
  /** One or more rendered PNGs (a graphic frame, a cutaway plate, an endcard) — every meaningfully-visible pixel must sit near the profile's palette. */
  imagePaths: z.array(z.string().min(1)).min(1),
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
    version: TOOL_VERSION,
    inputSchema: BrandGateInputSchema,
    async execute({ profilePath, imagePaths }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return success<GateVerdict>({ verdict: "tooling_error", reason: script.reason, toolVersion: TOOL_VERSION });
      }
      const args = [script.path, "--profile", profilePath, ...imagePaths];
      const result = await runtime.runner(runtime.pythonBin, args);
      return success(toGateVerdictFromPrefixedLines(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
