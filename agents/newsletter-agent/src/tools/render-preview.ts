import { z } from "zod";
import { checkLength, defineTool, success, truncateAtFold, truncateToLimit } from "@agent-engine/tool-common";
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

export const RenderPreviewInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment and execute()'s usage.
  subjectLine: z.string().describe("The edition's email subject line. Checked against a 70-character ceiling (roughly where most inbox clients truncate it)."),
  previewText: z.string().describe("The edition's preview text/preheader. Checked against a 140-character ceiling (roughly where most inbox clients truncate it)."),
  text: z.string().describe("The composed edition body. Checked against a 10,000-character ceiling."),
});
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
  description:
    "A small, deterministic 'how would this actually look in an inbox' check: subject-line/preview-text/body length ceilings, distinct from the content-judgment gates.",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ subjectLine, previewText, text }) {
    const { characterCount: subjectLineCharacterCount, withinLimit: subjectLineWithinLimit } = checkLength(
      subjectLine,
      NEWSLETTER_SUBJECT_LINE_LIMIT,
    );
    const { characterCount: previewTextCharacterCount, withinLimit: previewTextWithinLimit } = checkLength(
      previewText,
      NEWSLETTER_PREVIEW_TEXT_LIMIT,
    );
    const { characterCount: bodyCharacterCount, withinLimit: bodyWithinLimit } = checkLength(text, NEWSLETTER_BODY_LIMIT);
    const aboveTheFold = `${subjectLine}\n${truncateAtFold(text, NEWSLETTER_FOLD_CHARACTERS)}`;
    const rendered = truncateToLimit(text, NEWSLETTER_BODY_LIMIT);
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
