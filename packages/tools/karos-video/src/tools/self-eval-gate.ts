import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoToolOptions } from "../config.js";

const TOOL_VERSION = "1.0.0";

export const SelfEvalGateInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  videoPath: z.string().min(1).describe("Path to the finished, rendered video file to run the post-encode bitstream color-tag check against."),
  /**
   * Non-fatal advisories carried forward from `video.render`'s stdout (e.g.
   * `build_short.py`'s caption-density warning, PLAYBOOK §2) — folded into
   * this gate's own evidence, on both `pass` and `content_fail`, so they
   * reach the same audit trail the pipeline's actual QA gate produces
   * instead of being silently dropped once `video.render`'s result is
   * otherwise consumed. Never turned into a `content_fail` on its own:
   * `build_short.py` itself treats this as advisory, not fatal.
   */
  renderWarnings: z
    .array(z.string())
    .default([])
    .describe(
      "Non-fatal advisories carried forward from video.render's stdout (e.g. build_short.py's caption-density warning, PLAYBOOK §2) — folded into this gate's own evidence, on both pass and content_fail, never turned into a content_fail on its own.",
    ),
});
export type SelfEvalGateInput = z.infer<typeof SelfEvalGateInputSchema>;

/** `build_short.py`'s own `SDR_TAGS`/`SETPARAMS` constants — every encode must carry exactly these bitstream tags. */
const EXPECTED = { colorSpace: "bt709", colorPrimaries: "bt709", colorTransfer: "bt709", colorRange: "tv" } as const;

interface FfprobeStream {
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
}

/**
 * `video.selfEvalGate` (RFC-06 §2 stage 7 / SKILL.md step 7 / PLAYBOOK §6).
 *
 * PARTIAL IMPLEMENTATION, honestly reported as such (evidence always names
 * what ran): none of the six checked-in engine scripts implement a
 * `self_eval.py` (confirmed by listing `assets/engine/`), so there is no
 * existing CLI contract to wrap for the frame-sampling, saturation-sanity,
 * whole-video flash-scan, or worst-case caption-legibility checks PLAYBOOK
 * §6 describes as running "engine, every build." This tool implements the
 * one check that IS fully specified and independently verifiable from the
 * finished file alone — the post-encode bitstream color-tag check
 * (`build_short.py`'s own `SDR_TAGS`/`SETPARAMS`, the direct fix for the
 * "orange renders as red" HLG bug, Lola 2026-07-06) — via `ffprobe`, and
 * reports the remaining PLAYBOOK §6 checks as not-yet-implemented in its
 * evidence rather than silently claiming full coverage.
 */
export function createSelfEvalGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  const NOT_YET_IMPLEMENTED =
    "NOTE: saturation-sanity, whole-video flash-scan, and caption-legibility checks (PLAYBOOK §6) are not yet implemented — this gate currently verifies post-encode SDR bitstream color tags only";

  return defineTool<SelfEvalGateInput, GateVerdict>({
    name: "video.selfEvalGate",
    description:
      "PARTIAL IMPLEMENTATION, honestly reported as such: verifies the finished file's post-encode SDR bitstream color tags (build_short.py's SDR_TAGS/SETPARAMS, the 'orange renders as red' HLG fix) via ffprobe. The other PLAYBOOK §6 checks (saturation-sanity, flash-scan, caption-legibility) are not yet implemented and are reported as such in this gate's evidence rather than silently claimed as covered.",
    version: TOOL_VERSION,
    inputSchema: SelfEvalGateInputSchema,
    async execute({ videoPath, renderWarnings }) {
      const carriedWarnings = renderWarnings.map((w) => `build warning: ${w}`);
      const args = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=color_space,color_transfer,color_primaries,color_range",
        "-of",
        "json",
        videoPath,
      ];
      const result = await runtime.runner(runtime.ffprobeBin, args);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`ffprobe exited ${result.exitCode} while reading "${videoPath}"${tail ? `: ${tail}` : ""}`);
      }

      let parsed: { streams?: FfprobeStream[] };
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return toolingError(`ffprobe produced non-JSON output for "${videoPath}": ${result.stdout.trim().slice(-500)}`);
      }

      const stream = parsed.streams?.[0];
      if (!stream) {
        return toolingError(`ffprobe reported no video stream for "${videoPath}"`);
      }

      const mismatches: string[] = [];
      if (stream.color_space !== EXPECTED.colorSpace) mismatches.push(`color_space=${stream.color_space ?? "(unset)"} (expected ${EXPECTED.colorSpace})`);
      if (stream.color_primaries !== EXPECTED.colorPrimaries)
        mismatches.push(`color_primaries=${stream.color_primaries ?? "(unset)"} (expected ${EXPECTED.colorPrimaries})`);
      if (stream.color_transfer !== EXPECTED.colorTransfer)
        mismatches.push(`color_transfer=${stream.color_transfer ?? "(unset)"} (expected ${EXPECTED.colorTransfer})`);
      if (stream.color_range !== EXPECTED.colorRange) mismatches.push(`color_range=${stream.color_range ?? "(unset)"} (expected ${EXPECTED.colorRange})`);

      if (mismatches.length > 0) {
        return success<GateVerdict>({
          verdict: "content_fail",
          evidence: [...mismatches, ...carriedWarnings],
          reason: `finished video is missing explicit SDR bitstream tags — a player may render tonemapped orange as HDR red: ${mismatches.join("; ")}`,
          toolVersion: TOOL_VERSION,
        });
      }

      return success<GateVerdict>({
        verdict: "pass",
        evidence: [`post-encode SDR tags confirmed: ${JSON.stringify(EXPECTED)}`, NOT_YET_IMPLEMENTED, ...carriedWarnings],
        toolVersion: TOOL_VERSION,
      });
    },
  });
}
