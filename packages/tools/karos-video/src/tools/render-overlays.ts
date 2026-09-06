import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { gateOutcome, toGateVerdictFromBullets } from "../gate-helpers.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "render_overlays.py";

export const RenderOverlaysInputSchema = z.object({
  profilePath: z.string().min(1).describe("Absolute or resolvable path to the client's brand-profile.json — the archetypes take every colour, font and mark from it."),
  jobPath: z.string().min(1).describe("Path to the job whose overlays[] (file pattern, window, archetype, optional label) are rendered to their PNG sequences."),
});
export type RenderOverlaysInput = z.infer<typeof RenderOverlaysInputSchema>;

/**
 * `video.renderOverlays` (RFC-06 §2 stage 5, the half that was missing):
 * renders every planned motion-graphic overlay to the frame sequence
 * `build_short.py` composites and `graphic_qa.py` gates, from the client's
 * approved archetype repertoire parameterised by their brand profile
 * (`engine/render_overlays.py`). Until this tool existed the plan pointed at
 * directories nothing wrote, so every real run would have failed the
 * graphics gate with NO FRAMES FOUND regardless of the plan's quality (P0#2).
 *
 * Returns a `GateVerdict` rather than a bare result on purpose: a failure
 * here is either a PLAN defect the graphics agent can fix on its next attempt
 * (an archetype with no renderer; a `callout` with no `label`) or a
 * configuration gap (a profile with no display font or brand mark), and the
 * bullet report names which. `content_fail` feeds the workflow's existing
 * remedy loop exactly like a failed `video.graphicsGate`; a crash with no
 * parseable report is a `tooling_error`.
 */
export function createRenderOverlays(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<RenderOverlaysInput, GateVerdict>({
    name: "video.renderOverlays",
    description:
      "Renders every planned overlay's PNG frame sequence from the client's brand-driven archetype repertoire, into the directories the job's overlays[] point at — the frames build_short.py composites and video.graphicsGate judges. A plan naming an archetype with no renderer, or a callout with no label, is a content_fail the plan can fix; a missing brand asset is reported by name.",
    version: TOOL_VERSION,
    inputSchema: RenderOverlaysInputSchema,
    async execute({ profilePath, jobPath }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const result = await runtime.runner(runtime.pythonBin, [script.path, "--profile", profilePath, "--job", jobPath]);
      const verdict = toGateVerdictFromBullets(result, SCRIPT_NAME, TOOL_VERSION);
      if (verdict.verdict === "pass") {
        // Carry the per-overlay `rendered ...` lines as evidence — the summary
        // alone ("OVERLAYS: PASS (2 rendered)") does not say WHICH sequences exist.
        const rendered = result.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("rendered "));
        return gateOutcome({ ...verdict, evidence: [...verdict.evidence, ...rendered] });
      }
      return gateOutcome(verdict);
    },
  });
}
