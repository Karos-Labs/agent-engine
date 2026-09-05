import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import type { AgentTool } from "@agent-engine/core";

const TOOL_VERSION = "1.0.0";

const SectionInputSchema = z.object({
  heading: z.string().describe("The section's own mini-headline."),
  body: z.string().describe("The section body, markdown allowed."),
  linkUrl: z.string().optional().describe("The section's link to the full story, if any."),
});

export const EditorialLintInputSchema = z.object({
  subjectLine: z.string().describe("The inbox subject line. Checked for exclamation marks and dashes, which no other gate sees because the subject never appears in `text`."),
  previewText: z.string().optional().describe("The inbox preview text / preheader. Same checks as the subject line."),
  intro: z.string().describe("The edition's opening paragraph(s)."),
  sections: z.array(SectionInputSchema).describe("Every section of the edition, in order."),
  callToAction: z.object({ text: z.string(), url: z.string() }).describe("The one call to action. Its URL is the client's own and is exempt from the research allowlist."),
  signoff: z.string().describe("The closing line."),
  allowedUrls: z
    .array(z.string())
    .default([])
    .describe(
      "Every URL the edition may link to: the run's research documents plus any URL found in the client's own context. A link outside this list is an invented URL and fails the lint.",
    ),
});
export type EditorialLintInput = z.input<typeof EditorialLintInputSchema>;

export interface EditorialLintStats {
  wordCount: number;
  sentenceCount: number;
  sectionCount: number;
  linkCount: number;
  /** Coefficient of variation of sentence length (stddev / mean), or null with fewer than 8 sentences. Low means every sentence is the same length: a template, not a person. */
  sentenceLengthVariation: number | null;
}

export interface EditorialLintResult {
  verdict: "pass" | "content_fail";
  /** Hard failures. Each names the rule and quotes the offending text, so a redraft can act on it directly. */
  evidence: string[];
  /** Soft signals for the editor pass: patterns that usually read as generated but have legitimate uses, so a script must not fail a draft on them alone. */
  warnings: string[];
  stats: EditorialLintStats;
  toolVersion: string;
}

/**
 * Phrases with no legitimate use in an edition: the verdict sentences that
 * sound wise and say nothing, the throat-clearing openers, and the marketing
 * vocabulary that only ever decorates. Matched case-insensitively as
 * substrings of every prose field. Distinct from `gate.lintPost`'s bank,
 * which is the cross-channel minimum; this is the newsletter's own, tuned on
 * what the drafts this agent actually produced kept reaching for (prep job
 * sp8ICAFLjKkYWb2DAh8R: "That is the tell.", "That number matters for one
 * reason", "the window is narrowing", "These are not isolated news items.
 * They are a single signal").
 */
const HARD_TELL_PHRASES: readonly string[] = [
  "that is the tell",
  "that's the tell",
  "the window is narrowing",
  "let that sink in",
  "read into that what you will",
  "the signal is clear",
  "matters for one reason",
  "are not isolated",
  "a single signal",
  "in today's fast-paced",
  "in today's rapidly",
  "as we all know",
  "it's worth noting",
  "it is worth noting",
  "worth noting that",
  "at the end of the day",
  "in conclusion",
  "welcome to this week",
  "welcome to another",
  "this week we're looking at",
  "this week we are looking at",
  "this week, we're looking at",
  "imagine a world",
  "here's the thing",
  "here is the thing",
  "let's dive",
  "dive in",
  "buckle up",
  "stay tuned",
  "make no mistake",
  "game-changer",
  "game changer",
  "cutting-edge",
  "revolutioniz",
  "supercharge",
  "delve",
  "tapestry",
  "ever-evolving",
  "navigate the landscape",
  "navigating the landscape",
  "in the ever-changing",
];

/** Vocabulary that reads as generated when it decorates, but has real uses ("leverage" as a noun, "journey" for an actual trip). Reported to the editor, never failed on. */
const SOFT_TELL_PHRASES: readonly string[] = [
  "leverage",
  "seamless",
  "robust",
  "unlock",
  "elevate",
  "empower",
  "journey",
  "landscape",
  "the bottom line",
  "key takeaway",
  "the takeaway",
  "moving forward",
  "going forward",
  "at scale",
  "double down",
  "it's not just",
  "it is not just",
  "not only",
];

/** Section headings that could head any edition of any newsletter. Compared after lowercasing, trimming, and stripping trailing punctuation. */
const GENERIC_HEADINGS: ReadonlySet<string> = new Set([
  "what this means for you",
  "what this means",
  "what it means for you",
  "what it means",
  "key takeaways",
  "takeaways",
  "takeaway",
  "final thoughts",
  "in conclusion",
  "conclusion",
  "industry update",
  "industry updates",
  "industry news",
  "news roundup",
  "roundup",
  "the bottom line",
  "bottom line",
  "why it matters",
  "why this matters",
  "wrapping up",
  "wrap-up",
  "wrap up",
  "summary",
  "overview",
  "introduction",
  "intro",
  "closing thoughts",
  "in summary",
  "the big picture",
  "looking ahead",
]);

/** Em dash, en dash, or a double hyphen. The same rule `gate.lintPost` applies to `text`, applied here to the two inbox fields `text` never contains. */
const DASH_PATTERN = /[—–]|--/;

/** `[label](url)` markdown links and bare `http(s)://` URLs, for the link allowlist. */
const MARKDOWN_LINK_PATTERN = /\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;
const BARE_URL_PATTERN = /https?:\/\/[^\s)\]>"']+/g;

/**
 * The "not X. It is Y." reframe and its cousins, the single most recognisable
 * generated-prose rhythm. A warning, not a failure: "The fee is not
 * refundable. It is charged once." is a perfectly good pair of sentences.
 */
const REFRAME_PATTERN = /\b(?:is|are|was|were|isn't|aren't|wasn't|weren't)\s+not\s+(?:about\s+|just\s+|only\s+|simply\s+|merely\s+)?[^.!?\n]{2,80}[.!?]\s+(?:It|They|This|That|These|Those)\s+(?:is|are|was|were)\b/;

const MIN_WORDS = 350;
const MAX_WORDS = 1000;
const MIN_SENTENCES_FOR_RHYTHM = 8;
/** Below this coefficient of variation, sentence lengths are near-identical. Human prose typically sits well above 0.4. */
const UNIFORM_RHYTHM_THRESHOLD = 0.25;
/** Section bodies all within this fraction of each other's length read as templated. */
const SYMMETRY_TOLERANCE = 0.15;

function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/[.,;:!?)]+$/, "");
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Tracking parameters differ between the fetched source and what a model
    // copies; they never change which page a reader lands on.
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
    }
    url = parsed.toString();
  } catch {
    // Not a parseable URL; compare the raw string.
  }
  return url.toLowerCase().replace(/\/+$/, "");
}

function normalizeHeading(raw: string): string {
  return raw
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.:!?]+$/, "")
    .trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Prose sentences, with markdown headings and list markers stripped so a bullet's lead-in is not counted as a one-word sentence. */
function sentences(text: string): string[] {
  const prose = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#+|[-*+]|\d+\.)\s+/, "").replace(/\*\*/g, ""))
    .join(" ");
  return prose
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{L}"'(])/u)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 2);
}

function coefficientOfVariation(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** Four or more capitalised words of four-plus letters, with none of them lowercase: Title Case, not a heading with a couple of proper nouns in it. */
function looksTitleCase(heading: string): boolean {
  const candidates = words(heading.replace(/^#+\s*/, "")).filter((w) => /^[\p{L}]{4,}$/u.test(w));
  if (candidates.length < 4) return false;
  const capitalised = candidates.filter((w) => /^\p{Lu}/u.test(w) && !/^\p{Lu}+$/u.test(w));
  const lower = candidates.filter((w) => /^\p{Ll}/u.test(w));
  return lower.length === 0 && capitalised.length >= 3;
}

function quote(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return `"${needle}"`;
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + needle.length + 30);
  return `"${(start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "")}"`;
}

/**
 * `newsletter.editorialLint` (agent-specific, like `render.preview`): the
 * deterministic half of the editorial pass. Everything here is a rule a
 * script can apply without taste, split into hard failures the workflow
 * redrafts on (an invented URL, a verdict sentence, a generic heading, an
 * exclamation mark in the subject line) and warnings the editor agent reads
 * before making the judgment call a script cannot (a reframe that might be
 * fine, a Title Case heading that might be all proper nouns, eight sentences
 * of the same length).
 *
 * Why a tool and not more prompt: newsletter-craft@5 already lists every one
 * of these patterns, and the sonnet drafts that prompted it produced them
 * anyway. A rule the model is asked to follow is a request; a rule a script
 * checks is a guarantee. The prep run that started this (sp8ICAFLjKkYWb2DAh8R)
 * linked four sections to `https://futureweek.com`, a homepage the model had
 * never been given, and no gate noticed because no gate looked at URLs.
 */
export const editorialLint: AgentTool<EditorialLintInput, EditorialLintResult> = defineTool({
  name: "newsletter.editorialLint",
  description:
    "Deterministic editorial checks on a newsletter edition: every link must be a URL the run was given (research or client context), no verdict/throat-clearing phrases, no generic section headings, no exclamation marks or dashes in the subject line or preview text. Returns hard failures as evidence and softer generated-prose signals (reframes, Title Case headings, uniform sentence rhythm, symmetrical sections, length outside 350-1000 words) as warnings.",
  version: TOOL_VERSION,
  inputSchema: EditorialLintInputSchema,
  async execute(rawInput) {
    const input = rawInput as z.output<typeof EditorialLintInputSchema>;
    const evidence: string[] = [];
    const warnings: string[] = [];

    const proseFields: Array<{ field: string; text: string }> = [
      { field: "subjectLine", text: input.subjectLine },
      ...(input.previewText !== undefined ? [{ field: "previewText", text: input.previewText }] : []),
      { field: "intro", text: input.intro },
      ...input.sections.flatMap((s, i) => [
        { field: `sections[${i}].heading`, text: s.heading },
        { field: `sections[${i}].body`, text: s.body },
      ]),
      { field: "callToAction.text", text: input.callToAction.text },
      { field: "signoff", text: input.signoff },
    ];

    // ── Inbox fields: the two strings `text` never contains, so gate.lintPost never sees them ──
    for (const { field, text } of proseFields.filter((f) => f.field === "subjectLine" || f.field === "previewText")) {
      if (text.includes("!")) evidence.push(`${field} contains an exclamation mark: ${quote(text, "!")}`);
      const dash = DASH_PATTERN.exec(text);
      if (dash) evidence.push(`${field} contains a banned dash "${dash[0]}": ${quote(text, dash[0])}`);
    }

    // ── Links: only URLs the run was given ──
    const allowed = new Set(input.allowedUrls.map(normalizeUrl));
    const ctaUrl = normalizeUrl(input.callToAction.url);
    const found: Array<{ field: string; url: string }> = [];
    for (const [i, s] of input.sections.entries()) {
      if (s.linkUrl !== undefined && s.linkUrl.trim().length > 0) found.push({ field: `sections[${i}].linkUrl`, url: s.linkUrl });
    }
    for (const { field, text } of proseFields) {
      if (field === "callToAction.text") continue;
      for (const m of text.matchAll(MARKDOWN_LINK_PATTERN)) found.push({ field, url: m[1]! });
      const withoutMarkdownLinks = text.replace(MARKDOWN_LINK_PATTERN, "]()");
      for (const m of withoutMarkdownLinks.matchAll(BARE_URL_PATTERN)) found.push({ field, url: m[0] });
    }
    for (const { field, url } of found) {
      const normalized = normalizeUrl(url);
      if (normalized === ctaUrl) continue;
      if (!allowed.has(normalized)) {
        evidence.push(`${field} links to ${url}, which is not a URL this run was given. Link only to the research sources or the client's own pages; drop the link if the story has none.`);
      }
    }

    // ── Verdict sentences and throat-clearing ──
    for (const { field, text } of proseFields) {
      const lower = text.toLowerCase();
      for (const phrase of HARD_TELL_PHRASES) {
        if (lower.includes(phrase)) evidence.push(`${field} uses a generated-prose tell ("${phrase}"): ${quote(text, phrase)}. Cut the sentence or replace it with a specific fact.`);
      }
      for (const phrase of SOFT_TELL_PHRASES) {
        if (lower.includes(phrase)) warnings.push(`${field} uses "${phrase}": ${quote(text, phrase)}`);
      }
      if (REFRAME_PATTERN.test(text)) warnings.push(`${field} has a "not X. It is Y." reframe: ${quote(text, REFRAME_PATTERN.exec(text)![0].slice(0, 40))}`);
    }

    // ── Headings ──
    for (const [i, s] of input.sections.entries()) {
      const normalized = normalizeHeading(s.heading);
      if (GENERIC_HEADINGS.has(normalized)) {
        evidence.push(`sections[${i}].heading "${s.heading.trim()}" could head any edition of any newsletter. Make it a specific statement or question about this story.`);
      }
      if (looksTitleCase(s.heading)) warnings.push(`sections[${i}].heading "${s.heading.trim()}" reads as Title Case; house style is sentence case.`);
    }

    // ── Opening ──
    const firstSentence = sentences(input.intro)[0];
    if (firstSentence !== undefined && firstSentence.trim().endsWith("?")) warnings.push(`intro opens on a rhetorical question: "${firstSentence.trim()}"`);

    // ── Shape ──
    const bodyText = [input.intro, ...input.sections.flatMap((s) => [s.heading, s.body]), input.callToAction.text, input.signoff].join("\n\n");
    const allSentences = sentences(bodyText);
    const wordCount = words(bodyText).length;
    const sentenceLengths = allSentences.map((s) => words(s).length);
    const sentenceLengthVariation = sentenceLengths.length >= MIN_SENTENCES_FOR_RHYTHM ? coefficientOfVariation(sentenceLengths) : null;
    if (sentenceLengthVariation !== null && sentenceLengthVariation < UNIFORM_RHYTHM_THRESHOLD) {
      warnings.push(`sentence rhythm is uniform (length variation ${sentenceLengthVariation.toFixed(2)} across ${sentenceLengths.length} sentences); vary sentence length.`);
    }
    if (wordCount < MIN_WORDS) warnings.push(`edition body is ${wordCount} words; the craft guide's floor is ${MIN_WORDS}.`);
    if (wordCount > MAX_WORDS) warnings.push(`edition body is ${wordCount} words; the craft guide's ceiling is ${MAX_WORDS}.`);
    const sectionWordCounts = input.sections.map((s) => words(s.body).length).filter((n) => n > 0);
    if (sectionWordCounts.length >= 3) {
      const mean = sectionWordCounts.reduce((a, b) => a + b, 0) / sectionWordCounts.length;
      if (sectionWordCounts.every((n) => Math.abs(n - mean) <= mean * SYMMETRY_TOLERANCE)) {
        warnings.push(`all ${sectionWordCounts.length} section bodies are within ${Math.round(SYMMETRY_TOLERANCE * 100)}% of the same length (${sectionWordCounts.join(", ")} words); a real edition has a longer lead and shorter briefs.`);
      }
    }

    return success<EditorialLintResult>({
      verdict: evidence.length === 0 ? "pass" : "content_fail",
      evidence,
      warnings,
      stats: {
        wordCount,
        sentenceCount: allSentences.length,
        sectionCount: input.sections.length,
        linkCount: found.length,
        sentenceLengthVariation,
      },
      toolVersion: TOOL_VERSION,
    });
  },
});
