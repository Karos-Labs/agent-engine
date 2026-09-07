import { createHash } from "node:crypto";

/**
 * Dependency-free extraction of the on-page facts the SEO/GEO scoring
 * config's `on_page`, `structure`, `extractability_capsule`,
 * `evidence_density`, `freshness`, `multimodal` and `hygiene` buckets ask
 * for — from one page's raw HTML.
 *
 * Every number here is a direct observation of the markup (a title's
 * character count, the words between two headings, whether a `<script
 * type="application/ld+json">` parses). Nothing is estimated from a pattern,
 * so a measurement built on these is `coverage: "measured"` under
 * `grade_data_only_rule` ("a real site fetch" counts). What this file
 * deliberately does NOT do is anything that needs a browser (rendered DOM,
 * layout at 360px), a classifier (NER, sentiment) or a search index (top-10
 * shingle comparison) — those inputs stay honestly unavailable.
 *
 * Regex over HTML is a known trade. It is used here because the signals are
 * coarse (counts, lengths, presence) and the alternative — a DOM parser
 * dependency in a tool package that has none — buys precision on edge cases
 * these counts do not need. Tags are stripped, entities decoded, and script/
 * style/nav chrome removed before any text is counted.
 */

export type ScriptFamily = "latin" | "hebrew" | "arabic" | "cyrillic" | "cjk" | "other";

export interface HeadingSignal {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  isQuestion: boolean;
  /** Words between this heading and the next heading of any level. */
  sectionWordCount: number;
  /** Words in the first paragraph directly under this heading (0 when none). */
  firstParagraphWordCount: number;
  /** Where in the main text this heading sits, 0 (top) to 1 (bottom). */
  bodyOffsetRatio: number;
  /** Words until the next heading of any level, capped for question/answer checks. */
  externalLinkCount: number;
  numericStatCount: number;
}

export interface JsonLdSignals {
  blocks: number;
  parseErrors: number;
  types: string[];
  organization?: { sameAsCount: number; hasId: boolean; url?: string };
  dateModified?: string;
  datePublished?: string;
  authorName?: string;
}

export interface PageSignals {
  url: string;
  finalUrl: string;
  status: number;
  https: boolean;
  lang?: string;
  script: ScriptFamily;
  title?: string;
  titleLength: number;
  metaDescription?: string;
  metaDescriptionLength: number;
  metaRobots: { noindex: boolean; nosnippet: boolean; maxSnippetZero: boolean };
  canonical?: string;
  /** `undefined` when the page declares no canonical at all. */
  canonicalValid?: boolean;
  viewportMeta: boolean;
  hreflangCount: number;
  headings: HeadingSignal[];
  h1Count: number;
  /** Heading level jumps of more than one (an H2 followed directly by an H4). */
  headingSkips: number;
  wordCount: number;
  /** Word counts per heading-delimited section (the intro before the first heading included when non-empty). */
  sectionWordCounts: number[];
  /** The paragraph directly under the H1 (or the first paragraph when there is no H1). */
  openingCapsule: { wordCount: number; bodyOffsetRatio: number } | undefined;
  internalLinkCount: number;
  externalLinkCount: number;
  externalDomains: string[];
  images: { total: number; withAlt: number };
  hasVideo: boolean;
  jsonLd: JsonLdSignals;
  /** ISO date from `article:modified_time`, JSON-LD `dateModified`, or `<time datetime>` — whichever exists first. */
  dateModified?: string;
  datePublished?: string;
  authorByline: boolean;
  numericStatCount: number;
  attributedQuoteCount: number;
  firstPersonMarkerCount: number;
  definitionalSentence: boolean;
  keyword: { topTokenShare: number; maxExactPhraseRepeats: number };
  /** Flesch Reading Ease for Latin-script text; `null` where the formula does not apply. */
  fleschReadingEase: number | null;
  /** `http://` resources referenced from an `https://` page. */
  mixedContentCount: number;
  /** SHA-256 of the normalised main text — what a later run compares against to tell whether the body changed. */
  contentHash: string;
  /** The first ~800 characters of main text, for readers that want to quote what the page actually says. */
  excerpt: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags gone, entities decoded, whitespace collapsed. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|section|article|blockquote|tr|td|th)>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function countWords(text: string): number {
  return (text.match(WORD_RE) ?? []).length;
}

function removeBlocks(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  if (!match) return undefined;
  return decodeEntities((match[2] ?? match[3] ?? match[4] ?? "").trim());
}

function metaContent(head: string, matcher: RegExp): string | undefined {
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attr(tag, "name") ?? attr(tag, "property") ?? attr(tag, "http-equiv");
    if (name && matcher.test(name)) {
      const content = attr(tag, "content");
      if (content !== undefined) return content;
    }
  }
  return undefined;
}

export function detectScript(text: string): ScriptFamily {
  const sample = text.slice(0, 4000);
  const counts = {
    latin: (sample.match(/\p{Script=Latin}/gu) ?? []).length,
    hebrew: (sample.match(/\p{Script=Hebrew}/gu) ?? []).length,
    arabic: (sample.match(/\p{Script=Arabic}/gu) ?? []).length,
    cyrillic: (sample.match(/\p{Script=Cyrillic}/gu) ?? []).length,
    cjk: (sample.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length,
  };
  const [best, count] = (Object.entries(counts) as Array<[ScriptFamily, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return count > 0 ? best : "other";
}

// `\b` is ASCII-only in JavaScript, so the Hebrew and accented openers below use explicit letter/digit lookarounds instead.
const QUESTION_STARTS =
  /^(what|how|why|when|which|who|where|is|are|can|does|do|should|will|מה|איך|למה|מדוע|כיצד|האם|מי|מתי|איפה|כמה|qué|cómo|por qué|cuándo|cuál|quién|dónde|o que|como|por que|quando|qual|quem|onde|pourquoi|comment|quand|quel|qui|où)(?![\p{L}\p{N}])/iu;

export function isQuestionHeading(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_STARTS.test(trimmed);
}

const NUMERIC_STAT_RE = /(?:[$€£₪]\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent|בפני|k\b|m\b|bn\b|million|billion|מיליון|מיליארד|thousand|אלף)|\b\d{2,}(?:[.,]\d+)?\b)/gi;

export function countNumericStats(text: string): number {
  return (text.match(NUMERIC_STAT_RE) ?? []).length;
}

const ATTRIBUTION_RE = /(?<![\p{L}\p{N}])(said|says|according to|stated|explains|told|wrote|אמר|אמרה|לדברי|מסר|לפי|dijo|según|afirmó|disse|segundo|a déclaré|selon)(?![\p{L}\p{N}])/iu;

/** A quotation of at least 20 characters with an attribution verb within 80 characters on either side. */
export function countAttributedQuotes(text: string): number {
  let count = 0;
  for (const match of text.matchAll(/["“„«]([^"”»]{20,400})["”»]/g)) {
    const start = Math.max(0, match.index! - 80);
    const end = Math.min(text.length, match.index! + match[0].length + 80);
    if (ATTRIBUTION_RE.test(text.slice(start, end))) count += 1;
  }
  return count;
}

const FIRST_PERSON_RE = /(?<![\p{L}\p{N}])(we|our|ours|us|i|my|me|אנחנו|אנו|שלנו|אני|שלי|nosotros|nuestro|nuestra|nós|nosso|nossa|nous|notre|nos)(?![\p{L}\p{N}])/giu;

export function countFirstPersonMarkers(text: string): number {
  return (text.match(FIRST_PERSON_RE) ?? []).length;
}

const DEFINITIONAL_RE = /^[^.!?]{1,120}?(?<![\p{L}\p{N}])(is|are|הוא|היא|הינו|הינה|הם|הן|es|son|é|são|est|sont)(?![\p{L}\p{N}])/iu;

/** A sentence of at most 25 words shaped like "X is …" within the opening of the text. */
export function hasDefinitionalSentence(text: string): boolean {
  const opening = text.slice(0, 1500);
  const sentences = opening.split(/(?<=[.!?])\s+/);
  return sentences.slice(0, 6).some((sentence) => {
    const words = countWords(sentence);
    return words >= 4 && words <= 25 && DEFINITIONAL_RE.test(sentence.trim());
  });
}

const STOPWORDS = new Set(
  (
    "the a an and or of to in on for with is are was were be been by at from as that this these those it its into your you we our they their not no but if then than so can will just more most about over under after before also all any each other some such only own same too very s t " +
    "של את על עם זה זו הוא היא הם הן אני אנחנו אתה אתם לא כן גם כל יש אין או כי אם אבל מה איך למה " +
    "el la los las de del y o en un una que es son por para con se su sus al como más pero " +
    "o a os as de do da dos das e em um uma que é são por para com se seu sua ao como mais mas " +
    "le la les de des du et ou en un une que est sont pour avec se son sa ses au comme plus mais"
  ).split(/\s+/),
);

export function keywordDensity(text: string): { topTokenShare: number; maxExactPhraseRepeats: number } {
  const tokens = (text.toLowerCase().match(WORD_RE) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return { topTokenShare: 0, maxExactPhraseRepeats: 0 };
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const topTokenShare = Math.max(...counts.values()) / tokens.length;
  const phrases = new Map<string, number>();
  for (let i = 0; i + 3 <= tokens.length; i++) {
    const phrase = tokens.slice(i, i + 3).join(" ");
    phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
  }
  const maxExactPhraseRepeats = phrases.size > 0 ? Math.max(...phrases.values()) : 0;
  return { topTokenShare, maxExactPhraseRepeats };
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, (stripped.match(/[aeiouy]{1,2}/g) ?? []).length);
}

/** Flesch Reading Ease over Latin-script text; `null` for other scripts, where the syllable model is meaningless. */
export function fleschReadingEase(text: string, script: ScriptFamily): number | null {
  if (script !== "latin") return null;
  const words = text.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*/g) ?? [];
  if (words.length < 30) return null;
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
  return Math.round(score * 10) / 10;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function sameSite(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

interface JsonLdWalk {
  types: string[];
  organization?: { sameAsCount: number; hasId: boolean; url?: string };
  dateModified?: string;
  datePublished?: string;
  authorName?: string;
}

function walkJsonLd(node: unknown, acc: JsonLdWalk, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, acc, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const rawType = obj["@type"];
  const types = Array.isArray(rawType) ? rawType.filter((t): t is string => typeof t === "string") : typeof rawType === "string" ? [rawType] : [];
  for (const t of types) if (!acc.types.includes(t)) acc.types.push(t);
  if (types.some((t) => /^(Organization|NewsMediaOrganization|Corporation|LocalBusiness|Brand)$/i.test(t)) && !acc.organization) {
    const sameAs = obj["sameAs"];
    acc.organization = {
      sameAsCount: Array.isArray(sameAs) ? sameAs.filter((s) => typeof s === "string").length : typeof sameAs === "string" ? 1 : 0,
      hasId: typeof obj["@id"] === "string" && (obj["@id"] as string).length > 0,
      ...(typeof obj["url"] === "string" ? { url: obj["url"] as string } : {}),
    };
  }
  if (typeof obj["dateModified"] === "string" && !acc.dateModified) acc.dateModified = obj["dateModified"] as string;
  if (typeof obj["datePublished"] === "string" && !acc.datePublished) acc.datePublished = obj["datePublished"] as string;
  const author = obj["author"];
  if (author && !acc.authorName) {
    const first = Array.isArray(author) ? author[0] : author;
    if (typeof first === "string") acc.authorName = first;
    else if (first && typeof first === "object" && typeof (first as Record<string, unknown>)["name"] === "string") {
      acc.authorName = (first as Record<string, unknown>)["name"] as string;
    }
  }
  for (const key of ["@graph", "mainEntity", "publisher", "itemListElement", "hasPart"]) {
    if (key in obj) walkJsonLd(obj[key], acc, depth + 1);
  }
}

export function extractJsonLd(html: string): JsonLdSignals {
  const acc: JsonLdWalk = { types: [] };
  let blocks = 0;
  let parseErrors = 0;
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks += 1;
    const body = match[1]!.trim();
    if (!body) {
      parseErrors += 1;
      continue;
    }
    try {
      walkJsonLd(JSON.parse(body), acc);
    } catch {
      parseErrors += 1;
    }
  }
  return {
    blocks,
    parseErrors,
    types: acc.types,
    ...(acc.organization ? { organization: acc.organization } : {}),
    ...(acc.dateModified ? { dateModified: acc.dateModified } : {}),
    ...(acc.datePublished ? { datePublished: acc.datePublished } : {}),
    ...(acc.authorName ? { authorName: acc.authorName } : {}),
  };
}

/** The part of the document a reader treats as the page: `<main>`/`<article>` when present, else `<body>` minus nav/header/footer/aside chrome. */
function mainHtml(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  let body = main ?? html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  if (!main) {
    for (const tag of ["nav", "header", "footer", "aside"]) body = removeBlocks(body, tag);
  }
  for (const tag of ["script", "style", "noscript", "svg", "template", "iframe", "form"]) body = removeBlocks(body, tag);
  return body.replace(/<!--[\s\S]*?-->/g, " ");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export const median = (values: number[]): number => percentile(values, 0.5);
export const p75 = (values: number[]): number => percentile(values, 0.75);

/**
 * Every signal for one page. Pure: same HTML in, same signals out. The
 * `pageUrl` is what was requested and `finalUrl` what answered — a canonical
 * that points at the final URL is valid even when the request redirected.
 */
export function extractPageSignals(input: { url: string; finalUrl: string; status: number; html: string }): PageSignals {
  const { url, finalUrl, status, html } = input;
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html.slice(0, 20000);
  const pageHost = hostOf(finalUrl) ?? hostOf(url);
  const https = /^https:/i.test(finalUrl);

  const lang = html.match(/<html\b[^>]*\blang\s*=\s*["']?([A-Za-z-]+)/i)?.[1];
  const title = stripTags(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metaDescription = metaContent(head, /^description$/i)?.trim();
  const robotsMeta = (metaContent(head, /^(robots|googlebot)$/i) ?? "").toLowerCase();
  const metaRobots = {
    noindex: /\bnoindex\b/.test(robotsMeta),
    nosnippet: /\bnosnippet\b/.test(robotsMeta),
    maxSnippetZero: /max-snippet\s*:\s*0\b/.test(robotsMeta),
  };
  let canonical: string | undefined;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if (/\brel\s*=\s*["']?canonical\b/i.test(tag)) {
      canonical = attr(tag, "href");
      break;
    }
  }
  const canonicalValid = canonical === undefined ? undefined : /^https?:\/\//i.test(canonical) && sameSite(hostOf(canonical), pageHost);
  const viewportMeta = metaContent(head, /^viewport$/i) !== undefined;
  const hreflangCount = (head.match(/<link\b[^>]*\bhreflang\s*=/gi) ?? []).length;

  const jsonLd = extractJsonLd(html);
  const main = mainHtml(html);
  const text = stripTags(main);
  const wordCount = countWords(text);
  const script = detectScript(text || title);

  // Headings, with the text and paragraph structure between them.
  const headingMatches = [...main.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
  const headings: HeadingSignal[] = [];
  const sectionWordCounts: number[] = [];
  const introWords = headingMatches.length > 0 ? countWords(stripTags(main.slice(0, headingMatches[0]!.index!))) : wordCount;
  if (introWords > 0 && headingMatches.length > 0) sectionWordCounts.push(introWords);
  let openingCapsule: PageSignals["openingCapsule"];
  let headingSkips = 0;
  let previousLevel: number | undefined;
  let wordsBefore = introWords;
  headingMatches.forEach((match, i) => {
    const level = Number(match[1]) as HeadingSignal["level"];
    const textOfHeading = stripTags(match[2]!).slice(0, 160);
    const sectionStart = match.index! + match[0].length;
    const sectionEnd = i + 1 < headingMatches.length ? headingMatches[i + 1]!.index! : main.length;
    const sectionHtml = main.slice(sectionStart, sectionEnd);
    const sectionText = stripTags(sectionHtml);
    const sectionWordCount = countWords(sectionText);
    const firstParagraph = sectionHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const firstParagraphWordCount = firstParagraph !== undefined ? countWords(stripTags(firstParagraph)) : sectionWordCount > 0 ? Math.min(sectionWordCount, countWords(sectionText.split(/(?<=[.!?])\s+/).slice(0, 3).join(" "))) : 0;
    const bodyOffsetRatio = wordCount > 0 ? Math.min(1, wordsBefore / wordCount) : 0;
    const externalLinkCount = [...sectionHtml.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].filter((m) => {
      const host = hostOf(m[1]!);
      return host !== undefined && !sameSite(host, pageHost);
    }).length;
    if (previousLevel !== undefined && level > previousLevel + 1) headingSkips += 1;
    previousLevel = level;
    headings.push({
      level,
      text: textOfHeading,
      isQuestion: isQuestionHeading(textOfHeading),
      sectionWordCount,
      firstParagraphWordCount,
      bodyOffsetRatio,
      externalLinkCount,
      numericStatCount: countNumericStats(sectionText),
    });
    if (sectionWordCount > 0) sectionWordCounts.push(sectionWordCount);
    if (level === 1 && openingCapsule === undefined && firstParagraphWordCount > 0) {
      openingCapsule = { wordCount: firstParagraphWordCount, bodyOffsetRatio };
    }
    wordsBefore += sectionWordCount;
  });
  if (openingCapsule === undefined) {
    const firstParagraph = main.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
    if (firstParagraph !== undefined) {
      const words = countWords(stripTags(firstParagraph));
      if (words > 0) openingCapsule = { wordCount: words, bodyOffsetRatio: 0 };
    }
  }
  const h1Count = headings.filter((h) => h.level === 1).length;

  // Links, media, mixed content.
  let internalLinkCount = 0;
  const externalDomains = new Set<string>();
  for (const match of main.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = match[1]!.trim();
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, finalUrl).href;
    } catch {
      continue;
    }
    const host = hostOf(absolute);
    if (host && sameSite(host, pageHost)) internalLinkCount += 1;
    else if (host) externalDomains.add(host);
  }
  const externalLinkCount = [...main.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].filter((m) => {
    const host = hostOf(m[1]!);
    return host !== undefined && !sameSite(host, pageHost);
  }).length;
  const imgTags = main.match(/<img\b[^>]*>/gi) ?? [];
  const images = { total: imgTags.length, withAlt: imgTags.filter((tag) => (attr(tag, "alt") ?? "").trim().length > 0).length };
  const hasVideo = /<video\b|<iframe\b[^>]*(youtube|vimeo|wistia)/i.test(html);
  const mixedContentCount = https ? (html.match(/\b(?:src|href)\s*=\s*["']http:\/\//gi) ?? []).length : 0;

  // Dates and bylines.
  const timeTag = main.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1];
  const dateModified = metaContent(head, /^(article:modified_time|og:updated_time|last-modified|dcterms\.modified)$/i) ?? jsonLd.dateModified;
  const datePublished = metaContent(head, /^(article:published_time|dcterms\.created|date|pubdate)$/i) ?? jsonLd.datePublished ?? timeTag;
  const authorByline = Boolean(jsonLd.authorName ?? metaContent(head, /^(author|article:author|parsely-author)$/i)) || /\b(rel\s*=\s*["']author["']|class\s*=\s*["'][^"']*\b(byline|author)\b)/i.test(main);

  const excerpt = text.slice(0, 800);
  const contentHash = createHash("sha256").update(text.toLowerCase().replace(/\d+/g, "#")).digest("hex");

  return {
    url,
    finalUrl,
    status,
    https,
    ...(lang ? { lang } : {}),
    script,
    ...(title ? { title } : {}),
    titleLength: title.length,
    ...(metaDescription ? { metaDescription } : {}),
    metaDescriptionLength: metaDescription?.length ?? 0,
    metaRobots,
    ...(canonical ? { canonical } : {}),
    ...(canonicalValid !== undefined ? { canonicalValid } : {}),
    viewportMeta,
    hreflangCount,
    headings: headings.slice(0, 80),
    h1Count,
    headingSkips,
    wordCount,
    sectionWordCounts,
    openingCapsule,
    internalLinkCount,
    externalLinkCount,
    externalDomains: [...externalDomains].sort().slice(0, 50),
    images,
    hasVideo,
    jsonLd,
    ...(dateModified ? { dateModified } : {}),
    ...(datePublished ? { datePublished } : {}),
    authorByline,
    numericStatCount: countNumericStats(text),
    attributedQuoteCount: countAttributedQuotes(text),
    firstPersonMarkerCount: countFirstPersonMarkers(text),
    definitionalSentence: hasDefinitionalSentence(text),
    keyword: keywordDensity(text),
    fleschReadingEase: fleschReadingEase(text, script),
    mixedContentCount,
    contentHash,
    excerpt,
  };
}

/** Days between an ISO-ish date string and `now`; `undefined` when it does not parse. */
export function daysSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.round((now - at) / 86_400_000));
}
