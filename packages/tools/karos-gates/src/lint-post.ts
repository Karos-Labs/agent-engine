import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * Em dash, en dash, and a literal double ASCII hyphen (the typed stand-in for
 * an em dash) — the single most-cited "AI tell" across every migrated
 * agent's legacy craft rules, all of which ban double hyphens by name
 * alongside the unicode dashes (e.g. Newsletter's "NO EM DASHES, EN DASHES,
 * OR DOUBLE HYPHENS anywhere... a single dash is a failure").
 */
const DASH_PATTERN = /[—–]|--/;

/**
 * Markdown table delimiter rows ("|---|---|", "| :--- | ---: |") use hyphens
 * for pure structural alignment, not as an em-dash stand-in — legacy's own
 * blog delivery gate had this exact carve-out ("a markdown table separator
 * is not read as a double hyphen"), lost when the shared gate's double-hyphen
 * check was added. Matches a line made up only of pipes/colons/hyphens/
 * whitespace, containing at least one hyphen.
 */
const MARKDOWN_TABLE_DELIMITER_LINE = /^[\s|:-]*-[\s|:-]*$/;

/**
 * CLI-style flag tokens ("--file", "--dry-run") use a double hyphen as an
 * option prefix, not an em-dash stand-in. Matched only when the "--" starts
 * a fresh token (not itself preceded by a word character or another hyphen)
 * and is immediately followed by a letter.
 */
const CLI_FLAG_TOKEN = /(?<![\w-])--(?=[a-zA-Z])/g;

/** CSS `!important` uses `!` as syntax, not an emphatic exclamation. */
const CSS_IMPORTANT = /!\s*important\b/gi;

/**
 * Strips the three false-positive shapes above before the dash/exclamation
 * checks run — legacy had already solved all three (a blog draft embedding a
 * markdown table, a code snippet with a CLI example, or an embedded CSS
 * rule), and the fix carried the stricter rules forward without carrying
 * these carve-outs with them. Deliberately narrow: a written-out range
 * ("15% to 20%") or other prose uses of "--"/"!" are unaffected.
 */
function stripAntiSlopExemptions(text: string): string {
  const withoutTableRows = text
    .split("\n")
    .filter((line) => !MARKDOWN_TABLE_DELIMITER_LINE.test(line.trim()))
    .join("\n");
  return withoutTableRows.replace(CLI_FLAG_TOKEN, "‑‑").replace(CSS_IMPORTANT, "");
}

/**
 * The full legacy banned-phrase bank, restored from the migration audit's
 * per-agent findings (Reddit's `check-draft.mjs` BANNED_PHRASES/PITCH_TELLS,
 * X/LinkedIn's engagement-bait and hook-shape bans, Blog/Newsletter's
 * throat-clearing and filler-phrase lists) — every legacy generation banned
 * some slice of this list, either as prose or as a mechanical script check.
 * Matched case-insensitively as substrings.
 */
const DEFAULT_BANNED_PHRASES = [
  // corporate-enthusiasm tells
  "thrilled to",
  "excited to",
  "honored to",
  "delighted",
  "delighted to",
  "game-changer",
  "game changer",
  "let's dive in",
  "tapestry",
  // throat-clearing / filler / hedging
  "it's worth noting that",
  "in today's fast-paced world",
  "at the end of the day",
  "in conclusion",
  "that said",
  "i'd be happy to help",
  "great question",
  "delve into",
  "needle-mover",
  "unlock the power",
  "supercharge",
  "revolutionize",
  "seamless integration",
  // engagement-bait / hook shapes
  "unpopular opinion:",
  "hot take:",
  "nobody talks about",
  "agree?",
  "thoughts?",
  "rt if",
  "drop a 🔥",
  "comment below",
  "let me know your thoughts",
  // sales / pitch tells
  "feel free to dm",
  "check out our",
  "check out my",
  "we offer",
  "our platform helps",
  "link in my bio",
  "don't miss out",
  "limited time",
  "act now",
];

const PLATFORM_MAX_LENGTH: Record<string, number> = {
  twitter: 280,
  x: 280,
  linkedin: 3000,
  instagram: 2200,
  facebook: 5000,
  // Reddit's real selftext body limit — the post title has its own, much
  // shorter 300-character limit, checked separately (not by this gate).
  reddit: 40000,
  // A long-form editorial ceiling for a single blog post (~3,000-4,000
  // words) — the title and meta description have their own much shorter
  // limits, checked separately (not by this gate).
  blog: 20000,
  // A newsletter edition's body ceiling — the subject line (~70 chars) and
  // preview text/preheader (~140 chars) have their own much shorter limits,
  // checked separately (not by this gate).
  newsletter: 10000,
  generic: 5000,
};

export const LintPostInputSchema = z.object({
  // No existing TSDoc on these two fields to transcribe (SCRUM-293 flag) — descriptions below synthesized from the tool's own doc comment and PLATFORM_MAX_LENGTH's usage.
  text: z.string().describe("The draft text to lint."),
  platform: z
    .enum(["twitter", "x", "linkedin", "instagram", "facebook", "reddit", "blog", "newsletter", "generic"])
    .default("generic")
    .describe("Which platform's length limit to check the text against (see PLATFORM_MAX_LENGTH). Defaults to \"generic\"."),
  checkAntiSlop: z
    .boolean()
    .default(true)
    .describe(
      "Set false to skip the mechanical anti-AI-tell check below — on by default so every self-critique call exercises it without each workflow opting in.",
    ),
  maxExclamationMarks: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      "Zero-tolerance by default, matching legacy's absolute \"no exclamation marks\" / \"auto-reject\" rule across every migrated platform. Raise per-call only for a channel with its own documented exception.",
    ),
  bannedPhrases: z
    .array(z.string())
    .default([])
    .describe("Client-specific banned phrases, checked case-insensitively on top of the built-in AI-cliche bank."),
});
export type LintPostInput = z.infer<typeof LintPostInputSchema>;

/** Basic hygiene (non-empty, within the platform's length limit, no unresolved markdown link syntax) plus a mechanical anti-AI-tell check. */
export const lintPost = defineTool<LintPostInput, GateVerdict>({
  name: "gate.lintPost",
  description:
    "Basic hygiene (non-empty, within the platform's length limit, no unresolved markdown link syntax) plus a mechanical anti-AI-tell check.",
  version: TOOL_VERSION,
  inputSchema: LintPostInputSchema,
  async execute({ text, platform, checkAntiSlop, maxExclamationMarks, bannedPhrases }) {
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

    if (checkAntiSlop) {
      const sanitized = stripAntiSlopExemptions(text);

      const dashMatch = DASH_PATTERN.exec(sanitized);
      if (dashMatch) {
        return success<GateVerdict>({
          verdict: "content_fail",
          evidence: [`banned dash "${dashMatch[0]}"`],
          reason: "text contains a banned em dash, en dash, or double hyphen: the single most-cited AI writing tell",
          toolVersion: TOOL_VERSION,
        });
      }

      const exclamationCount = (sanitized.match(/!/g) ?? []).length;
      if (exclamationCount > maxExclamationMarks) {
        return success<GateVerdict>({
          verdict: "content_fail",
          evidence: [`${exclamationCount} exclamation mark(s), limit is ${maxExclamationMarks}`],
          reason: `text has ${exclamationCount} exclamation mark(s), exceeding the limit of ${maxExclamationMarks}`,
          toolVersion: TOOL_VERSION,
        });
      }

      const lower = text.toLowerCase();
      const allBannedPhrases = [...DEFAULT_BANNED_PHRASES, ...bannedPhrases];
      const matchedPhrases = allBannedPhrases.filter((phrase) => phrase.length > 0 && lower.includes(phrase.toLowerCase()));
      if (matchedPhrases.length > 0) {
        return success<GateVerdict>({
          verdict: "content_fail",
          evidence: matchedPhrases,
          reason: `text contains a banned AI-cliche phrase: ${matchedPhrases.join(", ")}`,
          toolVersion: TOOL_VERSION,
        });
      }
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [`within the ${platform} length limit (${text.length}/${limit})`],
      toolVersion: TOOL_VERSION,
    });
  },
});
