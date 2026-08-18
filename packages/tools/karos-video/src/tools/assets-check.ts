import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { toGateVerdictFromBullets } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "brand_assets_check.py";

export const AssetsCheckInputSchema = z.object({
  /** Absolute or resolvable path to the client's `brand-profile.json`. */
  profilePath: z.string().min(1),
});
export type AssetsCheckInput = z.infer<typeof AssetsCheckInputSchema>;

/**
 * `video.assetsCheck` (RFC-06 §4/§6): wraps `brand_assets_check.py`, which
 * physically OPENS every font/image a client's brand profile references —
 * `os.path.exists()` alone is not enough (the karoslabs 0-byte
 * `Spectral-SemiBold.ttf` incident: a path check passed, the file never
 * loaded). Run this at per-client onboarding and again before any run for a
 * client whose assets may have moved (SKILL.md's own onboarding step 1).
 */
export function createAssetsCheck(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<AssetsCheckInput, GateVerdict>({
    name: "video.assetsCheck",
    version: TOOL_VERSION,
    inputSchema: AssetsCheckInputSchema,
    async execute({ profilePath }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return success<GateVerdict>({ verdict: "tooling_error", reason: script.reason, toolVersion: TOOL_VERSION });
      }
      const result = await runtime.runner(runtime.pythonBin, [script.path, "--profile", profilePath]);
      return success(toGateVerdictFromBullets(result, SCRIPT_NAME, TOOL_VERSION));
    },
  });
}
