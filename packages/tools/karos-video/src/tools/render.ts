import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";

const TOOL_VERSION = "1.1.0";
const SCRIPT_NAME = "build_short.py";

export const RenderInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  profilePath: z.string().min(1).describe("Path to the client's brand-profile.json."),
  jobPath: z.string().min(1).describe("Path to the job's edit-decision file passed to build_short.py's --job argument."),
  /**
   * `"base"` stops after `edit/base.mp4` — segments extracted, graded and
   * concatenated, nothing composited. That file is what `graphic_qa.py`
   * gates every overlay AGAINST (visibility over the real footage at its
   * scheduled time/position), so the workflow renders it once, gates the
   * plan on it, and only then pays for the full composite. `"full"` (the
   * default) is the finished, captioned, endcarded MP4.
   */
  stage: z
    .enum(["base", "full"])
    .default("full")
    .describe('"base": stop after edit/base.mp4, the footage timeline graphic_qa.py gates against; "full" (default): the finished MP4.'),
});
export type RenderInput = z.infer<typeof RenderInputSchema>;

export interface RenderResult {
  outputPath: string;
  /** `null` when the success line printed but its duration segment did not parse — never fabricated. Always `null` for `stage: "base"`, which prints no duration. */
  durationSeconds: number | null;
  stage: "base" | "full";
  stdout: string;
  /**
   * Non-fatal advisories printed on a successful (exit 0) build — today
   * that's only the caption-density check ("  caption density WARNING: 3+
   * consecutive chunks without an emphasis word...", `build_short.py`'s own
   * enforcement of PLAYBOOK §2's "one decisive word every chunk or two").
   * `build_short.py` never fails its own exit code over this; surfacing it
   * here is what lets the workflow carry it forward instead of the line
   * being silently discarded once `stdout` is otherwise parsed.
   */
  warnings: string[];
}

/** `build_short.py`'s own success line: `"done: {out_path}  duration={dur}s  (side-data clean)"`. */
const DONE_LINE = /done:\s*(\S.*?)\s{2,}duration=([\d.]*)s/;
/** `build_short.py --until base`'s own stop line: `"base: {edit}/base.mp4"`. */
const BASE_LINE = /^base:\s*(\S.*)$/m;

/** Any line containing "WARNING" — today that's only the caption-density check, but matched generically rather than against that one literal string. */
function extractWarnings(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("WARNING"));
}

/**
 * `video.render` (RFC-06 §2 stage 6): the actual ffmpeg/PIL encode — no
 * model call, and never a content gate itself (a render failure is a
 * tooling problem, not a judgment about the video). `build_short.py` prints
 * its own success line and calls `sys.exit("FAILED: ...")` (exit code 1,
 * message on stderr) on any ffmpeg/PIL error, so a non-zero exit here always
 * maps to `tooling_error`, never `content_fail` — this tool never returns a
 * `GateVerdict`.
 *
 * 1.1.0: `stage: "base"` (see `RenderInputSchema`). The finished file used
 * to be what the graphics gate ran against, which measured each overlay's
 * visibility over a frame that already contained that overlay.
 */
export function createRender(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<RenderInput, RenderResult>({
    name: "video.render",
    description:
      "The actual ffmpeg/PIL encode — no model call, and never a content gate itself: a render failure is a tooling problem, not a judgment about the video, so a non-zero exit always maps to tooling_error, never content_fail. stage \"base\" renders only edit/base.mp4, the footage timeline the graphics gate judges overlays against.",
    version: TOOL_VERSION,
    inputSchema: RenderInputSchema,
    async execute({ profilePath, jobPath, stage }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const args = [script.path, "--profile", profilePath, "--job", jobPath, ...(stage === "base" ? ["--until", "base"] : [])];
      const result = await runtime.runner(runtime.pythonBin, args);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`${SCRIPT_NAME} exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      if (stage === "base") {
        const base = BASE_LINE.exec(result.stdout);
        if (!base) {
          return toolingError(`${SCRIPT_NAME} --until base exited 0 but printed no parseable "base: ..." line: ${result.stdout.trim().slice(-2000)}`);
        }
        return success<RenderResult>({ outputPath: base[1]!.trim(), durationSeconds: null, stage, stdout: result.stdout, warnings: extractWarnings(result.stdout) });
      }
      const match = DONE_LINE.exec(result.stdout);
      if (!match) {
        return toolingError(`${SCRIPT_NAME} exited 0 but printed no parseable "done: ..." line: ${result.stdout.trim().slice(-2000)}`);
      }
      const [, outputPath, durationRaw] = match;
      const durationSeconds = durationRaw && durationRaw.length > 0 ? Number.parseFloat(durationRaw) : Number.NaN;
      return success<RenderResult>({
        outputPath: outputPath!,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        stage,
        stdout: result.stdout,
        warnings: extractWarnings(result.stdout),
      });
    },
  });
}
