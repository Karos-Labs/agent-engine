import { z } from "zod";
import { candidateEngine } from "@agent-engine/workflow";
import {
  BRIEF_TTL_DAYS,
  ClientBriefSchema,
  briefAgeDays,
  type BriefSource,
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

/**
 * Cut `text` to at most `max` characters WITHOUT collapsing its whitespace —
 * for the documents that reach a prompt, where headings, lists and paragraph
 * breaks are structure the model reads. Cuts at a whitespace boundary and says
 * it truncated, so a model never treats a document that stops mid-sentence as
 * the whole of what the client says.
 */
function clampRaw(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastBreak = cut.search(/\s+\S*$/u);
  return `${(lastBreak > max / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n\n[truncated at ${max} characters]`;
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
 * no target-audience document. Constants so the two call sites below cannot
 * drift; nothing reads them as a signal any more — `isThinlyGrounded` used to
 * fingerprint them and stopped recognising a thin brief the moment an agent
 * wrote one, so it reads `sources` instead.
 */
export const GENERIC_ICP_PREFIX = "practitioners in ";
export const GENERIC_ICP_NO_INDUSTRY = "this client's customers (no target-audience document or industry on file)";

/**
 * The one-liner written when the client profile carries no description, no
 * tagline, no name and no industry.
 *
 * Exported for the same reason the two ICP constants above are: it is a
 * SENTENCE ABOUT MISSING DATA, not a fact about a business, and a consumer
 * that treats it as prose will say something absurd. `fallbackVisualDirection`
 * is the one that bit — it piped this string into an image model's brief
 * ("Photograph the work itself: an unnamed business: no profile description,
 * tagline, name or industry on file") and into the run-wide style lock. Any
 * consumer that turns brief prose into instructions must skip a value that
 * matches one of these and record a gap instead.
 */
export const PLACEHOLDER_ONE_LINER = "an unnamed business: no profile description, tagline, name or industry on file";

/**
 * The single core term written when nothing at all could be derived — see the
 * `coreTerms.length === 0` branch of `deriveClientBrief` below.
 *
 * It is deliberately NOT folded into `isPlaceholderBriefValue`: that predicate
 * is documented as covering the two PROSE one-liners, several callers treat a
 * `true` from it as "this field is a sentence about missing data", and a core
 * term is neither prose nor a field those callers read. It is exported
 * instead so a consumer that needs to recognise it — `concept-direction.ts`'s
 * subject palette is the first — imports the literal rather than retyping it.
 * The schema requires at least one core term, so this string is the only
 * thing standing between an ungrounded client and a search query about
 * nothing.
 */
export const PLACEHOLDER_CORE_TERM = "unknown business";

/**
 * True when a brief field is one of the placeholders above rather than
 * something a human wrote about this client.
 *
 * `GENERIC_ICP_PREFIX` is deliberately NOT treated as one: "practitioners in
 * fintech" names a real declared industry and is a legitimate, if generic,
 * subject for a photograph. The two hard placeholders are the ones whose text
 * is a statement that data is missing.
 */
export function isPlaceholderBriefValue(value: string | undefined): boolean {
  const tidy = value?.trim();
  if (tidy === undefined || tidy.length === 0) return true;
  return tidy === PLACEHOLDER_ONE_LINER || tidy === GENERIC_ICP_NO_INDUSTRY;
}

/**
 * The context documents that carry what a post has to be legible AS: what
 * this business sells (`product-information`) and who it sells to
 * (`target-audience`). A brief resting on either one describes a business; a
 * brief resting on neither describes a field.
 */
const GROUNDING_DOC_REFS: ReadonlySet<string> = new Set(["product-information", "target-audience"]);

/** True for the source rows `isThinlyGrounded` reads — the ones that decide the relevance floor, and therefore the ones the engine stamps itself. */
function isGroundingSource(source: BriefSource): boolean {
  return (source.kind === "context-doc" && GROUNDING_DOC_REFS.has(source.ref)) || source.kind === "site";
}

/**
 * Does this brief have nothing but the industry to stand on?
 *
 * True when its own audit trail names none of the three sources that can say
 * what this business sells and to whom: a `product-information` context doc,
 * a `target-audience` context doc, or the client's own site (`kind: "site"`,
 * which the Phase 1 brief agent fetches at `00b1` and which is usually the
 * sharpest positioning statement available). A brief like that describes a
 * whole field rather than a business, and the relevance judge's own rubric
 * then scores a 2 — "a different business in the same field could have posted
 * this word for word" — for every post a writer given that grounding could
 * possibly produce. Three redrafts and a hold on it punish the client for
 * thin onboarding, and the redraft has nothing new to work with, so
 * `relevanceFloor` lowers the passing score to 2 for this shape and says so
 * in the gate payload. A 1 (the MassHousing failure: a different industry, a
 * different customer) is still off-brief and still returns to step 05.
 *
 * Read off `sources` alone, and `sources` is a field the ENGINE can vouch
 * for: `stampAgentBrief` reconciles the brief agent's own list against
 * `buildBriefAgentInput`'s `presentSources` before anything is persisted
 * (`reconcileBriefSources`), so every grounding-bearing row the gather step
 * actually read is present whether or not the model listed it, and a row for
 * a source the run never supplied is dropped. Without that reconciliation
 * this floor would be the model's to lower: under-report your sources and
 * the passing score drops from 3 to 2. It is not, and the brief prompt is no
 * longer told the mechanism exists.
 *
 * Read off `sources` alone, deliberately. It used to ALSO fingerprint
 * `deriveClientBrief`'s own fallback literals (`icp.summary` starting with
 * "practitioners in "), which made the floor unreachable the moment Phase 1
 * replaced the deterministic brief with an agent-written one: model prose
 * matches no literal, `resolveBriefFreshness` refreshes every deterministic
 * brief on a client's first Phase 1 run, and so every client's floor went
 * back to 3 — re-opening the unwinnable three-attempt hold this constant
 * exists to prevent, and contradicting what the brief prompt promises the
 * model ("a later step lowers its own quality bar for exactly this case, and
 * it can only do that if you say so", `prompts/instagram-brief/1.md` §4).
 * `sources` is the one field every writer of a brief fills the same way —
 * deterministic, agent and human alike — and it is exactly the audit trail
 * the prompt asks for.
 *
 * Not read off `confidence`, which is "low" for every deterministically
 * derived brief and therefore says nothing about how much grounding there
 * was.
 */
export function isThinlyGrounded(brief: ClientBrief): boolean {
  return !brief.sources.some(isGroundingSource);
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
      oneLiner = PLACEHOLDER_ONE_LINER;
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
    coreTerms.push(name ? name.toLowerCase() : PLACEHOLDER_CORE_TERM);
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
// Phase 1 — the persisted brief's lifecycle: when the setup-style agent
// runs, what it reads, and what shape its answer is stored in.
// ─────────────────────────────────────────────────────────────────────────

/** The `skillRef` the brief agent runs under, stamped onto every brief it writes so a stored document names the prompt version that produced it. */
export const BRIEF_AGENT_SKILL_REF = "instagram-brief@1";

/**
 * What `InstagramBriefAgent` returns: the whole `ClientBrief` minus the five
 * fields the ENGINE knows and the model does not.
 *
 * `version`/`channel` are facts about the pipeline, `generatedBy`/
 * `agentSkillRef` are facts about who wrote it, and `generatedAt` is the field
 * every staleness decision is made on — a model that could set it could date
 * its own brief permanently fresh. The agent fills everything that is
 * genuinely a judgment about the client, `sources`/`confidence`/`gaps`
 * included: which sources it actually used and what it could not ground is
 * exactly the part a reviewer needs from the writer rather than from the
 * caller.
 *
 * Lives here rather than in `types.ts` because it is derived from the
 * schema in `@agent-engine/tools` that both writers share — the agent
 * imports it from this module the way the other agents import theirs from
 * `types.js`.
 */
export const InstagramBriefAgentOutputSchema = ClientBriefSchema.omit({
  version: true,
  channel: true,
  generatedAt: true,
  generatedBy: true,
  agentSkillRef: true,
});
export type InstagramBriefAgentOutput = z.infer<typeof InstagramBriefAgentOutputSchema>;

/** The payload `client.writeBrief` takes: a whole brief minus `generatedAt`, which that tool stamps. */
export type BriefWritePayload = Omit<ClientBrief, "generatedAt">;

/**
 * A source row's identity, for comparing a claim against what was supplied.
 * Whitespace-collapsed, lowercased, trailing slashes off — onboarding data
 * and model prose disagree about all three and about nothing else that
 * matters here.
 */
function sourceRefKey(source: BriefSource): string {
  return `${source.kind}:${normalise(source.ref).toLowerCase().replace(/\/+$/u, "")}`;
}

/**
 * The kinds whose `ref` is the tool that produced them, so there is exactly
 * one row per kind and the `ref` carries no information the model could get
 * wrong. Matched by KIND alone (and canonicalised to the engine's own ref):
 * a model that writes `{ kind: "profile", ref: "profile" }` named the source
 * it was actually given, and dropping that row would corrupt the audit trail
 * over a spelling.
 */
const SINGLETON_SOURCE_KINDS: ReadonlySet<BriefSource["kind"]> = new Set(["profile", "brand", "voice-rules", "knowledge", "intel"]);

export interface BriefSourceReconciliation {
  /** What gets persisted: the model's claim, intersected with the truth, with every grounding-bearing row the run read unioned back in. */
  sources: BriefSource[];
  /** One readable line per correction, for the step record and the reviewer. Empty when the model's list was exactly right. */
  notes: string[];
}

/**
 * Reconcile the brief agent's self-reported `sources` against the rows the
 * gather step actually produced (`buildBriefAgentInput`'s `presentSources`).
 *
 * ## Why this exists
 *
 * `sources` is not decoration: `isThinlyGrounded` reads it, and through
 * `relevanceFloor` it sets the passing score of the one gate that closes the
 * audit's "any agency could have posted this" defect (3/5 normally, 2/5 for
 * a brief with no product-information document, no target-audience document
 * and no page of the client's own site). Persisted verbatim, that made the
 * floor a lever the writer could pull: a brief that read the site and the
 * product-information document but listed only `profile` and `voice-rules`
 * — a plausible, unpunished omission — silently dropped the floor to "a
 * different business in the same field could have posted this word for word".
 *
 * So the engine stamps what it can see and keeps only what it supplied:
 *
 * 1. **Every grounding-bearing row the run read is unioned in** — the
 *    `product-information`/`target-audience` documents and each site page
 *    `research.fetchPages` returned. These are exactly the rows the floor
 *    turns on, and the engine knows them for certain, so the floor is now
 *    decided by what was read and never by what was claimed. Erring toward
 *    "grounded" is the safe direction: it raises the bar, never lowers it.
 * 2. **A claimed row with no counterpart in `presentSources` is dropped.**
 *    The run cannot vouch for it, and a `site` or document row nobody
 *    supplied would raise the floor on grounding that does not exist.
 * 3. **Everything else the model claimed and the run supplied is kept**, in
 *    the model's own order, canonicalised to the engine's `ref`. That is
 *    still the useful half of the audit trail: which of the supplied
 *    sources the writer says it actually drew on.
 *
 * Pure, and `notes` names every correction so the difference between what
 * the model claimed and what the run read is visible rather than silent.
 */
export function reconcileBriefSources(claimed: readonly BriefSource[], present: readonly BriefSource[]): BriefSourceReconciliation {
  const notes: string[] = [];
  const presentByKey = new Map(present.map((s) => [sourceRefKey(s), s]));
  const presentByKind = new Map<BriefSource["kind"], BriefSource>();
  for (const source of present) if (!presentByKind.has(source.kind)) presentByKind.set(source.kind, source);

  const sources: BriefSource[] = [];
  const taken = new Set<string>();
  const push = (source: BriefSource): void => {
    const key = sourceRefKey(source);
    if (taken.has(key)) return;
    taken.add(key);
    sources.push(source);
  };

  const dropped: string[] = [];
  for (const claim of claimed) {
    const exact = presentByKey.get(sourceRefKey(claim));
    if (exact !== undefined) {
      push(exact);
      continue;
    }
    if (SINGLETON_SOURCE_KINDS.has(claim.kind)) {
      const byKind = presentByKind.get(claim.kind);
      if (byKind !== undefined) {
        push(byKind);
        continue;
      }
    } else {
      // A ref-bearing kind whose ref the model wrote its own way: a handle
      // without its platform, a page URL without its scheme. One containment
      // test each way, on the normalised refs, before giving up on the row.
      const claimRef = normalise(claim.ref).toLowerCase().replace(/\/+$/u, "");
      const fuzzy =
        claimRef.length > 0
          ? present.find((p) => {
              if (p.kind !== claim.kind) return false;
              const ref = normalise(p.ref).toLowerCase().replace(/\/+$/u, "");
              return ref.includes(claimRef) || claimRef.includes(ref);
            })
          : undefined;
      if (fuzzy !== undefined) {
        push(fuzzy);
        continue;
      }
    }
    dropped.push(`${claim.kind}:${normalise(claim.ref)}`);
  }

  const added: string[] = [];
  for (const source of present) {
    if (!isGroundingSource(source)) continue;
    const key = sourceRefKey(source);
    if (taken.has(key)) continue;
    push(source);
    added.push(`${source.kind}:${source.ref}`);
  }

  if (dropped.length > 0) {
    notes.push(`dropped ${dropped.length} source(s) the brief listed but this run never supplied: ${dropped.join(", ")}`);
  }
  if (added.length > 0) {
    notes.push(`added ${added.length} grounding source(s) this run read but the brief did not list: ${added.join(", ")}`);
  }
  return { sources, notes };
}

/**
 * The agent's answer, stamped into a storable brief: `version: 1`, the
 * channel, `generatedBy: "agent"`, the prompt version that wrote it, the
 * resolved target language when the run had one, and the RECONCILED source
 * list.
 *
 * The language override is deliberate rather than trusting the model's own
 * `language.target`: step `02d` resolves the target language from
 * `brand.language`, the profile and the voice rules with a documented
 * precedence, and a brief that disagreed with it would send the copy step and
 * the language gate to two different languages. The model still fills
 * `language.register`, which nothing else derives.
 *
 * `presentSources` is the same reasoning applied to the audit trail: pass
 * what `00b1` actually read and `reconcileBriefSources` decides the stored
 * `sources`, because that field sets the relevance floor and a model must not
 * be able to lower its own gate (see that function). It returns
 * `{ brief, sourceNotes }` rather than a bare payload so a caller cannot
 * persist a brief and quietly discard the corrections that were made to it;
 * omitting `presentSources` keeps the model's list verbatim and yields no
 * notes, which is right for a caller with no gather step to compare against
 * (a unit test, a human import) and wrong for `00b3`.
 */
export interface StampedAgentBrief {
  brief: BriefWritePayload;
  /** `reconcileBriefSources`'s notes: what was dropped, what the engine added. Empty when the model's list matched what the run read. */
  sourceNotes: string[];
}

export function stampAgentBrief(
  output: InstagramBriefAgentOutput,
  options: {
    channel?: ClientBrief["channel"];
    agentSkillRef?: string;
    targetLanguage?: string | undefined;
    presentSources?: readonly BriefSource[] | undefined;
  },
): StampedAgentBrief {
  const target = options.targetLanguage ?? output.language.target;
  const reconciled =
    options.presentSources === undefined ? { sources: [...output.sources], notes: [] } : reconcileBriefSources(output.sources, options.presentSources);
  return {
    brief: {
      ...output,
      sources: reconciled.sources,
      version: 1,
      channel: options.channel ?? "instagram",
      generatedBy: "agent",
      agentSkillRef: options.agentSkillRef ?? BRIEF_AGENT_SKILL_REF,
      language: {
        ...output.language,
        ...(target !== undefined ? { target } : {}),
      },
    },
    sourceNotes: reconciled.notes,
  };
}

export type BriefFreshnessAction = "reuse" | "refresh" | "create";

export interface BriefFreshness {
  action: BriefFreshnessAction;
  /** Present whenever a brief exists — `NaN` for an unparseable `generatedAt`, which is itself a refresh reason. */
  ageDays?: number;
  /** Why, in a sentence a run record can carry. */
  reason: string;
}

/**
 * Should the brief agent run this run?
 *
 * Four answers, in this precedence:
 *
 * 1. **No brief at all → `create`.** Every client's first Instagram run pays
 *    for one Sonnet call and writes the document the next month of runs reads.
 * 2. **Human-authored → `reuse`, always.** Somebody corrected what the agent
 *    inferred, and this cycle runs unattended. It outranks even an explicit
 *    `refreshBrief` on the run input, because `client.writeBrief` refuses to
 *    overwrite a human brief anyway — resolving to `refresh` here would spend
 *    a Sonnet call to be declined at the store. A human brief changes in the
 *    portal.
 * 3. **Asked for → `refresh`.** `wf.input.refreshBrief` is the operator's
 *    "the client repositioned, read them again" button; it needs no other
 *    justification.
 * 4. **Deterministic, older than `BRIEF_TTL_DAYS`, or undatable →
 *    `refresh`.** A deterministic brief is Phase 0's stand-in (copied, never
 *    judged, `confidence: "low"`), so the first Phase 1 run for a client
 *    replaces it. Everything else is reused: at a weekly cadence the write
 *    amortises to about a cent a run, and re-reading a client's site every
 *    week to re-derive the same positioning is spend with no reader.
 */
export function resolveBriefFreshness(brief: ClientBrief | undefined, now: Date = new Date(), refreshRequested = false): BriefFreshness {
  if (brief === undefined) {
    return { action: "create", reason: "no persisted instagram brief for this client yet — writing the first one" };
  }
  const ageDays = briefAgeDays(brief, now);
  if (brief.generatedBy === "human") {
    return {
      action: "reuse",
      ageDays,
      reason: `the stored brief was authored by a human${Number.isNaN(ageDays) ? "" : ` ${ageDays} day(s) ago`} and is never refreshed automatically — edit it in the portal`,
    };
  }
  if (refreshRequested) {
    return { action: "refresh", ageDays, reason: "this run asked for a fresh brief (refreshBrief)" };
  }
  if (brief.generatedBy === "deterministic") {
    return { action: "refresh", ageDays, reason: "the stored brief was derived deterministically (a stand-in, never judged) — replacing it with an agent-written one" };
  }
  if (Number.isNaN(ageDays)) {
    return { action: "refresh", ageDays, reason: `the stored brief's generatedAt ("${brief.generatedAt}") cannot be read as a date, so its age is unknown — refreshing rather than trusting it` };
  }
  if (ageDays > BRIEF_TTL_DAYS) {
    return { action: "refresh", ageDays, reason: `the stored brief is ${ageDays} day(s) old, past the ${BRIEF_TTL_DAYS}-day TTL` };
  }
  return { action: "reuse", ageDays, reason: `the stored brief is ${ageDays} day(s) old (written by ${brief.generatedBy}), inside the ${BRIEF_TTL_DAYS}-day TTL` };
}

// ─────────────────────────────────────────────────────────────────────────
// What the brief agent is given, and how a missing source becomes a gap
// rather than a hold.
// ─────────────────────────────────────────────────────────────────────────

/** Per-document ceiling on what reaches the brief agent's prompt. Enough of a context doc to state a positioning from; not the whole document five times over. */
const BRIEF_INPUT_DOC_CHARS = 6000;
/** Per-page ceiling for the client's own site. Their home page's own words are the point, not their footer. */
const BRIEF_INPUT_PAGE_CHARS = 4000;
/** How many of the client's own recent posts travel, and how much of each. Register and recurring subjects, not an archive. */
const BRIEF_INPUT_POSTS = 12;
const BRIEF_INPUT_POST_CHARS = 400;

/** One context document as `00b1` read it: the docType it was asked for and the markdown it got, or `undefined` when there is none. */
export interface BriefContextDocs {
  [docType: string]: string | undefined;
}

/**
 * Everything `00b1-gather-brief-sources` collected, each field
 * `undefined`/empty when that read found nothing. Nothing here is required:
 * a client with only a profile still gets a brief, with `gaps` saying so.
 */
export interface BriefSourceBundle {
  profile?: ClientProfile | undefined;
  brand?: ClientBrand | undefined;
  voiceRules?: VoiceRules | undefined;
  knowledge?: ClientKnowledge | undefined;
  /** The five context documents item H names: product-information, target-audience, market-strategy, brand-voice, competitor-analysis. */
  contextDocs: BriefContextDocs;
  /** The client's own intel report, distilled (`readClientIntelContext`). */
  intelContext?: string | undefined;
  /** `research.fetchPages` over `gatherBriefSourceUrls(profile)`. */
  sitePages?: ReadonlyArray<{ url: string; title?: string; text: string }> | undefined;
  /** `research.socialHistory` over the client's own accounts. */
  ownPosts?: ReadonlyArray<{ platform: string; username: string; url: string; excerpt: string; publishedAt?: string }> | undefined;
  /** Failures the gather step named as it went (a 403 on the pricing page, a scraper that is not configured). Each becomes a gap. */
  problems?: readonly string[] | undefined;
  /** Step 02d's resolved target language, when there is one. */
  targetLanguage?: string | undefined;
  /** The frozen style config's forbidden topics — the client's own standing "never post about this". */
  forbiddenTopics?: readonly string[] | undefined;
}

/** The JSON object the brief agent's single turn receives. Field names are what the prompt refers to. */
export interface BriefAgentInput {
  channel: "instagram";
  profile?: { name?: string; industry?: string; website?: string; description?: string };
  brand?: { tagline?: string; language?: string; palette?: unknown };
  voiceRules?: VoiceRules;
  contextDocs: Array<{ docType: string; markdown: string }>;
  intelContext?: string;
  sitePages: Array<{ url: string; title?: string; text: string }>;
  ownPosts: Array<{ platform: string; username: string; excerpt: string; publishedAt?: string }>;
  knowledgeTitles: string[];
  forbiddenTopics: string[];
  targetLanguage?: string;
  /** What the gather step could NOT read, verbatim, so the agent lists the same shortfalls in its own `gaps` instead of inventing around them. */
  missingSources: string[];
}

export interface BriefAgentInputBuild {
  input: BriefAgentInput;
  /** The `sources` rows the gather step actually produced — the truth the agent's own `sources` claim is checked against. */
  presentSources: BriefSource[];
  /** Named shortfalls, both "no such document" and "the read failed". Passed to the agent AND recorded on the step. */
  gaps: string[];
}

/**
 * Shape the gathered sources into the brief agent's single-turn input.
 *
 * Pure, so the interesting half of `00b1` is testable without a workflow: what
 * counts as a present source, what counts as a gap, and what the model is
 * allowed to see. Every document is clamped — the whole point of this step is
 * one bounded Sonnet call whose cost amortises over a month of runs, and an
 * unclamped knowledge base would make that a per-client lottery.
 *
 * A source that is missing and a source that failed to read are BOTH gaps,
 * and both reach the model, so the brief it writes says what it could not
 * ground. What the relevance floor downstream actually reads is the brief's
 * `sources` list, not its `gaps` prose (`isThinlyGrounded`): a brief that
 * names no product-information document, no target-audience document and no
 * site page gets the lowered floor, whoever wrote it. `presentSources` below
 * is therefore load-bearing, and consumed rather than merely recorded:
 * `00b3` passes it to `stampAgentBrief`, which reconciles the model's claim
 * against it (`reconcileBriefSources`) before the brief is persisted. A
 * grounding source this step read reaches the stored `sources` whether or
 * not the model listed it, and a row for a source this step never supplied
 * does not — so the floor follows what was read.
 */
export function buildBriefAgentInput(bundle: BriefSourceBundle): BriefAgentInputBuild {
  const presentSources: BriefSource[] = [];
  const gaps: string[] = [];

  const profile = bundle.profile;
  if (profile !== undefined) presentSources.push({ kind: "profile", ref: "client.getProfile" });
  else gaps.push("no client profile on file");
  if (bundle.brand !== undefined) presentSources.push({ kind: "brand", ref: "client.getBrand" });
  if (bundle.voiceRules !== undefined) presentSources.push({ kind: "voice-rules", ref: "client.getVoiceRules" });
  else gaps.push("no voice rules on file: register and forbidden claims are unverified");
  if (bundle.knowledge !== undefined) presentSources.push({ kind: "knowledge", ref: "client.getKnowledge" });

  const contextDocs: BriefAgentInput["contextDocs"] = [];
  for (const [docType, markdown] of Object.entries(bundle.contextDocs)) {
    const text = typeof markdown === "string" ? normalise(markdown) : "";
    if (text.length === 0) {
      gaps.push(`no ${docType} document`);
      continue;
    }
    presentSources.push({ kind: "context-doc", ref: docType });
    // Clamped on the RAW markdown (`clampRaw`, not `clampWords`): the model
    // reads headings and lists as structure, and collapsing them costs more
    // than the whitespace saves.
    contextDocs.push({ docType, markdown: clampRaw(markdown as string, BRIEF_INPUT_DOC_CHARS) });
  }

  const sitePages: BriefAgentInput["sitePages"] = [];
  for (const page of bundle.sitePages ?? []) {
    const text = typeof page.text === "string" ? page.text.trim() : "";
    if (text.length === 0) continue;
    presentSources.push({ kind: "site", ref: page.url });
    sitePages.push({ url: page.url, ...(page.title ? { title: page.title } : {}), text: clampRaw(text, BRIEF_INPUT_PAGE_CHARS) });
  }
  if (sitePages.length === 0) gaps.push("the client's own site could not be read (no website on file, or every page failed): positioning rests on onboarding data alone");

  const ownPosts: BriefAgentInput["ownPosts"] = [];
  for (const post of (bundle.ownPosts ?? []).slice(0, BRIEF_INPUT_POSTS)) {
    const excerpt = typeof post.excerpt === "string" ? normalise(post.excerpt) : "";
    if (excerpt.length === 0) continue;
    ownPosts.push({
      platform: post.platform,
      username: post.username,
      excerpt: clampWords(excerpt, BRIEF_INPUT_POST_CHARS),
      ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    });
  }
  if (ownPosts.length > 0) {
    for (const handle of new Set(ownPosts.map((p) => `${p.platform}/@${p.username}`))) {
      presentSources.push({ kind: "social-history", ref: handle });
    }
  } else {
    gaps.push("no recent posts of the client's own could be read: the register in `language.register` is inferred from the voice rules, not observed");
  }

  if (bundle.intelContext !== undefined && bundle.intelContext.trim().length > 0) {
    presentSources.push({ kind: "intel", ref: "intel.getReport" });
  }

  const knowledgeTitles: string[] = [];
  for (const asset of Array.isArray(bundle.knowledge?.assets) ? bundle.knowledge!.assets : []) {
    const title = optionalString(asset?.name);
    if (title) knowledgeTitles.push(clampWords(title, 120));
  }
  for (const transcript of Array.isArray(bundle.knowledge?.transcripts) ? bundle.knowledge!.transcripts : []) {
    const title = optionalString(transcript?.title);
    if (title) knowledgeTitles.push(clampWords(title, 120));
  }

  for (const problem of bundle.problems ?? []) {
    const text = normalise(problem);
    if (text.length > 0 && !gaps.includes(text)) gaps.push(text);
  }

  const input: BriefAgentInput = {
    channel: "instagram",
    ...(profile !== undefined
      ? {
          profile: {
            ...(optionalString(profile.name) ? { name: optionalString(profile.name)! } : {}),
            ...(optionalString(profile.industry) ? { industry: optionalString(profile.industry)! } : {}),
            ...(optionalString(profile.website) ? { website: optionalString(profile.website)! } : {}),
            ...(optionalString(profile.description) ? { description: clampRaw(profile.description as string, BRIEF_INPUT_DOC_CHARS) } : {}),
          },
        }
      : {}),
    ...(bundle.brand !== undefined
      ? {
          brand: {
            ...(optionalString(bundle.brand.tagline) ? { tagline: optionalString(bundle.brand.tagline)! } : {}),
            ...(optionalString(bundle.brand["language"]) ? { language: optionalString(bundle.brand["language"])! } : {}),
          },
        }
      : {}),
    ...(bundle.voiceRules !== undefined ? { voiceRules: bundle.voiceRules } : {}),
    contextDocs,
    ...(bundle.intelContext !== undefined && bundle.intelContext.trim().length > 0
      ? { intelContext: clampRaw(bundle.intelContext, BRIEF_INPUT_DOC_CHARS) }
      : {}),
    sitePages,
    ownPosts,
    knowledgeTitles,
    forbiddenTopics: [...(bundle.forbiddenTopics ?? [])],
    ...(bundle.targetLanguage !== undefined ? { targetLanguage: bundle.targetLanguage } : {}),
    missingSources: gaps,
  };

  return { input, presentSources, gaps };
}

/**
 * The client's own pages the brief agent reads: home, about, pricing.
 *
 * Three because `research.fetchPages` bills per URL and these three carry
 * what the brief actually needs — what they sell (home), who they are and
 * who they sell to (about), and what the current offers are (pricing). A
 * profile with no website yields an empty list, which the gather step records
 * as a `gap` rather than treating as a failure: plenty of clients onboard
 * with a social handle and no site.
 *
 * Bare hosts are normalised to `https://`, because onboarding forms collect
 * "acme.com" as often as a URL, and `research.fetchPages` requires a real
 * one. Anything that still does not parse is dropped — a broken website
 * field must not cost a brief.
 */
export function gatherBriefSourceUrls(profile: ClientProfile | undefined): string[] {
  const raw = optionalString(profile?.website);
  if (raw === undefined) return [];
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `https://${raw.replace(/^\/+/u, "")}`;
  let origin: URL;
  try {
    origin = new URL(withScheme);
  } catch {
    return [];
  }
  // The site's own path is kept when it has one (a client whose "website" is
  // a landing page under a shared domain), and `about`/`pricing` are hung off
  // it rather than off the bare origin.
  const base = `${origin.origin}${origin.pathname.replace(/\/+$/u, "")}`;
  const urls: string[] = [];
  for (const candidate of [base, `${base}/about`, `${base}/pricing`]) {
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  return urls;
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
  /** False when the query IS the input (a scouted `niche-news` headline, already brand-fit judged). */
  rewritten: boolean;
}

/**
 * `<subject> in the context of <what the client sells> for <the ICP>`,
 * trimmed to `MAX_GROUNDED_QUERY_CHARS`, except for a scouted NEWS headline,
 * which passes through as-is (the scout already judged its brand fit, and a
 * dated story's own words are what the sources reporting it use).
 *
 * The pass-through is limited to `engine: "niche-news"` on purpose. Since
 * RFC-13 §I a scouted candidate may come from the client's own documents, an
 * evergreen angle in the brief or a question in a community, and those
 * "headlines" are a document heading or a phrase the scout wrote — not
 * something any publication published. Sent verbatim to a keyword index they
 * return the client's own page or nothing, which is how a heading became the
 * news lane's primary query. Anything but news is therefore grounded exactly
 * like a requested subject.
 *
 * The trimming order when the parts overrun the ceiling: shorten the ICP,
 * then what-we-sell, then the subject — the subject is the one part the
 * client actually asked for.
 */
export function buildGroundedQuery(topicClaim: Pick<InstagramTopicClaim, "topic" | "source" | "trend">, brief: ClientBrief): GroundedQuery {
  const rewrittenFrom = normalise(topicClaim.topic);
  if (topicClaim.source === "trend" && topicClaim.trend?.headline && candidateEngine(topicClaim.trend) === "niche-news") {
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
