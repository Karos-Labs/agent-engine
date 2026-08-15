import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

const PLATFORM_MAX_LENGTH: Record<string, number> = {
  twitter: 280,
  x: 280,
  linkedin: 3000,
  instagram: 2200,
  facebook: 5000,
  generic: 5000,
};

export const LintPostInputSchema = z.object({
  text: z.string(),
  platform: z.enum(["twitter", "x", "linkedin", "instagram", "facebook", "generic"]).default("generic"),
});
export type LintPostInput = z.infer<typeof LintPostInputSchema>;

/** Basic hygiene: non-empty, within the platform's length limit, no unresolved markdown link syntax. */
export const lintPost = defineTool<LintPostInput, GateVerdict>({
  name: "gate.lintPost",
  version: TOOL_VERSION,
  inputSchema: LintPostInputSchema,
  async execute({ text, platform }) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: [],
        reason: "text is empty",
        toolVersion: TOOL_VERSION,
      });
    }

    const limit = PLATFORM_MAX_LENGTH[platform] ?? PLATFORM_MAX_LENGTH.generic!;
    if (text.length > limit) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: [`length ${text.length} exceeds the ${platform} limit of ${limit}`],
        reason: `text exceeds the ${platform} length limit (${limit} characters)`,
        toolVersion: TOOL_VERSION,
      });
    }

    const unresolvedLinkMatch = /\[[^\]]+\]\(\s*\)/.exec(text);
    if (unresolvedLinkMatch) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: [unresolvedLinkMatch[0]],
        reason: "text contains an unresolved markdown link (empty href)",
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [`within the ${platform} length limit (${text.length}/${limit})`],
      toolVersion: TOOL_VERSION,
    });
  },
});
