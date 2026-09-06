import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { toGateVerdictFromBullets } from "../gate-helpers.js";

const TOOL_VERSION = "1.1.0";
const SCRIPT_NAME = "self_eval.py";

export const SelfEvalGateInputSchema = z.object({
  videoPath: z.string().min(1).describe("Path to the finished, rendered video file to run the post-encode checks against."),
  renderWarnings: z
    .array(z.string())
    .default([])
    .describe(
      "Non-fatal advisories carried forward from video.render's stdout (e.g. build_short.py's caption-density warning, PLAYBOOK §2) — folded into this gate's own evidence, on both pass and content_fail, never turned into a content_fail on its own.",
    ),
  profilePath: z
    .string()
    .min(1)
    .optional()
    .describe("The client's brand-profile.json — enables self_eval.py's post-encode accent-hue check (the brand accent must still sit at its own hue on the finished file) and the duration-parity check."),
  jobPath: z.string().min(1).optional().describe("The job that produced the file — tells self_eval.py where every overlay sits (accent check) and what the kept runtime should be (duration parity)."),
});
export type SelfEvalGateInput = z.infer<typeof SelfEvalGateInputSchema>;

const EXPECTED = { colorSpace: "bt709", colorPrimaries: "bt709", colorTransfer: "bt709", colorRange: "tv" } as const;

interface FfprobeStream {
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
}

/**
 * `video.selfEvalGate` (PLAYBOOK §6, "before anyone sees the output").
 *
 * Two layers, both on the FINISHED file:
 *
 *   1. Here, via ffprobe: the post-encode SDR bitstream colour tags
 *      (`build_short.py`'s SDR_TAGS/SETPARAMS — the "orange renders as red"
 *      HLG fix). Kept in TypeScript so a deployment with no engine checkout
 *      still gets this much, exactly as before 1.1.0.
 *   2. Via `engine/self_eval.py`, when an engine directory is configured:
 *      the side-data check, the whole-video flash scan, the post-encode
 *      accent-hue check at every overlay, and duration parity. 1.0.0 reported
 *      these honestly as "not yet implemented"; 1.1.0 implements them, and
 *      the evidence names what ran. Caption legibility is deliberately NOT
 *      re-measured here: `build_short.py` already measures it twice on the
 *      real frames and fails its own exit on an emphasis-layer miss.
 *
 * A content problem from either layer is a `content_fail` carrying both
 * layers' evidence; a broken ffprobe or a crashed script is a `tooling_error`.
 */
export function createSelfEvalGate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  const ENGINE_ABSENT_NOTE =
    "NOTE: no engine directory configured (BRANDED_SHORTS_ENGINE_DIR), so self_eval.py's flash-scan, accent-hue, side-data and duration checks did not run — this gate verified the SDR bitstream colour tags only";

  return defineTool<SelfEvalGateInput, GateVerdict>({
    name: "video.selfEvalGate",
    description:
      "Post-encode checks on the finished file: SDR bitstream colour tags via ffprobe (the 'orange renders as red' HLG fix), plus — through the engine's self_eval.py — HDR side-data, a whole-video flash scan (a luma spike reverting within 3 frames), the accent-hue check at every overlay, and duration parity against the job. Any miss is a content_fail carrying every layer's evidence.",
    version: TOOL_VERSION,
    inputSchema: SelfEvalGateInputSchema,
    async execute({ videoPath, renderWarnings, profilePath, jobPath }) {
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

      // Layer 2: the engine's whole-file checks, when there is an engine to run them.
      // Without one, the note rides on a PASS only — a content_fail on the tags
      // already says everything that verdict needs to say.
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      let engineEvidence: string[] = script.ok ? [] : [ENGINE_ABSENT_NOTE];
      let engineFailures: string[] = [];
      if (script.ok) {
        const engineArgs = [script.path, "--video", videoPath, ...(profilePath ? ["--profile", profilePath] : []), ...(jobPath ? ["--job", jobPath] : [])];
        const verdict = toGateVerdictFromBullets(await runtime.runner(runtime.pythonBin, engineArgs), SCRIPT_NAME, TOOL_VERSION);
        if (verdict.verdict === "tooling_error") {
          return toolingError(verdict.reason ?? `${SCRIPT_NAME} failed without a reason`);
        }
        engineEvidence = verdict.evidence;
        if (verdict.verdict === "content_fail") engineFailures = verdict.evidence.filter((e) => !e.startsWith("WARNING"));
      }

      if (mismatches.length > 0 || engineFailures.length > 0) {
        const reasons = [
          ...(mismatches.length > 0 ? [`finished video is missing explicit SDR bitstream tags — a player may render tonemapped orange as HDR red: ${mismatches.join("; ")}`] : []),
          ...engineFailures,
        ];
        return success<GateVerdict>({
          verdict: "content_fail",
          evidence: [...mismatches, ...(script.ok ? engineEvidence : []), ...carriedWarnings],
          reason: reasons.join("; "),
          toolVersion: TOOL_VERSION,
        });
      }

      return success<GateVerdict>({
        verdict: "pass",
        evidence: [`post-encode SDR tags confirmed: ${JSON.stringify(EXPECTED)}`, ...engineEvidence, ...carriedWarnings],
        toolVersion: TOOL_VERSION,
      });
    },
  });
}
