import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "1.0.0";

/** Reddit's real post title limit. */
const REDDIT_TITLE_LIMIT = 300;
/** Reddit's real selftext body limit (matches gate.lintPost's own "reddit" entry). */
const REDDIT_BODY_LIMIT = 40000;
/** Roughly what a feed card shows of the body before "read more" — the title itself is always shown in full. */
const REDDIT_FOLD_CHARACTERS = 150;

export const RenderPreviewInputSchema = z.object({ title: z.string(), text: z.string() });
export type RenderPreviewInput = z.infer<typeof RenderPreviewInputSchema>;

export interface RenderPreviewResult {
  titleCharacterCount: number;
  titleWithinLimit: boolean;
  bodyCharacterCount: number;
  bodyWithinLimit: boolean;
  /** True only when both the title and the body clear their own limits. */
  withinLimit: boolean;
  /** What a scrolling reader sees on the feed card before opening the post — title in full, plus a short body snippet. */
  aboveTheFold: string;
  /** The full post, truncated with an ellipsis if the body exceeds the platform limit — never invented, just a mechanical preview. */
  rendered: string;
}

/**
 * `render.preview` (agent-specific, not a shared karos-* server): a small,
 * deterministic "how would this actually look on Reddit" check. Unlike X and
 * LinkedIn, Reddit has two independent length constraints — the `title`
 * (300 chars) and the `text`/selftext body (40,000 chars) — so this tool
 * checks both, distinct from the content-judgment gates (`gate.lintPost`,
 * `gate.numbersSourced`, `gate.brandCompliance`), which only ever see the
 * composed `text`. Lives alongside the agent that uses it rather than in
 * `packages/tools/`, since it's Reddit-specific rendering logic, not a
 * general Layer 3 capability every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ title, text }) {
    const titleCharacterCount = title.length;
    const titleWithinLimit = titleCharacterCount <= REDDIT_TITLE_LIMIT;
    const bodyCharacterCount = text.length;
    const bodyWithinLimit = bodyCharacterCount <= REDDIT_BODY_LIMIT;
    const aboveTheFold = text.length > REDDIT_FOLD_CHARACTERS ? `${title}\n${text.slice(0, REDDIT_FOLD_CHARACTERS)}…` : `${title}\n${text}`;
    const rendered = bodyWithinLimit ? text : `${text.slice(0, REDDIT_BODY_LIMIT - 1)}…`;
    return success<RenderPreviewResult>({
      titleCharacterCount,
      titleWithinLimit,
      bodyCharacterCount,
      bodyWithinLimit,
      withinLimit: titleWithinLimit && bodyWithinLimit,
      aboveTheFold,
      rendered,
    });
  },
});
