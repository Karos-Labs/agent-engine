import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "1.0.0";

/** X's actual character limit for a standard post. */
const X_CHARACTER_LIMIT = 280;
/** Roughly what's visible above the "Show more" fold on a typical timeline card. */
const X_FOLD_CHARACTERS = 120;

export const RenderPreviewInputSchema = z.object({ text: z.string() });
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
 * deterministic "how would this actually look on X" check. This is the
 * *mechanical* half of draft QA — character count and fold visibility —
 * distinct from the content-judgment gates (`gate.lintPost`,
 * `gate.numbersSourced`, `gate.brandCompliance`). Lives alongside the agent
 * that uses it rather than in `packages/tools/`, since it's X-specific
 * rendering logic, not a general Layer 3 capability every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ text }) {
    const characterCount = text.length;
    const withinLimit = characterCount <= X_CHARACTER_LIMIT;
    const aboveTheFold = text.length > X_FOLD_CHARACTERS ? `${text.slice(0, X_FOLD_CHARACTERS)}…` : text;
    const rendered = withinLimit ? text : `${text.slice(0, X_CHARACTER_LIMIT - 1)}…`;
    return success<RenderPreviewResult>({ characterCount, withinLimit, aboveTheFold, rendered });
  },
});
