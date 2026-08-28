import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import { BrandProfileSchema } from "../types.js";

const TOOL_VERSION = "1.0.0";

export const ColorGradeInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  profile: BrandProfileSchema.describe("The client's brand-profile.json — read for its optional video_grade lock; a missing lock resolves to \"auto\"."),
});
export type ColorGradeInput = z.infer<typeof ColorGradeInputSchema>;

export interface ColorGradeResult {
  /** Fed verbatim into the job's `grade` field (`build_short.py`'s job spec). */
  grade: string;
  source: "auto" | "profile_locked";
}

/**
 * `video.colorGrade` (RFC-06 §2 stage 4 / PLAYBOOK §4b): "grading is the
 * SYSTEM'S design skill, never a human question." Zero judgment — either the
 * client's profile locks a specific grade (`video_grade`, changing it needs
 * the client's explicit sign-off) or the job defaults to `"auto"`, which
 * `build_short.py`/video-use's per-segment analyzer resolves at render time.
 * No subprocess: this step is pure data resolution, unlike every other
 * `video.*` tool in this package.
 */
export function createColorGrade() {
  return defineTool<ColorGradeInput, ColorGradeResult>({
    name: "video.colorGrade",
    description:
      "Resolves the grade for a build: the client's profile locks a specific grade (video_grade, changing it needs the client's explicit sign-off) or the job defaults to \"auto\", which build_short.py's per-segment analyzer resolves at render time. Zero judgment, no subprocess — pure data resolution.",
    version: TOOL_VERSION,
    inputSchema: ColorGradeInputSchema,
    async execute({ profile }) {
      if (profile.video_grade) {
        return success<ColorGradeResult>({ grade: profile.video_grade, source: "profile_locked" });
      }
      return success<ColorGradeResult>({ grade: "auto", source: "auto" });
    },
  });
}
