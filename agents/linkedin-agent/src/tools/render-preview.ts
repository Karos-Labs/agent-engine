import { z } from "zod";
import { checkLength, defineTool, success, truncateAtFold, truncateToLimit } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

// 1.0.1 — no behaviour change. `LINKEDIN_CHARACTER_LIMIT` became exported so
// the workflow's length repair can trim to the same number this tool measures
// against, rather than hardcoding a second copy of 3000 that could drift from
// it. A patch bump because the tool's own verdicts are byte-identical, and a
// bump at all because telemetry has to be able to tell the two eras apart.
const TOOL_VERSION = "1.0.1";

/** LinkedIn's actual character limit for a standard feed post (matches gate.lintPost's own table). */
export const LINKEDIN_CHARACTER_LIMIT = 3000;
/** Roughly what's visible above the "…see more" fold before a reader has to tap through. */
const LINKEDIN_FOLD_CHARACTERS = 210;

export const RenderPreviewInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  text: z.string().describe("The composed LinkedIn post text. Checked against LinkedIn's 3,000-character feed-post limit."),
});
export type RenderPreviewInput = z.infer<typeof RenderPreviewInputSchema>;

export interface RenderPreviewResult {
  characterCount: number;
  withinLimit: boolean;
  /** What a scrolling reader sees before the fold — this is what the hook actually has to earn attention with. */
  aboveTheFold: string;
  /** The full post, truncated with an ellipsis if it exceeds the platform limit — never invented, just a mechanical preview. */
  rendered: string;
}

/**
 * `render.preview` (agent-specific, not a shared karos-* server): a small,
 * deterministic "how would this actually look on LinkedIn" check. This is
 * the *mechanical* half of draft QA — character count and fold visibility —
 * distinct from the content-judgment gates (`gate.lintPost`,
 * `gate.numbersSourced`, `gate.brandCompliance`). Lives alongside the agent
 * that uses it rather than in `packages/tools/`, since it's LinkedIn-specific
 * rendering logic, not a general Layer 3 capability every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  description:
    "A small, deterministic 'how would this actually look on LinkedIn' check: character count and fold visibility, distinct from the content-judgment gates.",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ text }) {
    const { characterCount, withinLimit } = checkLength(text, LINKEDIN_CHARACTER_LIMIT);
    const aboveTheFold = truncateAtFold(text, LINKEDIN_FOLD_CHARACTERS);
    const rendered = truncateToLimit(text, LINKEDIN_CHARACTER_LIMIT);
    return success<RenderPreviewResult>({ characterCount, withinLimit, aboveTheFold, rendered });
  },
});
