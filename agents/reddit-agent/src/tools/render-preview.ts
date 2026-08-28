import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "2.0.0";

/**
 * Reddit's real comment body limit. Comments don't carry a separate title —
 * unlike the old submission shape this replaces, there is exactly one length
 * constraint to check.
 */
const REDDIT_COMMENT_LIMIT = 10000;
/** Roughly what a thread view shows of a long comment before "read more" collapses it. */
const REDDIT_FOLD_CHARACTERS = 300;

export const RenderPreviewInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  text: z.string().describe("The composed reply comment body. Checked against Reddit's real 10,000-character comment limit."),
});
export type RenderPreviewInput = z.infer<typeof RenderPreviewInputSchema>;

export interface RenderPreviewResult {
  characterCount: number;
  /** True when the comment clears Reddit's real 10,000-character comment limit. */
  withinLimit: boolean;
  /** What a scrolling reader sees before "read more" collapses a long comment. */
  aboveTheFold: string;
  /** The full comment, truncated with an ellipsis if it exceeds the platform limit — never invented, just a mechanical preview. */
  rendered: string;
}

/**
 * `render.preview` (agent-specific, not a shared karos-* server): a small,
 * deterministic "how would this actually look on Reddit" check for a reply
 * (RFC-02 §5's reply-only migration, Batch 2.1). Before this batch this
 * checked a submission's independent `title` (300 chars) and `text`/selftext
 * body (40,000 chars) limits — legacy's non-negotiable rule is "comments
 * only, never original posts" (`reddit-agent-v2/SKILL.md` line 9), so there
 * is no title anymore and exactly one real limit to check: Reddit's
 * 10,000-character comment body cap. Distinct from the content-judgment
 * gates (`gate.lintPost`, `gate.numbersSourced`, `gate.brandCompliance`,
 * `gate.noPlaceholder`, `gate.leakCheck`), which check the composed `text`
 * for content, not length against a platform-specific ceiling. Lives
 * alongside the agent that uses it rather than in `packages/tools/`, since
 * it's Reddit-specific rendering logic, not a general Layer 3 capability
 * every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  description:
    "A small, deterministic 'how would this actually look on Reddit' check for a reply: character count against Reddit's real 10,000-character comment limit and fold visibility, distinct from the content-judgment gates.",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ text }) {
    const characterCount = text.length;
    const withinLimit = characterCount <= REDDIT_COMMENT_LIMIT;
    const aboveTheFold = text.length > REDDIT_FOLD_CHARACTERS ? `${text.slice(0, REDDIT_FOLD_CHARACTERS)}…` : text;
    const rendered = withinLimit ? text : `${text.slice(0, REDDIT_COMMENT_LIMIT - 1)}…`;
    return success<RenderPreviewResult>({
      characterCount,
      withinLimit,
      aboveTheFold,
      rendered,
    });
  },
});
