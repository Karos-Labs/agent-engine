import {
  BRIEF_TTL_DAYS,
  ClientBriefSchema,
  briefAgeDays,
  type ClientBrand,
  type ClientBrief,
  type ClientKnowledge,
  type ClientProfile,
  type VoiceRules,
} from "@agent-engine/tools";
import type { InstagramTopicClaim } from "./types.js";

/**
 * Instagram Phase 0 grounding gate — the deterministic Client Brief and the
 * two things it grounds before any model runs: the research query and the
 * copy prompt's "who this client is" section.
 *
 * ## The defect this closes
 *
 * Prep audit, 2026-09-08: `04a-research-pull` searched the web for the run's
 * request verbatim — "Create content that introduces the new offer to
 * first-time buyers" — with nothing about the client attached. For Karos
 * Labs (an AI marketing agency) the top results were about first-time HOME
 * buyers, and the run shipped a real-estate carousel about MassHousing and
 * Gen H that a reviewer approved. The words were fine; the business was
 * missing. Nothing in the pipeline had ever been told what the client sells
 * or to whom, so nothing could notice.
 *
 * ## Why deterministic, and why it is a stand-in
 *
 * Everything here is pure code over data the workspace already holds
 * (profile, brand, voice rules, the three C1 context documents, the
 * knowledge mirror). It costs no model call, it cannot hallucinate a
 * positioning, and it exists so the gate has SOMETHING to ground against on
 * a client's first run. It is also deliberately marked `generatedBy:
 * "deterministic"` and `confidence: "low"`: `isBriefStale` treats it as
 * always-stale, so the moment Phase 1's agent-written brief is persisted for
 * a client (`client.getBrief` returns it), the workflow prefers that one.
 * Both are the same `ClientBrief` type from `@agent-engine/tool-karos-client`,
 * which is what makes the persisted brief a drop-in.
 *
 * `deriveClientBrief` never throws and never blocks a run: an empty profile
 * yields a valid brief whose `gaps` say exactly what was missing, and a
 * downstream reviewer sees `briefConfidence: "low"` in the gate payload.
 */

// ─────────────────────────────────────────────────────────────────────────
// Text helpers — small, pure, Unicode-aware (Hebrew is a first-class target).
// ─────────────────────────────────────────────────────────────────────────

/** Collapse all whitespace runs to one space and trim. */
function normalise(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Cut `text` to at most `max` characters at a word boundary. No ellipsis:
 * the result is used inside search queries and schema-bounded fields, where
 * a trailing "…" is either noise for the search index or a wasted character.
 */
function clampWords(text: string, max: number): string {
  const t = normalise(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Keep at least half the budget rather than collapsing to one long word.
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:(\-]+$/u, "");
}

/** The first sentence of a prose blurb; `undefined` when there is no prose. */
function firstSentence(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = normalise(text);
  if (t.length === 0) return undefined;
  // Sentence enders across the scripts we publish in: Latin/Hebrew ".", "!",
  // "?", Armenian "։", CJK "。".
  const [first] = t.split(/(?<=[.!?։。])\s+/u);
  return first && first.length > 0 ? first : t;
}

/**
 * The first real paragraph of a markdown document: headings, horizontal
 * rules and blank blocks are skipped, list bullets stripped, lines joined.
 */
function firstParagraph(markdown: string | undefined): string | undefined {
  if (typeof markdown !== "string") return undefined;
  for (const block of markdown.split(/\r?\n\s*\r?\n/u)) {
    const lines = block
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^#{1,6}\s/u.test(l) && !/^(?:-{3,}|\*{3,}|_{3,})$/u.test(l))
      .map((l) => l.replace(/^(?:[-*+•]|\d+[.)])\s+/u, "").replace(/^>\s*/u, ""));
    const joined = normalise(lines.join(" "));
    if (joined.length > 0) return joined;
  }
  return undefined;
}

/**
 * Function words that carry no subject. English because most onboarding
 * prose is English; a short Hebrew list because Hebrew is a first-class
 * target and its most common function words are four letters or longer
 * (the `>= 4` letter rule alone would let them through).
 */
const STOPWORDS = new Set<string>([
  // English
  "about", "above", "after", "again", "against", "also", "among", "another", "around", "because", "been", "before", "being", "below",
  "between", "both", "business", "businesses", "company", "companies", "could", "does", "doing", "down", "during", "each", "either", "else",
  "ever", "every", "everything", "from", "further", "have", "having", "help", "helps", "here", "into", "itself", "just", "like", "make",
  "makes", "many", "more", "most", "much", "must", "need", "needs", "never", "once", "only", "other", "others", "over", "same", "should",
  "since", "some", "something", "such", "than", "that", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "under", "until", "very", "want", "wants", "were", "what", "when", "where", "which", "while", "will", "with",
  "within", "without", "would", "your", "yours", "yourself", "well", "world", "years", "year", "using", "used", "uses", "based", "best",
  "better", "great", "leading", "team", "teams", "people", "customers", "customer", "clients", "client", "provide", "provides", "offer",
  "offers", "offering", "solutions", "solution", "services", "service", "products", "product", "platform", "across", "focused", "focus",
  // Hebrew function words (four letters or longer)
  "אשר", "כאשר", "אנחנו", "אנו", "שלנו", "שלהם", "שלכם", "אותם", "אותנו", "אותה", "אותו", "יותר", "בתוך", "כמו", "אבל", "עבור", "בעזרת",
  "באמצעות", "כדי", "לכל", "מכל", "בכל", "היום", "הרבה", "מאוד", "גם", "וגם", "ולכן", "לכן", "אלה", "אלו", "היא", "הוא", "הם", "הן",
  "אנשים", "חברה", "חברות", "לקוחות", "לקוח", "שירות", "שירותים", "מוצר", "מוצרים", "פתרון", "פתרונות", "צוות", "צוותים",
]);

/** Letter-only tokens of four letters or more, lowercased, minus stopwords. */
function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\p{L}+/gu)) {
    const w = m[0].toLowerCase();
    if (w.length >= 4 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

/** Top-`limit` tokens by term frequency, ties broken by first appearance. */
function topTerms(corpus: readonly string[], limit: number): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  let i = 0;
  for (const text of corpus) {
    for (const w of contentTokens(text)) {
      const row = counts.get(w);
      if (row) row.n += 1;
      else counts.set(w, { n: 1, first: i });
      i += 1;
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, limit)
    .map(([w]) => w);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => (typeof v === "string" && v.trim().length > 0 ? [normalise(v)] : []));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? normalise(value) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// deriveClientBrief
// ─────────────────────────────────────────────────────────────────────────

export interface DeriveClientBriefInput {
  profile?: ClientProfile | undefined;
  voiceRules?: VoiceRules | undefined;
  brand?: ClientBrand | undefined;
  /** The three C1 context documents that describe the business, as markdown (each read best-effort via `readContextDoc`). */
  contextDocs: {
    productInformation?: string | undefined;
    targetAudience?: string | undefined;
    marketStrategy?: string | undefined;
  };
  knowledge?: ClientKnowledge | undefined;
  /** The frozen style config's forbidden topics (`frozen.forbiddenTopics`). */
  forbiddenTopics: readonly string[];
  /** Step 02d's resolved target language, when there is one. */
  targetLanguage?: string | undefined;
  /** Injectable clock, for deterministic `generatedAt` in tests. */
  now?: Date;
}

/** A line of a product-information document that announces something sellable. */
const OFFER_LINE = /offer|launch|new|pricing|plan|מבצע|השקה/iu;

const MAX_OFFERS = 5;
const MAX_CORE_TERMS = 12;
const MAX_EVERGREEN = 8;
const MAX_OWN_ASSETS = 12;

function offersFrom(productInformation: string | undefined): ClientBrief["offers"] {
  if (!productInformation) return [];
  const offers: ClientBrief["offers"] = [];
  for (const raw of productInformation.split(/\r?\n/u)) {
    const line = normalise(raw.replace(/^[\s#>*+•-]+/u, "").replace(/^\d+[.)]\s+/u, ""));
    if (line.length < 8 || !OFFER_LINE.test(line)) continue;
    // The name is the clause before the first colon or full stop, so
    // "Starter plan: $49/mo for one channel" names "Starter plan".
    const clause = line.split(/[:.]\s|:$/u)[0] ?? line;
    offers.push({ name: clampWords(clause, 80), summary: clampWords(line, 300) });
    if (offers.length >= MAX_OFFERS) break;
  }
  return offers;
}

function assetKind(mimeType: string | undefined): ClientBrief["ownAssets"][number]["kind"] {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("sheet") || m.includes("csv") || m.includes("excel")) return "data";
  return "doc";
}

function ownAssetsFrom(knowledge: ClientKnowledge | undefined): ClientBrief["ownAssets"] {
  if (!knowledge) return [];
  const out: ClientBrief["ownAssets"] = [];
  for (const asset of Array.isArray(knowledge.assets) ? knowledge.assets : []) {
    const title = optionalString(asset?.name);
    if (!title) continue;
    out.push({
      title: clampWords(title, 120),
      kind: assetKind(asset.mimeType),
      summary: clampWords(optionalString(asset.note) ?? optionalString(asset.purpose) ?? `${asset.mimeType ?? "file"} uploaded as a reference asset`, 240),
      sourceRef: optionalString(asset.url) ?? "client.getKnowledge/assets",
    });
    if (out.length >= MAX_OWN_ASSETS) return out;
  }
  for (const t of Array.isArray(knowledge.transcripts) ? knowledge.transcripts : []) {
    const title = optionalString(t?.title);
    if (!title) continue;
    out.push({
      title: clampWords(title, 120),
      kind: "doc",
      summary: clampWords(optionalString(t.summary) ?? "meeting summary (no text synced)", 240),
      sourceRef: "client.getKnowledge/transcripts",
    });
    if (out.length >= MAX_OWN_ASSETS) return out;
  }
  return out;
}

/**
 * The generic ICP summaries `deriveClientBrief` falls back to when there is
 * no target-audience document. Constants because `isThinlyGrounded` below
 * recognises the brief by them: two spellings of the same sentence in two
 * modules is how a floor silently stops applying.
 */
const GENERIC_ICP_PREFIX = "practitioners in ";
const GENERIC_ICP_NO_INDUSTRY = "this client's customers (no target-audience document or industry on file)";

/**
 * Does this brief have nothing but the industry to stand on?
 *
 * True when the derivation took BOTH of its widest fallbacks: no
 * product-information document (so `positioning.whatWeSell` is the industry
 * name) and no target-audience document (so `icp.summary` is "practitioners
 * in <industry>"). A brief like that describes a whole field rather than a
 * business, and the relevance judge's own rubric then scores a 2 — "a
 * different business in the same field could have posted this word for word"
 * — for every post a writer given that grounding could possibly produce.
 * Three redrafts and a hold on it punish the client for thin onboarding, and
 * the redraft has nothing new to work with, so `relevanceFloor` lowers the
 * passing score to 2 for this shape and says so in the gate payload. A 1
 * (the MassHousing failure: a different industry, a different customer) is
 * still off-brief and still returns to step 05.
 *
 * Read off `sources` and `icp.summary` rather than `confidence`, which is
 * "low" for every deterministically derived brief and therefore says nothing
 * about how much grounding there was.
 */
export function isThinlyGrounded(brief: ClientBrief): boolean {
  const docRefs = new Set(brief.sources.filter((s) => s.kind === "context-doc").map((s) => s.ref));
  if (docRefs.has("product-information") || docRefs.has("target-audience")) return false;
  return brief.icp.summary.startsWith(GENERIC_ICP_PREFIX) || brief.icp.summary === GENERIC_ICP_NO_INDUSTRY;
}

/**
 * Build a Client Brief from onboarding data alone. Pure, synchronous, never
 * throws, always returns a document that passes `ClientBriefSchema`.
 *
 * Rules (each one names where a field comes from and what it falls back to;
 * every fallback taken is recorded in `gaps`):
 * - `positioning.oneLiner`: first sentence of `profile.description`, else
 *   `brand.tagline`, else "<name>, <industry>".
 * - `positioning.whatWeSell`: first paragraph of product-information, else
 *   the industry (short on purpose: it is spliced into a search query).
 * - `icp.summary`: first paragraph of target-audience, else "practitioners
 *   in <industry>".
 * - `coreTerms`: the industry first, then the top-frequency letter tokens
 *   (>= 4 letters, minus stopwords) across profile + docs + voice rules.
 * - `offers`: product-information lines that mention an offer, launch,
 *   pricing or plan (English or Hebrew).
 * - `forbidden.topics` = the frozen config's forbidden topics;
 *   `forbidden.claims` = `voiceRules.dontList`; `evergreenAngles` =
 *   `voiceRules.doList`; `ownAssets` = knowledge assets and transcripts.
 * - `confidence` is always "low": nothing here was judged, only copied.
 */
export function deriveClientBrief(input: DeriveClientBriefInput): ClientBrief {
  const now = input.now ?? new Date();
  const profile = input.profile ?? {};
  const voiceRules = input.voiceRules ?? {};
  const brand = input.brand ?? {};
  const docs = input.contextDocs;

  const sources: ClientBrief["sources"] = [];
  const gaps: string[] = [];

  const description = optionalString(profile.description);
  const industry = optionalString(profile.industry);
  const name = optionalString(profile.name) ?? optionalString(profile["companyName"]);

  if (input.profile) sources.push({ kind: "profile", ref: "client.getProfile" });
  else gaps.push("no client profile on file: positioning and core terms are derived from nothing but the documents present");
  if (input.brand) sources.push({ kind: "brand", ref: "client.getBrand" });
  if (input.voiceRules) sources.push({ kind: "voice-rules", ref: "client.getVoiceRules" });
  else gaps.push("no voice rules on file: forbidden claims and evergreen angles are empty");
  if (docs.productInformation) sources.push({ kind: "context-doc", ref: "product-information" });
  else gaps.push("no product-information document: whatWeSell falls back to the industry and offers are empty");
  if (docs.targetAudience) sources.push({ kind: "context-doc", ref: "target-audience" });
  else gaps.push("no target-audience document: the ICP is a generic 'practitioners in <industry>'");
  if (docs.marketStrategy) sources.push({ kind: "context-doc", ref: "market-strategy" });
  else gaps.push("no market-strategy document: differentiators are empty");
  if (input.knowledge) sources.push({ kind: "knowledge", ref: "client.getKnowledge" });
  else gaps.push("no knowledge base synced: ownAssets is empty");

  // ── positioning ──
  const tagline = optionalString(brand.tagline);
  let oneLiner = firstSentence(description) ?? tagline;
  if (oneLiner === undefined) {
    if (name && industry) oneLiner = `${name}, ${industry}`;
    else oneLiner = name ?? industry;
    if (oneLiner === undefined) {
      oneLiner = "an unnamed business: no profile description, tagline, name or industry on file";
      gaps.push("no profile description, brand tagline, name or industry: the one-liner is a placeholder statement of that fact");
    } else {
      gaps.push("no profile description or brand tagline: the one-liner is the client's name and industry only");
    }
  }
  const whatWeSell = firstParagraph(docs.productInformation) ?? industry ?? oneLiner;

  // ── ICP ──
  const icpSummary = firstParagraph(docs.targetAudience) ?? (industry ? `${GENERIC_ICP_PREFIX}${industry}` : GENERIC_ICP_NO_INDUSTRY);

  // ── core terms ──
  const corpus: string[] = [
    description ?? "",
    docs.productInformation ?? "",
    docs.targetAudience ?? "",
    docs.marketStrategy ?? "",
    optionalString(voiceRules.tone) ?? "",
    ...stringList(voiceRules["guidelines"]),
    ...stringList(voiceRules.doList),
  ];
  const coreTerms: string[] = [];
  if (industry) coreTerms.push(industry.toLowerCase());
  for (const term of topTerms(corpus, MAX_CORE_TERMS)) {
    if (coreTerms.length >= MAX_CORE_TERMS) break;
    if (!coreTerms.includes(term)) coreTerms.push(term);
  }
  if (coreTerms.length === 0) {
    // The schema requires one term; the only honest one left is the client's
    // own name, and failing that the literal fact that nothing is known.
    coreTerms.push(name ? name.toLowerCase() : "unknown business");
    gaps.push("no industry, description or documents: core terms could not be derived, so grounded search queries are weak for this run");
  }

  // ── the rest ──
  const offers = offersFrom(docs.productInformation);
  const forbiddenClaims = stringList(voiceRules.dontList);
  const evergreenAngles = stringList(voiceRules.doList).slice(0, MAX_EVERGREEN);
  const ownAssets = ownAssetsFrom(input.knowledge);
  const register = optionalString(voiceRules.tone);

  const candidate: ClientBrief = {
    version: 1,
    channel: "instagram",
    generatedAt: now.toISOString(),
    generatedBy: "deterministic",
    sources,
    positioning: { oneLiner: clampWords(oneLiner, 240), whatWeSell: clampWords(whatWeSell, 400), differentiators: [] },
    icp: { summary: clampWords(icpSummary, 240), roles: [], pains: [], industries: [], geos: [] },
    offers,
    coreTerms,
    referenceAccounts: [],
    forbidden: { topics: [...input.forbiddenTopics], claims: forbiddenClaims },
    language: {
      ...(input.targetLanguage ? { target: input.targetLanguage } : {}),
      ...(register ? { register } : {}),
    },
    evergreenAngles,
    ownAssets,
    confidence: "low",
    gaps,
  };

  const parsed = ClientBriefSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // Unreachable by construction (every field above is clamped to the schema),
  // but "never throws" is a promise, not a hope: fall back to the smallest
  // valid brief and say why in `gaps`. Schema INPUT shape (defaults fill the
  // rest), hence no `satisfies ClientBrief` on the literal.
  return ClientBriefSchema.parse({
    version: 1,
    channel: "instagram",
    generatedAt: now.toISOString(),
    generatedBy: "deterministic",
    sources,
    positioning: { oneLiner: clampWords(oneLiner, 240), whatWeSell: clampWords(whatWeSell, 400) },
    icp: { summary: clampWords(icpSummary, 240) },
    coreTerms: coreTerms.slice(0, 1),
    forbidden: { topics: [...input.forbiddenTopics] },
    language: {},
    confidence: "low",
    gaps: [...gaps, `derived brief failed its own schema and was reduced to the minimum: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Staleness — the one place "deterministic" vs "agent"/"human" matters.
// ─────────────────────────────────────────────────────────────────────────

/**
 * True when the workflow should not rely on this brief as-is: a
 * deterministic brief is always stale (it exists only until an agent-written
 * one is persisted), and any brief older than `BRIEF_TTL_DAYS` is stale.
 * An unparseable `generatedAt` is stale (the age is `NaN`, and `NaN <= 30`
 * is false).
 */
export function isBriefStale(brief: Pick<ClientBrief, "generatedBy" | "generatedAt">, now: Date = new Date()): boolean {
  if (brief.generatedBy === "deterministic") return true;
  return !(briefAgeDays(brief, now) <= BRIEF_TTL_DAYS);
}

// ─────────────────────────────────────────────────────────────────────────
// briefForPrompt — the ~600-800 token rendering the copy agent and the
// relevance judge both read. One renderer so the two never disagree about
// who the client is.
// ─────────────────────────────────────────────────────────────────────────

function joinList(items: readonly string[], max: number): string {
  return items.slice(0, max).join("; ");
}

/**
 * A compact, prompt-ready rendering of the brief: positioning, ICP, offers,
 * core terms, forbidden, language, confidence. Deliberately omits
 * `sources`, `referenceAccounts` and `ownAssets` — those steer the scout and
 * research, not the writer — and keeps each list short so the whole block
 * stays well under 1000 words whatever the schema caps allow.
 */
export function briefForPrompt(brief: ClientBrief): string {
  const lines: string[] = [];
  const generated = brief.generatedAt.slice(0, 10);
  lines.push(`Client brief (confidence ${brief.confidence}; written by ${brief.generatedBy}, ${generated}).`);
  lines.push(`Positioning: ${brief.positioning.oneLiner}`);
  lines.push(`What we sell: ${brief.positioning.whatWeSell}`);
  if (brief.positioning.differentiators.length > 0) lines.push(`Differentiators: ${joinList(brief.positioning.differentiators, 6)}`);
  lines.push(`Audience (ICP): ${brief.icp.summary}`);
  if (brief.icp.roles.length > 0) lines.push(`Audience roles: ${joinList(brief.icp.roles, 6)}`);
  if (brief.icp.pains.length > 0) lines.push(`Audience pains: ${joinList(brief.icp.pains, 6)}`);
  if (brief.icp.industries.length > 0) lines.push(`Audience industries: ${joinList(brief.icp.industries, 6)}`);
  if (brief.icp.geos.length > 0) lines.push(`Audience geos: ${joinList(brief.icp.geos, 4)}`);
  if (brief.offers.length > 0) {
    lines.push("Current offers:");
    for (const offer of brief.offers.slice(0, 5)) {
      const extras = [offer.url ? `url: ${offer.url}` : undefined, offer.validUntil ? `valid until ${offer.validUntil}` : undefined].filter(Boolean).join(", ");
      lines.push(`- ${offer.name}: ${clampWords(offer.summary, 240)}${extras ? ` (${extras})` : ""}`);
    }
  }
  lines.push(`Core terms (use them where the audience would): ${brief.coreTerms.slice(0, 20).join(", ")}`);
  if (brief.forbidden.claims.length > 0) lines.push(`Never claim: ${joinList(brief.forbidden.claims, 10)}`);
  if (brief.forbidden.topics.length > 0) lines.push(`Off-limits topics: ${joinList(brief.forbidden.topics, 10)}`);
  if (brief.evergreenAngles.length > 0) lines.push(`Evergreen angles: ${joinList(brief.evergreenAngles, 8)}`);
  const language = [brief.language.target ? `target ${brief.language.target}` : undefined, brief.language.register ? `register: ${brief.language.register}` : undefined]
    .filter(Boolean)
    .join("; ");
  if (language) lines.push(`Language: ${language}`);
  if (brief.gaps.length > 0) lines.push(`Known gaps in this brief: ${joinList(brief.gaps, 6)}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// The grounded research query.
// ─────────────────────────────────────────────────────────────────────────

/** Hard ceiling on the query string: keyword indexes degrade on long natural-language input. */
export const MAX_GROUNDED_QUERY_CHARS = 200;

/**
 * A request that is a DIRECTION ("Create content that introduces…", "Write a
 * post about…") rather than a SUBJECT ("our new onboarding flow"). Mirrors
 * the conservative posture of `run-direction.ts`'s `looksLikeTopic`
 * (private to `@agent-engine/workflow`, so not reused): only an opening
 * imperative counts, in English or Hebrew. The verb must be a whole word:
 * `(?=\s|$)` rather than `\b`, because `\b` is ASCII-only in JavaScript and
 * never fires after a Hebrew letter.
 */
const DIRECTION_OPENER =
  /^\s*(?:please\s+)?(?:create|write|make|introduce|post|draft|produce|publish|prepare|design|build|craft|do|כתבו|כתוב|כתבי|צרו|צור|הכינו|הכן|פרסמו|פרסם)(?=\s|$)/iu;

/**
 * The noun phrase a direction is ABOUT: everything after a marker word.
 * Two passes, strongest markers first, so "Post on LinkedIn about our
 * pricing" yields "our pricing" rather than "LinkedIn about our pricing":
 * "about / introducing / introduces / covering / explaining / announcing /
 * regarding" (English) and "על" (Hebrew, "about"), then the weaker "on".
 * `\b` is ASCII-only in JavaScript, so the Hebrew marker is anchored on
 * whitespace instead.
 */
const SUBJECT_MARKERS: readonly RegExp[] = [
  /(?:\b(?:about|introducing|introduces|introduce|covering|explaining|announcing|regarding)\b|(?:^|\s)על)\s+(.+)$/iu,
  /\bon\s+(.+)$/iu,
];

/** True when the request opens with an imperative verb — a brief for us, not a subject line. */
export function looksLikeDirection(request: string): boolean {
  return DIRECTION_OPENER.test(request);
}

/**
 * The subject to research. For a direction, the noun phrase after the
 * marker word when there is one ("…introduces the new offer to first-time
 * buyers" → "the new offer to first-time buyers"), else the whole request
 * (a direction with no marker is still the best subject we have). For a
 * topic line, the line itself.
 */
export function extractSubject(request: string): string {
  const trimmed = normalise(request).replace(/[.!?]+$/u, "");
  if (!looksLikeDirection(trimmed)) return trimmed;
  for (const marker of SUBJECT_MARKERS) {
    const phrase = marker.exec(trimmed)?.[1]?.trim().replace(/[.!?]+$/u, "");
    if (phrase && phrase.length > 0) return phrase;
  }
  return trimmed;
}

/** The first clause of a prose field, sized for a search query (clause before the first full stop or semicolon, then word-clamped). */
function queryFragment(text: string, max: number): string {
  const clause = normalise(text).split(/(?<=[.;])\s+/u)[0] ?? text;
  return clampWords(clause, max);
}

export interface GroundedQuery {
  /** What `research.pull` is asked. */
  query: string;
  /** The subject the query is about, before grounding (what the fallback query reuses). */
  subject: string;
  /** The verbatim request/topic the query was built from. */
  rewrittenFrom: string;
  /** False when the query IS the input (a scouted headline is already brand-fit judged). */
  rewritten: boolean;
}

/**
 * `<subject> in the context of <what the client sells> for <the ICP>`,
 * trimmed to `MAX_GROUNDED_QUERY_CHARS`, except for a scouted trend, whose
 * headline passes through as-is (the scout already judged its brand fit,
 * and the headline's own words are what the sources use).
 *
 * The trimming order when the parts overrun the ceiling: shorten the ICP,
 * then what-we-sell, then the subject — the subject is the one part the
 * client actually asked for.
 */
export function buildGroundedQuery(topicClaim: Pick<InstagramTopicClaim, "topic" | "source" | "trend">, brief: ClientBrief): GroundedQuery {
  const rewrittenFrom = normalise(topicClaim.topic);
  if (topicClaim.source === "trend" && topicClaim.trend?.headline) {
    return { query: topicClaim.trend.headline, subject: rewrittenFrom, rewrittenFrom, rewritten: false };
  }

  const subject = extractSubject(rewrittenFrom);
  const budgets: Array<[subject: number, sell: number, icp: number]> = [
    [120, 90, 70],
    [100, 70, 50],
    [90, 50, 40],
    [80, 40, 30],
  ];
  let query = "";
  for (const [s, w, i] of budgets) {
    query = `${clampWords(subject, s)} in the context of ${queryFragment(brief.positioning.whatWeSell, w)} for ${queryFragment(brief.icp.summary, i)}`;
    if (query.length <= MAX_GROUNDED_QUERY_CHARS) break;
  }
  if (query.length > MAX_GROUNDED_QUERY_CHARS) query = clampWords(query, MAX_GROUNDED_QUERY_CHARS);
  return { query, subject, rewrittenFrom, rewritten: true };
}

/**
 * The second, plainer pull when the grounded query returned nothing: the
 * subject plus the brief's first two core terms (skipping any the subject
 * already contains). Keyword indexes sometimes return zero results for a
 * long natural-language query and plenty for four words.
 */
export function fallbackQuery(subject: string, brief: ClientBrief): string {
  const lower = subject.toLowerCase();
  const terms = brief.coreTerms.filter((t) => !lower.includes(t.toLowerCase())).slice(0, 2);
  return clampWords([normalise(subject), ...terms].join(" "), MAX_GROUNDED_QUERY_CHARS);
}
