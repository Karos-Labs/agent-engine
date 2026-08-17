import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "1.0.0";

/** A reasonable H1/title ceiling for a blog article — generous compared to an SEO <title> tag, still a real ceiling. */
const BLOG_TITLE_LIMIT = 120;
/** SEO best-practice ceiling for a meta description (roughly what search results actually render). */
const BLOG_META_DESCRIPTION_LIMIT = 160;
/** The article body's long-form editorial ceiling (matches gate.lintPost's own "blog" entry). */
const BLOG_BODY_LIMIT = 20000;
/** Roughly what's visible above the fold on a blog index/detail page before scrolling. */
const BLOG_FOLD_CHARACTERS = 280;
/** The minimum word count for a real long-form article — a 200-word stub should never clear this check just because it's under the upper ceiling. */
export const BLOG_MIN_WORD_COUNT = 600;
/**
 * The maximum word count for a real long-form article — legacy's target band
 * is 1,500-2,500 words (`writing-quality.md` §2, `acceptance-bar.md` §3:
 * "outside the band should have been flagged in the run"). Set above the
 * 2,500-word upper edge of that band (not equal to it) so a piece that's
 * merely thorough isn't held for the same reason as one that's genuinely
 * bloated — distinct from, and much lower than, `BLOG_BODY_LIMIT`'s raw
 * 20,000-character ceiling, which a real article could theoretically clear
 * while still being a wall of unfocused padding no reader finishes.
 */
export const BLOG_MAX_WORD_COUNT = 3000;

export const RenderPreviewInputSchema = z.object({ title: z.string(), metaDescription: z.string(), text: z.string() });
export type RenderPreviewInput = z.infer<typeof RenderPreviewInputSchema>;

export interface RenderPreviewResult {
  titleCharacterCount: number;
  titleWithinLimit: boolean;
  metaDescriptionCharacterCount: number;
  metaDescriptionWithinLimit: boolean;
  bodyCharacterCount: number;
  bodyWithinLimit: boolean;
  /** A mechanical word count — blog editorial ceilings are usually discussed in words, not characters. */
  wordCount: number;
  /** True only when `wordCount` clears the `BLOG_MIN_WORD_COUNT` floor — a short stub should never pass just because it's under the upper character ceiling. */
  wordCountWithinFloor: boolean;
  /** True when `wordCount` exceeds `BLOG_MAX_WORD_COUNT` — distinct from `bodyWithinLimit`'s raw character ceiling: a piece can be well within 20,000 characters and still be well outside the 1,500-2,500 word target band, and that case deserves its own flag rather than shipping silently. */
  wordCountAboveCeiling: boolean;
  /** True only when the title, meta description, and body all clear their own limits, and the article's word count is both within the floor and not above the ceiling. */
  withinLimit: boolean;
  /** What a reader sees on a blog index/detail page before scrolling further. */
  aboveTheFold: string;
  /** The full article, truncated with an ellipsis if the body exceeds the platform limit — never invented, just a mechanical preview. */
  rendered: string;
}

/**
 * `render.preview` (agent-specific, not a shared karos-* server): a small,
 * deterministic "how would this actually look as a published article"
 * check. Blog has three independent length constraints — `title` (120
 * chars), `metaDescription` (160 chars, an SEO-specific concern none of the
 * other agents have), and the article `text` body (20,000 chars) — distinct
 * from the content-judgment gates (`gate.lintPost`, `gate.numbersSourced`,
 * `gate.brandCompliance`), which only ever see the composed `text`. It also
 * enforces a lower bound: `wordCountWithinFloor` (`BLOG_MIN_WORD_COUNT`, 600
 * words) exists precisely because the three character ceilings above only
 * ever stop an article from being too long — nothing previously stopped a
 * 200-word stub from clearing every gate. `wordCountAboveCeiling`
 * (`BLOG_MAX_WORD_COUNT`, 3,000 words) is the upper-band mirror of that same
 * gap: `bodyWithinLimit`'s 20,000-character ceiling is an editorial-safety
 * backstop, not the same thing as legacy's 1,500-2,500 word target band, so
 * a piece well outside that band could previously clear every check here.
 * Lives alongside the agent that uses it rather than in `packages/tools/`,
 * since it's blog-specific rendering logic, not a general Layer 3 capability
 * every agent needs.
 */
export const renderPreview: AgentTool<RenderPreviewInput, RenderPreviewResult> = defineTool({
  name: "render.preview",
  version: TOOL_VERSION,
  inputSchema: RenderPreviewInputSchema,
  async execute({ title, metaDescription, text }) {
    const titleCharacterCount = title.length;
    const titleWithinLimit = titleCharacterCount <= BLOG_TITLE_LIMIT;
    const metaDescriptionCharacterCount = metaDescription.length;
    const metaDescriptionWithinLimit = metaDescriptionCharacterCount <= BLOG_META_DESCRIPTION_LIMIT;
    const bodyCharacterCount = text.length;
    const bodyWithinLimit = bodyCharacterCount <= BLOG_BODY_LIMIT;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const wordCountWithinFloor = wordCount >= BLOG_MIN_WORD_COUNT;
    const wordCountAboveCeiling = wordCount > BLOG_MAX_WORD_COUNT;
    const aboveTheFold = text.length > BLOG_FOLD_CHARACTERS ? `${title}\n${text.slice(0, BLOG_FOLD_CHARACTERS)}…` : `${title}\n${text}`;
    const rendered = bodyWithinLimit ? text : `${text.slice(0, BLOG_BODY_LIMIT - 1)}…`;
    return success<RenderPreviewResult>({
      titleCharacterCount,
      titleWithinLimit,
      metaDescriptionCharacterCount,
      metaDescriptionWithinLimit,
      bodyCharacterCount,
      bodyWithinLimit,
      wordCount,
      wordCountWithinFloor,
      wordCountAboveCeiling,
      withinLimit: titleWithinLimit && metaDescriptionWithinLimit && bodyWithinLimit && wordCountWithinFloor && !wordCountAboveCeiling,
      aboveTheFold,
      rendered,
    });
  },
});
