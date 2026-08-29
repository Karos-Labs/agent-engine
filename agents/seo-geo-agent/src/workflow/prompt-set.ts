import { createHash } from "node:crypto";
import { DESIRED_OUTCOME_NEUTRAL_PREFILL, SEO_GEO_PROMPT_INTENT_TYPES, type SeoGeoPrompt, type SeoGeoPromptIntentType } from "./types.js";

/**
 * Deterministic default prompt-set templates (RFC-04 §2 Phase 1 /
 * `seo-geo-capture-config.json` `prompt_set`). The source skill calls for
 * genuine per-client drafting judgment here ("Sonnet drafts 20-35 high-intent
 * prompts per client in the client's language ... one Haiku pass tags intent
 * type + de-dupes (5-shingle). Per-intent-type quota enforced") as a bounded
 * `BaseAgent` step — but this repo has no real prompt-authoring UI/judgment
 * source yet, and per this migration's own instructions the assembly step is
 * a deterministic `wf.step.code` stand-in instead of faking judgment with an
 * LLM call that has nothing real to reason about.
 *
 * What IS ported verbatim, because it is a structural contract property, not
 * a judgment call:
 *  - the 5 LOCKED intent types (`SEO_GEO_PROMPT_INTENT_TYPES`);
 *  - a per-intent-type quota, enforced here rather than merely aspired to;
 *  - 5-shingle dedupe against near-duplicate text, so two templates that
 *    would read as the same question are never both kept;
 *  - drafting "in the client's language" — every template exists in every
 *    supported language below, and an unsupported language falls back to
 *    English with `languageFallbackApplied: true`, never silently.
 *
 * 5 templates x 5 intent types = 25 prompts, inside RFC-04's 20-35 range —
 * the exact split isn't given a number anywhere in the v2 config (only the
 * range and "quota enforced" are specified), so an even split across the 5
 * locked intent types is this port's documented choice.
 */
const INTENT_QUOTA_TARGET = 5;

/** `fiveShingleJaccard`'s dedupe threshold — the same 0.40 cutoff `scoring-config.data.ts`/`rec-catalog.data.ts` use for their own "5-shingle Jaccard similarity ... <=0.40" content-differentiation checks, reused here for consistency across this port rather than inventing a second number for the same concept. */
const DEDUPE_JACCARD_THRESHOLD = 0.4;

type TemplateFn = (industry: string) => string;
type IntentTemplateSet = Record<SeoGeoPromptIntentType, readonly TemplateFn[]>;

const EN_TEMPLATES: IntentTemplateSet = {
  discovery: [
    (i) => `What are the best ${i} companies to work with in 2026?`,
    (i) => `Who are the top-rated providers in the ${i} industry?`,
    (i) => `What are the leading alternatives for ${i} services?`,
    (i) => `Which ${i} providers have the strongest customer support?`,
    (i) => `What are the most reputable ${i} brands?`,
  ],
  comparison: [
    (i) => `How do I compare different ${i} companies?`,
    (i) => `What's the difference between enterprise and SMB ${i} offerings?`,
    (i) => `How do reviews differ across ${i} providers?`,
    (i) => `What are the pros and cons of outsourcing ${i}?`,
    (i) => `How do small businesses typically choose a ${i} partner?`,
  ],
  brand: [
    (i) => `Which ${i} brand is most often recommended by industry analysts?`,
    (i) => `What company comes to mind first when you think of ${i} services?`,
    (i) => `Which ${i} providers are considered market leaders?`,
    (i) => `Who are the most well-known names in ${i}?`,
    (i) => `Which ${i} brand has the strongest reputation for reliability?`,
  ],
  problem: [
    (i) => `What should I look for when choosing a ${i} provider?`,
    (i) => `What questions should I ask a ${i} provider before signing up?`,
    (i) => `What are the biggest mistakes companies make when picking a ${i} vendor?`,
    (i) => `What are common pricing models in the ${i} industry?`,
    (i) => `What certifications or standards matter in the ${i} industry?`,
  ],
  navigational: [
    (i) => `How do I find a good ${i} provider near me?`,
    (i) => `What does a good onboarding process look like for ${i} services?`,
    (i) => `How do ${i} providers typically price their services?`,
    (i) => `What trends are shaping the ${i} industry in 2026?`,
    (i) => `How has the ${i} industry changed recently?`,
  ],
};

/**
 * Spanish templates — approximate, generic translations of the English set
 * above (never a fabricated fact or a specific competitor name, same rule as
 * the English templates). Supporting a second language for real, even a
 * partial one, is deliberate: a single-language stand-in cannot exercise, or
 * catch a regression in, "prompts in the client's language" at all.
 */
const ES_TEMPLATES: IntentTemplateSet = {
  discovery: [
    (i) => `¿Cuáles son las mejores empresas de ${i} para trabajar en 2026?`,
    (i) => `¿Quiénes son los proveedores mejor calificados en la industria de ${i}?`,
    (i) => `¿Cuáles son las principales alternativas para servicios de ${i}?`,
    (i) => `¿Qué proveedores de ${i} tienen el mejor soporte al cliente?`,
    (i) => `¿Cuáles son las marcas de ${i} más reconocidas?`,
  ],
  comparison: [
    (i) => `¿Cómo comparo diferentes empresas de ${i}?`,
    (i) => `¿Cuál es la diferencia entre las ofertas de ${i} para grandes empresas y pymes?`,
    (i) => `¿Cómo difieren las reseñas entre proveedores de ${i}?`,
    (i) => `¿Cuáles son los pros y los contras de externalizar ${i}?`,
    (i) => `¿Cómo eligen normalmente las pequeñas empresas un socio de ${i}?`,
  ],
  brand: [
    (i) => `¿Qué marca de ${i} recomiendan con más frecuencia los analistas del sector?`,
    (i) => `¿Qué empresa se te viene a la mente primero cuando piensas en servicios de ${i}?`,
    (i) => `¿Qué proveedores de ${i} se consideran líderes del mercado?`,
    (i) => `¿Cuáles son los nombres más conocidos en ${i}?`,
    (i) => `¿Qué marca de ${i} tiene la mejor reputación de fiabilidad?`,
  ],
  problem: [
    (i) => `¿Qué debo buscar al elegir un proveedor de ${i}?`,
    (i) => `¿Qué preguntas debo hacerle a un proveedor de ${i} antes de contratarlo?`,
    (i) => `¿Cuáles son los errores más comunes al elegir un proveedor de ${i}?`,
    (i) => `¿Cuáles son los modelos de precios más comunes en la industria de ${i}?`,
    (i) => `¿Qué certificaciones o estándares importan en la industria de ${i}?`,
  ],
  navigational: [
    (i) => `¿Cómo encuentro un buen proveedor de ${i} cerca de mí?`,
    (i) => `¿Cómo es un buen proceso de incorporación para servicios de ${i}?`,
    (i) => `¿Cómo suelen fijar los precios los proveedores de ${i}?`,
    (i) => `¿Qué tendencias están marcando la industria de ${i} en 2026?`,
    (i) => `¿Cómo ha cambiado recientemente la industria de ${i}?`,
  ],
};

/** Supported languages this port can honestly draft prompts in. Any other requested language falls back to "en" — see `resolveLanguage`. */
const TEMPLATES_BY_LANGUAGE: Record<string, IntentTemplateSet> = { en: EN_TEMPLATES, es: ES_TEMPLATES };

/** Resolves a requested language tag to a supported one, honestly reporting whether a fallback was applied — never silently drafting English prompts while claiming any other language. */
function resolveLanguage(requested: string | undefined): { languageKey: string; languageFallbackApplied: boolean } {
  const normalized = (requested ?? "en").trim().toLowerCase();
  const languageKey = TEMPLATES_BY_LANGUAGE[normalized] ? normalized : "en";
  return { languageKey, languageFallbackApplied: languageKey !== normalized };
}

/** Word-shingles of the given size (default 5), lowercased and punctuation-stripped. A text shorter than `size` words shingles to itself as one unit rather than producing zero shingles (which would otherwise make Jaccard similarity undefined/always-zero for short prompts). */
function shingles(text: string, size = 5): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return new Set();
  if (words.length < size) return new Set([words.join(" ")]);
  const result = new Set<string>();
  for (let i = 0; i <= words.length - size; i++) {
    result.add(words.slice(i, i + size).join(" "));
  }
  return result;
}

/** 5-shingle Jaccard similarity between two prompt texts (`prompt_set.generation`'s "one Haiku pass tags intent type + de-dupes (5-shingle)" — the dedupe MEASURE itself, same convention `scoring-config.data.ts`/`rec-catalog.data.ts` already use for their own 5-shingle checks). 0 when either text has no shingles at all. */
export function fiveShingleJaccard(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const s of sa) if (sb.has(s)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Keeps a candidate only when its 5-shingle Jaccard similarity to every
 * already-kept text (from THIS intent type's own candidates and from
 * `precedingText`, i.e. every prompt already accepted for an earlier intent
 * type in the same draft) is at or below `DEDUPE_JACCARD_THRESHOLD` — a
 * near-duplicate is dropped, never both copies kept.
 */
export function dedupeFiveShingle(candidates: readonly string[], precedingText: readonly string[] = []): string[] {
  const kept: string[] = [];
  for (const candidate of candidates) {
    const isDuplicate = [...precedingText, ...kept].some((existing) => fiveShingleJaccard(candidate, existing) > DEDUPE_JACCARD_THRESHOLD);
    if (!isDuplicate) kept.push(candidate);
  }
  return kept;
}

export interface IntentPromptSetResult {
  /** Ordered `(intentType, promptText)` pairs, quota-enforced and deduped — `promptId`s are assigned by the caller, which knows the run-wide numbering. */
  entries: Array<{ intentType: SeoGeoPromptIntentType; promptText: string }>;
  /** Per-intent-type shortfalls against `quotaTarget`, e.g. `"brand: 4/5 (deduped against near-identical text elsewhere in the set)"` — never silently padded with a fabricated prompt to hit the count. */
  quotaShortfalls: string[];
}

/**
 * Builds a quota-enforced, 5-shingle-deduped prompt set from raw per-intent
 * candidate lists. Exported (not just used internally by
 * `deriveDefaultPromptSet`) so the dedupe + quota-shortfall contract is
 * directly unit-testable against a synthetic near-duplicate, independent of
 * which language's real templates happen to collide (or, today, don't).
 */
export function buildIntentPromptSet(
  candidatesByIntent: Record<SeoGeoPromptIntentType, readonly string[]>,
  quotaTarget: number = INTENT_QUOTA_TARGET,
): IntentPromptSetResult {
  const entries: Array<{ intentType: SeoGeoPromptIntentType; promptText: string }> = [];
  const quotaShortfalls: string[] = [];

  for (const intentType of SEO_GEO_PROMPT_INTENT_TYPES) {
    const candidates = candidatesByIntent[intentType] ?? [];
    const alreadyKeptText = entries.map((e) => e.promptText);
    const deduped = dedupeFiveShingle(candidates, alreadyKeptText);
    const kept = deduped.slice(0, quotaTarget);
    if (kept.length < quotaTarget) {
      quotaShortfalls.push(`${intentType}: ${kept.length}/${quotaTarget} (deduped against near-identical text elsewhere in the set)`);
    }
    for (const promptText of kept) entries.push({ intentType, promptText });
  }

  return { entries, quotaShortfalls };
}

export interface DefaultPromptSetResult {
  prompts: SeoGeoPrompt[];
  /** The language actually used (after any fallback) — "en", "es", etc. */
  language: string;
  /** True when `requestedLanguage` had no template set and this fell back to "en". */
  languageFallbackApplied: boolean;
  quotaShortfalls: string[];
}

/**
 * Derives the frozen default prompt set for a client's industry and
 * language — deterministic, so two runs given the same industry and
 * language produce byte-identical prompts (before any recurring-run reuse
 * logic applies).
 */
export function deriveDefaultPromptSet(industry: string, requestedLanguage: string | undefined): DefaultPromptSetResult {
  const { languageKey, languageFallbackApplied } = resolveLanguage(requestedLanguage);
  const templateSet = TEMPLATES_BY_LANGUAGE[languageKey]!;

  const candidatesByIntent = {} as Record<SeoGeoPromptIntentType, readonly string[]>;
  for (const intentType of SEO_GEO_PROMPT_INTENT_TYPES) {
    candidatesByIntent[intentType] = templateSet[intentType].map((make) => make(industry));
  }

  const { entries, quotaShortfalls } = buildIntentPromptSet(candidatesByIntent);

  const prompts: SeoGeoPrompt[] = entries.map((entry, index) => ({
    promptId: `prompt_${String(index + 1).padStart(2, "0")}`,
    promptText: entry.promptText,
    intentType: entry.intentType,
    desiredOutcome: DESIRED_OUTCOME_NEUTRAL_PREFILL,
  }));

  return { prompts, language: languageKey, languageFallbackApplied, quotaShortfalls };
}

/** A stable SHA-256 over any JSON-serializable value — used for every RFC-04 §2 "freeze/hash" spine field (`promptSetHash`, `competitorSetHash`, `engineListHash`, `gazetteerHash`, `crawlSnapshotHash`, `responseSetHash`). Internally consistent and deterministic; not required to match any external/legacy hash format (RFC-04's own instructions). */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
