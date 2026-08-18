import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "build_short.py";

export const RenderInputSchema = z.object({
  profilePath: z.string().min(1),
  jobPath: z.string().min(1),
});
export type RenderInput = z.infer<typeof RenderInputSchema>;

export interface RenderResult {
  outputPath: string;
  /** `null` when the success line printed but its duration segment did not parse — never fabricated. */
  durationSeconds: number | null;
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
 */
export function createRender(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<RenderInput, RenderResult>({
    name: "video.render",
    version: TOOL_VERSION,
    inputSchema: RenderInputSchema,
    async execute({ profilePath, jobPath }) {
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) {
        return toolingError(script.reason);
      }
      const result = await runtime.runner(runtime.pythonBin, [script.path, "--profile", profilePath, "--job", jobPath]);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`${SCRIPT_NAME} exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
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
        stdout: result.stdout,
        warnings: extractWarnings(result.stdout),
      });
    },
  });
}
