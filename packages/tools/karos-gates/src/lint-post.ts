import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.4.0"; // 1.4.0: the LinkedIn hashtag cap. linkedin-craft §12 has said "zero to three hashtags" since it was written and nothing counted them; X's identical rule has been enforced since 1.0.0.

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
  // The negative-parallelism tell, named by both Craft 01 §5 and Craft 02 §5
  // and by Lola's LinkedIn findings. Written out in its common spellings
  // rather than as a regex, because the phrase bank is a substring match and
  // a regex here would be the only one in the list.
  "not just a",
  "not just an",
  "not just about",
  "it's not just",
  "it isn't just",
  "is not just",
  // Instagram Phase 5.6 item B5. The owner's specification names several more
  // tells; these are the ones that are safe as SUBSTRINGS across every agent
  // that shares this bank. Three from that list are deliberately absent:
  // "Let's", "Imagine" and "journey" are ordinary English words whose AI-tell
  // quality is entirely about context, and banning them here would fire on
  // correct prose in five other agents. They are taught in the Instagram copy
  // prompt instead, which is the right instrument for a judgement.
  "isn't just",
  "aren't just",
  "in a world where",
  "let that sink in",
  "read that again",
  "the ultimate guide",
];

/**
 * X counts a post's length its own way, and `String.length` is not it.
 *
 * Every URL counts as exactly 23 characters whatever its real length (X
 * wraps them all in t.co), and every emoji counts as 2. Counting plainly
 * meant a 275-character post carrying two links measured as 275 here and as
 * 319 on X — it passed the gate and would have been refused on publish, or
 * silently truncated by whatever posted it.
 *
 * Source: https://docs.x.com/resources/fundamentals/counting-characters.
 *
 * The emoji regex uses `Extended_Pictographic` and folds ZWJ sequences and
 * variation selectors into one unit, because a family emoji is one glyph to
 * a reader and one weighted pair to X, not seven code points.
 */
const URL_PATTERN = /https?:\/\/\S+/g;
const EMOJI_PATTERN = /\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const X_URL_WEIGHT = 23;
const X_EMOJI_WEIGHT = 2;

export function weightedLengthForX(text: string): number {
  let count = 0;
  const withoutUrls = text.replace(URL_PATTERN, () => {
    count += X_URL_WEIGHT;
    return "";
  });
  const withoutEmoji = withoutUrls.replace(EMOJI_PATTERN, () => {
    count += X_EMOJI_WEIGHT;
    return "";
  });
  return count + [...withoutEmoji].length;
}

/** True for the two platform keys that mean X. */
function isX(platform: string): boolean {
  return platform === "x" || platform === "twitter";
}

/**
 * Craft 01 §5: the hook is what a scrolling reader sees, and everything that
 * is not the claim costs them. 70 characters is the ceiling; an @, a #, a
 * link or an emoji in it is a wasted first impression, and the craft page
 * bans all four by name.
 */
const HOOK_MAX_CHARACTERS = 70;

/** Craft 01 §11: at most one hashtag, at most two mentions, neither leading. */
const X_MAX_HASHTAGS = 1;
/** `linkedin-craft` §12: "zero to three hashtags", and zero is a valid answer. */
const LINKEDIN_MAX_HASHTAGS = 3;
// No TikTok cap here, deliberately. `tiktok-commentary` lints with
// `platform: "generic"` and the schema has no `tiktok` member, so a cap keyed
// to that platform would never run — dead code wearing the shape of a rule.
// Giving TikTok a real platform key (with its own length limit) and then a cap
// is a change worth making on its own, not a line smuggled in beside
// LinkedIn's.

/**
 * The hashtag count on one platform, when that platform is the one being
 * linted. Returns `undefined` when it passes, or when a different platform is
 * in play — so a call site reads as a cap rather than as a
 * nested conditional.
 *
 * Same counting expression X has used since 1.0.0, deliberately: `(?<![\w&])#`
 * is what tells a hashtag from a fragment identifier in a URL or an `&#39;`
 * entity, and a second spelling of that would drift.
 */
function lintHashtagCap(
  text: string,
  platform: string,
  forPlatform: string,
  max: number,
): GateVerdict | undefined {
  if (platform !== forPlatform) return undefined;
  const hashtags = text.match(/(?<![\w&])#\w+/g) ?? [];
  if (hashtags.length <= max) return undefined;
  return {
    verdict: "content_fail",
    evidence: hashtags,
    reason: `${hashtags.length} hashtags, and the limit on ${forPlatform} is ${max}: tags that name the post's actual subject earn their place, a block at the bottom does not`,
    toolVersion: TOOL_VERSION,
  };
}
const X_MAX_MENTIONS = 2;

/**
 * Instagram's hook ceiling, and why it is not X's.
 *
 * The owner's Instagram specification states 100 characters: the caption is
 * truncated after roughly that much before the "more" link, so the hook is
 * literally everything a scrolling reader is shown. X's 70 is a tighter
 * editorial choice on a shorter medium and is not transferable.
 *
 * The SHAPE rule differs too, and the difference is deliberate. X bans an
 * emoji, a mention, a hashtag or a link anywhere in the hook. Instagram bans
 * them only in the LEADING position: a caption that opens on an emoji or an
 * @ has spent the reader's attention before the claim arrives, but an emoji
 * inside a sentence is ordinary Instagram writing and banning it would be
 * this codebase imposing X's voice on a different platform.
 */
const IG_HOOK_MAX_CHARACTERS = 100;

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
  /**
   * Continuation posts of a thread (parts 2..N), each its own post on the
   * platform and so each held to the SAME length limit and anti-tell rules as
   * `text`. Prep run pubsub-21720543781218757 (x-agent) held on "thread part 3
   * exceeds the X character limit (283 chars)": the draft step's self-critique
   * had linted `text` alone, so the model never heard about the part that was
   * over, and the deterministic check downstream had nothing left to do but
   * hold. A failing part is named by its position in the thread (part 1 is
   * `text`), so the feedback tells the model exactly which post to shorten.
   */
  parts: z
    .array(z.string())
    .default([])
    .describe(
      "Optional continuation posts (thread parts 2..N). Each is checked against the same platform length limit and anti-AI-tell rules as `text`; a failure names the part (part 1 is `text`).",
    ),
  /**
   * The draft's own hook field, when the platform has a rule about it.
   *
   * Passed separately rather than inferred from `text`'s first line because
   * the hook IS a field on the draft — inferring it would let a model satisfy
   * the rule in the field it reports and break it in the text it ships.
   */
  hook: z
    .string()
    .optional()
    .describe("The draft's hook, checked on X against Craft 01 §5: at most 70 characters, and no @, #, link or emoji."),
});
export type LintPostInput = z.infer<typeof LintPostInputSchema>;

/** Basic hygiene (non-empty, within the platform's length limit, no unresolved markdown link syntax) plus a mechanical anti-AI-tell check. */
export const lintPost = defineTool<LintPostInput, GateVerdict>({
  name: "gate.lintPost",
  description:
    "Basic hygiene (non-empty, within the platform's length limit, no unresolved markdown link syntax) plus a mechanical anti-AI-tell check.",
  version: TOOL_VERSION,
  inputSchema: LintPostInputSchema,
  async execute({ text, platform, checkAntiSlop, maxExclamationMarks, bannedPhrases, parts, hook }) {
    const options = { platform, checkAntiSlop, maxExclamationMarks, bannedPhrases };
    // The hook is checked once, against the draft's own field, before the body
    // — a post whose opening is wrong is wrong whatever the rest says.
    if (hook !== undefined && isX(platform)) {
      const hookVerdict = lintHookForX(hook);
      if (hookVerdict !== undefined) return success<GateVerdict>(hookVerdict);
    }
    const main = lintOne(text, options);
    if (main.verdict !== "pass") return success<GateVerdict>(main);
    // AFTER the body, unlike X's hook rule above, and for a reason worth
    // stating: on Instagram the hook is the caption's own first line, so a
    // caption over the 2,200 limit would be refused for its SHAPE while the
    // thing that makes it unpublishable went unmentioned. Craft is the right
    // complaint only once the post could be posted at all.
    if (hook !== undefined && platform === "instagram") {
      const hookVerdict = lintHookForInstagram(hook);
      if (hookVerdict !== undefined) return success<GateVerdict>(hookVerdict);
    }
    for (const [index, part] of parts.entries()) {
      const verdict = lintOne(part, options);
      if (verdict.verdict === "content_fail") {
        const label = `thread part ${index + 2}`;
        return success<GateVerdict>({
          ...verdict,
          evidence: verdict.evidence.map((e) => `${label}: ${e}`),
          reason: `${label}: ${verdict.reason}`,
        });
      }
      // `lintOne` never returns tooling_error today; if it ever does, the part label is not worth losing the verdict over.
      if (verdict.verdict !== "pass") return success<GateVerdict>(verdict);
    }
    return success<GateVerdict>({
      verdict: "pass",
      evidence: [
      `within the ${platform} length limit (${isX(platform) ? weightedLengthForX(text) : text.length}/${PLATFORM_MAX_LENGTH[platform] ?? PLATFORM_MAX_LENGTH.generic!})`,
      ...(parts.length > 0 ? [`${parts.length} thread part(s) also within the limit`] : []),
    ],
      toolVersion: TOOL_VERSION,
    });
  },
});

interface LintOptions {
  platform: LintPostInput["platform"];
  checkAntiSlop: boolean;
  maxExclamationMarks: number;
  bannedPhrases: string[];
}

/** The lint rules for ONE post's worth of text. `execute` runs it over `text` and then over every thread part. */
function lintOne(text: string, { platform, checkAntiSlop, maxExclamationMarks, bannedPhrases }: LintOptions): GateVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      verdict: "content_fail",
      evidence: [],
      reason: "text is empty",
      toolVersion: TOOL_VERSION,
    };
  }

  const limit = PLATFORM_MAX_LENGTH[platform] ?? PLATFORM_MAX_LENGTH.generic!;
  // On X the length is the WEIGHTED one (23 per URL, 2 per emoji), because
  // that is the number the platform applies. Everywhere else a character is a
  // character.
  const measured = isX(platform) ? weightedLengthForX(text) : text.length;
  if (measured > limit) {
    const how = isX(platform) && measured !== text.length ? ` (weighted: URLs count 23, emoji count 2 — ${text.length} plain)` : "";
    return {
      verdict: "content_fail",
      evidence: [`length ${measured} exceeds the ${platform} limit of ${limit}${how}`],
      reason: `text exceeds the ${platform} length limit (${limit} characters)${how}`,
      toolVersion: TOOL_VERSION,
    };
  }

  if (isX(platform)) {
    const shape = lintShapeForX(text);
    if (shape !== undefined) return shape;
  }

  // LinkedIn's own cap, from its craft guide's §12: "zero to three hashtags…
  // never a generic stapled-on block like #business #growth #success". The
  // rule was written, the reason was given ("six or more measurably cuts
  // reach") — and nothing anywhere counted them. X's identical rule has been
  // enforced since 1.0.0; this is the same check, one platform over.
  const linkedInShape = lintHashtagCap(text, platform, "linkedin", LINKEDIN_MAX_HASHTAGS);
  if (linkedInShape !== undefined) return linkedInShape;

  const unresolvedLinkMatch = /\[[^\]]+\]\(\s*\)/.exec(text);
  if (unresolvedLinkMatch) {
    return {
      verdict: "content_fail",
      evidence: [unresolvedLinkMatch[0]],
      reason: "text contains an unresolved markdown link (empty href)",
      toolVersion: TOOL_VERSION,
    };
  }

  if (checkAntiSlop) {
    const sanitized = stripAntiSlopExemptions(text);

    const dashMatch = DASH_PATTERN.exec(sanitized);
    if (dashMatch) {
      return {
        verdict: "content_fail",
        evidence: [`banned dash "${dashMatch[0]}"`],
        reason: "text contains a banned em dash, en dash, or double hyphen: the single most-cited AI writing tell",
        toolVersion: TOOL_VERSION,
      };
    }

    const exclamationCount = (sanitized.match(/!/g) ?? []).length;
    if (exclamationCount > maxExclamationMarks) {
      return {
        verdict: "content_fail",
        evidence: [`${exclamationCount} exclamation mark(s), limit is ${maxExclamationMarks}`],
        reason: `text has ${exclamationCount} exclamation mark(s), exceeding the limit of ${maxExclamationMarks}`,
        toolVersion: TOOL_VERSION,
      };
    }

    const lower = text.toLowerCase();
    const allBannedPhrases = [...DEFAULT_BANNED_PHRASES, ...bannedPhrases];
    const matchedPhrases = allBannedPhrases.filter((phrase) => phrase.length > 0 && lower.includes(phrase.toLowerCase()));
    if (matchedPhrases.length > 0) {
      return {
        verdict: "content_fail",
        evidence: matchedPhrases,
        reason: `text contains a banned AI-cliche phrase: ${matchedPhrases.join(", ")}`,
        toolVersion: TOOL_VERSION,
      };
    }
  }

  return {
    verdict: "pass",
    evidence: [`within the ${platform} length limit (${measured}/${limit})`],
    toolVersion: TOOL_VERSION,
  };
}

/**
 * Craft 01 §5, on the draft's `hook` field. Returns `undefined` when it passes.
 */
function lintHookForX(hook: string): GateVerdict | undefined {
  const trimmed = hook.trim();
  const length = weightedLengthForX(trimmed);
  if (length > HOOK_MAX_CHARACTERS) {
    return {
      verdict: "content_fail",
      evidence: [`hook is ${length} characters, limit is ${HOOK_MAX_CHARACTERS}`],
      reason: `the hook is ${length} characters and the limit is ${HOOK_MAX_CHARACTERS}: it is the one line a scrolling reader sees, so it carries the claim and nothing else`,
      toolVersion: TOOL_VERSION,
    };
  }
  const offenders: string[] = [];
  if (/@\w/.test(trimmed)) offenders.push("a mention");
  if (/#\w/.test(trimmed)) offenders.push("a hashtag");
  if (URL_PATTERN.test(trimmed)) offenders.push("a link");
  URL_PATTERN.lastIndex = 0;
  if (EMOJI_PATTERN.test(trimmed)) offenders.push("an emoji");
  EMOJI_PATTERN.lastIndex = 0;
  if (offenders.length > 0) {
    return {
      verdict: "content_fail",
      evidence: [`hook contains ${offenders.join(", ")}`],
      reason: `the hook contains ${offenders.join(", ")}: the first line is the claim, and every one of those spends the reader's attention before the claim arrives`,
      toolVersion: TOOL_VERSION,
    };
  }
  return undefined;
}

/**
 * Instagram's hook rule. Returns `undefined` when it passes.
 *
 * Length is counted in code points rather than UTF-16 units, because the
 * limit is about what a reader is shown and an emoji is one character to
 * them. `Array.from` does that; `String.length` would count a single emoji
 * as two and refuse a hook that is within the limit.
 */
function lintHookForInstagram(hook: string): GateVerdict | undefined {
  const trimmed = hook.trim();
  const length = [...trimmed].length;
  if (length > IG_HOOK_MAX_CHARACTERS) {
    return {
      verdict: "content_fail",
      evidence: [`hook is ${length} characters, limit is ${IG_HOOK_MAX_CHARACTERS}`],
      reason: `the hook is ${length} characters and the limit is ${IG_HOOK_MAX_CHARACTERS}: the caption is cut at about that point before the "more" link, so everything past it is written for nobody`,
      toolVersion: TOOL_VERSION,
    };
  }

  const first = [...trimmed][0];
  if (first === undefined) return undefined;
  const leading =
    EMOJI_PATTERN.test(first) ? "an emoji" : first === "@" ? "a handle" : first === "#" ? "a hashtag" : undefined;
  EMOJI_PATTERN.lastIndex = 0;
  if (leading !== undefined) {
    return {
      verdict: "content_fail",
      evidence: [`hook opens on ${leading}`],
      reason: `the hook opens on ${leading}: the first thing a scrolling reader is shown should be the claim, and this spends their attention before it arrives`,
      toolVersion: TOOL_VERSION,
    };
  }
  return undefined;
}

/**
 * Craft 01 §11's two counting rules, on the post body. Returns `undefined`
 * when it passes.
 *
 * A hashtag or a mention is not banned — one of each can earn its place
 * inside a sentence. What is banned is the block of five at the bottom and
 * the tag chain, both of which read as reach-farming rather than as writing.
 */
function lintShapeForX(text: string): GateVerdict | undefined {
  const hashtags = text.match(/(?<![\w&])#\w+/g) ?? [];
  if (hashtags.length > X_MAX_HASHTAGS) {
    return {
      verdict: "content_fail",
      evidence: hashtags,
      reason: `${hashtags.length} hashtags, and the limit on X is ${X_MAX_HASHTAGS}: one that belongs inside a sentence is fine, a block at the bottom is not`,
      toolVersion: TOOL_VERSION,
    };
  }
  // A handle, not an email address: `@` must not be preceded by a word
  // character, which is what tells "@acme" from "hi@acme.com".
  const mentions = text.match(/(?<![\w.])@\w+/g) ?? [];
  if (mentions.length > X_MAX_MENTIONS) {
    return {
      verdict: "content_fail",
      evidence: mentions,
      reason: `${mentions.length} mentions, and the limit on X is ${X_MAX_MENTIONS}: mention only the accounts the post actually discusses`,
      toolVersion: TOOL_VERSION,
    };
  }
  if (/^\s*@\w/.test(text)) {
    return {
      verdict: "content_fail",
      evidence: [text.slice(0, 40)],
      reason: "the post opens with a mention: X treats a leading @ as a reply and shows it to almost nobody, and a reader sees a handle before they see the point",
      toolVersion: TOOL_VERSION,
    };
  }
  if (/\*\*[^*]+\*\*|__[^_]+__/.test(text)) {
    return {
      verdict: "content_fail",
      evidence: [(/\*\*[^*]+\*\*|__[^_]+__/.exec(text) ?? [""])[0]],
      reason: "the post contains markdown bold, which X renders literally as asterisks: plain text only",
      toolVersion: TOOL_VERSION,
    };
  }
  return undefined;
}
