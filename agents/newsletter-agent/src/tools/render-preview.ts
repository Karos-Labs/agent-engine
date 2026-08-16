import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "1.0.0";

/** Roughly where most inbox clients truncate a subject line. */
const NEWSLETTER_SUBJECT_LINE_LIMIT = 70;
/** Roughly where most inbox clients truncate preview text/preheader. */
const NEWSLETTER_PREVIEW_TEXT_LIMIT = 140;
/** The edition body's ceiling (matches gate.lintPost's own "newsletter" entry). */
const NEWSLETTER_BODY_LIMIT = 10000;
/** Roughly what's visible in an inbox reading pane before scrolling. */
const NEWSLETTER_FOLD_CHARACTERS = 240;

export const RenderPreviewInputSchema = z.object({ subjectLine: z.string(), previewText: z.string(), text: z.string() });
export type RenderPreviewInput = z.infer<typeof RenderPreviewInputSchema>;

export interface RenderPreviewResult {
  subjectLineCharacterCount: number;
  subjectLineWithinLimit: boolean;
  previewTextCharacterCount: number;
  previewTextWithinLimit: boolean;
  bodyCharacterCount: number;
  bodyWithinLimit: boolean;
  /** True only when the subject line, preview text, and body all clear their own limits. */
  withinLimit: boolean;
  /** What a subscriber sees in an inbox reading pane before scrolling further. */
  aboveTheFold: string;
  /** The full edition body, truncated with an ellipsis if it exceeds the platform limit — never invented, just a mechanical preview. */
  rendered: string;
}

/**
 * `render.preview` (agent-specific, not a shared karos-* server): a small,
 * deterministic "how would this actually look in an inbox" check.
 * Newsletter has three independent length constraints — `subjectLine` (70
 * chars), `previewText`/preheader (140 chars, an inbox-preview concern none
 * of the other agents have), and the edition `text` body (10,000 chars) —
 * distinct from the content-judgment gates (`gate.lintPost`,
 * `gate.numbersSourced`, `gate.brandCompliance`), which only ever see the
 * composed `text`. Lives alongside the agent that uses it rather than in
 * `packages/tools/`, since it's newsletter-specific rendering logic, not a
 * general Layer 3 capability every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ subjectLine, previewText, text }) {
    const subjectLineCharacterCount = subjectLine.length;
    const subjectLineWithinLimit = subjectLineCharacterCount <= NEWSLETTER_SUBJECT_LINE_LIMIT;
    const previewTextCharacterCount = previewText.length;
    const previewTextWithinLimit = previewTextCharacterCount <= NEWSLETTER_PREVIEW_TEXT_LIMIT;
    const bodyCharacterCount = text.length;
    const bodyWithinLimit = bodyCharacterCount <= NEWSLETTER_BODY_LIMIT;
    const aboveTheFold =
      text.length > NEWSLETTER_FOLD_CHARACTERS ? `${subjectLine}\n${text.slice(0, NEWSLETTER_FOLD_CHARACTERS)}…` : `${subjectLine}\n${text}`;
    const rendered = bodyWithinLimit ? text : `${text.slice(0, NEWSLETTER_BODY_LIMIT - 1)}…`;
    return success<RenderPreviewResult>({
      subjectLineCharacterCount,
      subjectLineWithinLimit,
      previewTextCharacterCount,
      previewTextWithinLimit,
      bodyCharacterCount,
      bodyWithinLimit,
      withinLimit: subjectLineWithinLimit && previewTextWithinLimit && bodyWithinLimit,
      aboveTheFold,
      rendered,
    });
  },
});
