import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { assertNoTraversalOrNul } from "../sandbox.js";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";

const TOOL_VERSION = "1.0.0";
const SCRIPT_NAME = "derive_mark.py";

export const DeriveMarkInputSchema = z
  .object({
    sourcePath: z.string().min(1).optional().describe("The client's logo file (PNG/JPEG/WebP). Its alpha channel is kept when it has a real one; otherwise a mask is derived from the background colour."),
    text: z.string().min(1).max(4).optional().describe("Glyph fallback when there is no logo: the letters to render as the mark (e.g. the brand's initial)."),
    fontPath: z.string().min(1).optional().describe("The TTF to render `text` with; required with `text`."),
    outputPath: z.string().min(1).describe("Where to write the RGBA mark PNG."),
  })
  .refine((v) => v.sourcePath !== undefined || (v.text !== undefined && v.fontPath !== undefined), {
    message: "give sourcePath, or text with fontPath",
  });
export type DeriveMarkInput = z.infer<typeof DeriveMarkInputSchema>;

export interface DeriveMarkResult {
  outputPath: string;
  width: number;
  height: number;
  /** `had_alpha`: the logo already carried a mask; `derived_alpha`: the background was keyed out; `glyph`: rendered from `text`. */
  how: "had_alpha" | "derived_alpha" | "glyph";
}

/**
 * `video.deriveMark`: wraps `derive_mark.py`, which turns a client's logo into
 * the alpha-masked mark the engine's endcard and `logo` archetype paste a tint
 * through. Exists so a client whose brand kit holds only a flattened logo (a
 * screenshot PNG, a JPEG) still gets a mark that renders as a mark and not as
 * a white rectangle, and so a client with no logo at all gets their initial
 * in their own display face. This is what lets a brand profile be DERIVED
 * from a portal brand kit instead of hand-assembled per client.
 */
export function createDeriveMark(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<DeriveMarkInput, DeriveMarkResult>({
    name: "video.deriveMark",
    description:
      "Turns a client's logo (or, without one, their initial rendered in their display font) into the alpha-masked mark PNG the branded-shorts endcard and `logo` overlay tint through. Keys out a flattened logo's background so a screenshot renders as a mark, not a white block.",
    version: TOOL_VERSION,
    inputSchema: DeriveMarkInputSchema,
    async execute({ sourcePath, text, fontPath, outputPath }) {
      for (const [what, value] of [["sourcePath", sourcePath], ["fontPath", fontPath], ["outputPath", outputPath]] as const) {
        if (value !== undefined) assertNoTraversalOrNul(value, what);
      }
      const script = resolveEngineScript(runtime, SCRIPT_NAME);
      if (!script.ok) return toolingError(script.reason);
      const args = [script.path, "--out", outputPath];
      if (sourcePath !== undefined) args.push("--source", sourcePath);
      else args.push("--text", text!, "--font", fontPath!);
      const result = await runtime.runner(runtime.pythonBin, args);
      const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith("MARK: PASS"));
      if (result.exitCode !== 0 || line === undefined) {
        const bullets = `${result.stdout}\n${result.stderr}`
          .split(/\r?\n/)
          .filter((l) => l.startsWith("- "))
          .join("; ");
        return toolingError(`${SCRIPT_NAME} exited ${result.exitCode}: ${bullets || result.stderr.trim() || "no output"}`);
      }
      const match = /^MARK: PASS (\d+)x(\d+) (had_alpha|derived_alpha|glyph)/.exec(line);
      if (!match) return toolingError(`${SCRIPT_NAME} printed an unexpected pass line: ${line}`);
      return success<DeriveMarkResult>({
        outputPath,
        width: Number(match[1]),
        height: Number(match[2]),
        how: match[3] as DeriveMarkResult["how"],
      });
    },
  });
}
