import { describe, expect, it } from "vitest";
import {
  buildIntentPromptSet,
  deriveDefaultPromptSet,
  fiveShingleJaccard,
  sha256Hex,
} from "../src/workflow/prompt-set.js";
import { DESIRED_OUTCOME_NEUTRAL_PREFILL, SEO_GEO_PROMPT_INTENT_TYPES, type SeoGeoPromptIntentType } from "../src/workflow/types.js";

/** Changes only the LAST word of a >=5-word phrase, so every 5-word shingle except the final one is left untouched — a controlled, reliably-high-similarity near-duplicate regardless of phrase length. */
function nearDuplicateOf(text: string): string {
  const words = text.split(" ");
  words[words.length - 1] = `${words[words.length - 1]}x`;
  return words.join(" ");
}

describe("fiveShingleJaccard (SCRUM-320 / AU29)", () => {
  it("is 1.0 for identical text", () => {
    expect(fiveShingleJaccard("what are the best widget companies", "what are the best widget companies")).toBe(1);
  });

  it("is 0 for completely unrelated text", () => {
    expect(fiveShingleJaccard("what are the best widget companies to work with", "how do dolphins navigate the open ocean at night")).toBe(0);
  });

  it("is high for a near-duplicate that only changes the final word", () => {
    const a = "which enterprise widget vendors do analysts recommend most often";
    const b = nearDuplicateOf(a);
    expect(fiveShingleJaccard(a, b)).toBeGreaterThan(0.4);
  });
});

/** Ten realistic, mutually-unrelated 9-word phrases per intent type — deliberately spanning unrelated topics so no pair collides under the 5-shingle dedupe threshold unless a test says otherwise. */
const BASE_CANDIDATES: Record<SeoGeoPromptIntentType, string[]> = {
  discovery: [
    "which enterprise widget vendors do analysts recommend most often",
    "what cloud hosting providers dominate the european market currently",
    "who are the leading suppliers of organic coffee beans worldwide",
    "which mobile app development studios have won design awards recently",
    "what solar panel manufacturers lead the residential installation market",
  ],
  comparison: [
    "how does apple hardware pricing compare to competitor laptops overall",
    "what distinguishes budget airlines from premium carriers on international routes",
    "how do organic grocery chains compare to discount supermarkets nationally",
    "what separates boutique hotels from large chain hotels in service",
    "how does electric vehicle range compare across major manufacturers today",
  ],
  brand: [
    "which sneaker brand is most associated with basketball culture globally",
    "what soft drink brand dominates vending machine sales in schools",
    "which luxury watch brand is most recognized by young professionals",
    "what fast food chain is most popular among college students",
    "which streaming service brand has the largest subscriber base worldwide",
  ],
  problem: [
    "what should renters check before signing an apartment lease agreement",
    "what mistakes do new drivers make when buying their first car",
    "what should freelancers verify before accepting a new client contract",
    "what should travelers pack when visiting a tropical climate destination",
    "what should homeowners inspect before installing rooftop solar panels themselves",
  ],
  navigational: [
    "how do i find the nearest certified mechanic for my car",
    "how do i locate a licensed electrician in my neighborhood quickly",
    "how do i find an accredited university offering online degrees",
    "how do i locate a reputable moving company for a relocation",
    "how do i find a trustworthy plumber for emergency repairs tonight",
  ],
};

function freshCandidates(): Record<SeoGeoPromptIntentType, string[]> {
  const copy = {} as Record<SeoGeoPromptIntentType, string[]>;
  for (const intentType of SEO_GEO_PROMPT_INTENT_TYPES) copy[intentType] = [...BASE_CANDIDATES[intentType]];
  return copy;
}

describe("buildIntentPromptSet — 5-shingle dedupe + per-intent quota (SCRUM-320 / AU29)", () => {
  it("keeps every candidate and reports no shortfall when nothing collides", () => {
    const { entries, quotaShortfalls } = buildIntentPromptSet(freshCandidates(), 5);
    expect(entries).toHaveLength(25);
    expect(quotaShortfalls).toEqual([]);
    expect(new Set(entries.map((e) => e.intentType))).toEqual(new Set(SEO_GEO_PROMPT_INTENT_TYPES));
  });

  it("drops a near-duplicate within the same intent type instead of keeping both copies", () => {
    const byIntent = freshCandidates();
    byIntent.discovery[1] = nearDuplicateOf(byIntent.discovery[0]!);

    const { entries } = buildIntentPromptSet(byIntent, 5);
    const discoveryTexts = entries.filter((e) => e.intentType === "discovery").map((e) => e.promptText);
    expect(discoveryTexts).not.toContain(byIntent.discovery[1]);
    expect(discoveryTexts).toContain(byIntent.discovery[0]);
  });

  it("reports a quota shortfall — never silently pads with a fabricated prompt — when dedupe leaves an intent type under quota", () => {
    const byIntent = freshCandidates();
    // Collapse "brand" to 3 genuinely distinct candidates plus 2 near-duplicates of the first — only 3 survive dedupe.
    byIntent.brand = [
      byIntent.brand[0]!,
      byIntent.brand[1]!,
      byIntent.brand[2]!,
      nearDuplicateOf(byIntent.brand[0]!),
      nearDuplicateOf(nearDuplicateOf(byIntent.brand[0]!)),
    ];

    const { entries, quotaShortfalls } = buildIntentPromptSet(byIntent, 5);
    const brandCount = entries.filter((e) => e.intentType === "brand").length;
    expect(brandCount).toBe(3);
    expect(quotaShortfalls).toEqual(["brand: 3/5 (deduped against near-identical text elsewhere in the set)"]);
    // The other 4 intent types were unaffected — total is honestly short, never padded back up to 25.
    expect(entries).toHaveLength(4 * 5 + brandCount);
  });

  it("dedupes across intent-type boundaries too, not just within one intent type", () => {
    const byIntent = freshCandidates();
    // "comparison" candidate #1 is a near-duplicate of "discovery" candidate #1, which is processed first.
    byIntent.comparison[0] = nearDuplicateOf(byIntent.discovery[0]!);

    const { entries, quotaShortfalls } = buildIntentPromptSet(byIntent, 5);
    const comparisonTexts = entries.filter((e) => e.intentType === "comparison").map((e) => e.promptText);
    expect(comparisonTexts).not.toContain(byIntent.comparison[0]);
    expect(quotaShortfalls.some((s) => s.startsWith("comparison:"))).toBe(true);
  });
});

describe("deriveDefaultPromptSet — language, intent locking, and NEUTRAL desired_outcome prefill (SCRUM-320 / AU29)", () => {
  it("drafts 20-35 prompts across exactly the 5 locked intent types, every one NEUTRAL-prefilled", () => {
    const result = deriveDefaultPromptSet("B2B SaaS", "en", "Acme Corp");
    expect(result.prompts.length).toBeGreaterThanOrEqual(20);
    expect(result.prompts.length).toBeLessThanOrEqual(35);
    expect(result.language).toBe("en");
    expect(result.languageFallbackApplied).toBe(false);
    expect(result.quotaShortfalls).toEqual([]);
    for (const prompt of result.prompts) {
      expect(SEO_GEO_PROMPT_INTENT_TYPES).toContain(prompt.intentType);
      // Never the flattering default, never the gap-hiding one.
      expect(prompt.desiredOutcome).toBe(DESIRED_OUTCOME_NEUTRAL_PREFILL);
      expect(prompt.desiredOutcome).not.toBe("named_first");
      expect(prompt.desiredOutcome).not.toBe("not_applicable");
    }
  });

  it("names the client in every brand-intent prompt, and in no other intent", () => {
    // The defect this replaced: the `brand` templates took only the industry,
    // so all five asked "is this client the category leader" — structurally
    // false for anyone who is not one. Karos Labs was shown 0% brand presence
    // while Gemini, asked directly, named them five times and cited their site.
    const result = deriveDefaultPromptSet("AI Digital Marketing", "en", "Karos Labs");
    const brandPrompts = result.prompts.filter((p) => p.intentType === "brand");
    const otherPrompts = result.prompts.filter((p) => p.intentType !== "brand");

    expect(brandPrompts.length).toBeGreaterThan(0);
    for (const prompt of brandPrompts) {
      expect(prompt.promptText, `brand prompt does not name the client: ${prompt.promptText}`).toContain("Karos Labs");
    }
    // A category question that happens to name the client would be measuring
    // something else entirely — the whole point of the split is that the two
    // intents ask different questions.
    for (const prompt of otherPrompts) {
      expect(prompt.promptText, `non-brand prompt names the client: ${prompt.promptText}`).not.toContain("Karos Labs");
    }
  });

  it("names the client in Spanish brand prompts too", () => {
    const result = deriveDefaultPromptSet("Marketing Digital", "es", "Karos Labs");
    const brandPrompts = result.prompts.filter((p) => p.intentType === "brand");
    expect(brandPrompts.length).toBeGreaterThan(0);
    for (const prompt of brandPrompts) expect(prompt.promptText).toContain("Karos Labs");
  });

  it("produces a different prompt set for a different client in the same industry", () => {
    // Before, two clients in one industry got byte-identical prompt sets — the
    // set said nothing about either of them. `promptSetHash` is derived from
    // these, so it could not distinguish them either.
    const a = deriveDefaultPromptSet("AI Digital Marketing", "en", "Karos Labs");
    const b = deriveDefaultPromptSet("AI Digital Marketing", "en", "Rival Co");
    expect(a.prompts).not.toEqual(b.prompts);
    expect(sha256Hex({ prompts: a.prompts, language: a.language })).not.toBe(
      sha256Hex({ prompts: b.prompts, language: b.language }),
    );
  });

  it("still deduplicates and fills every intent quota once brand prompts are client-specific", () => {
    // The brand templates changed shape entirely; the 5-shingle dedupe runs
    // across intents, so a rewrite could silently collide with `comparison`
    // and leave the set short.
    const result = deriveDefaultPromptSet("AI Digital Marketing", "en", "Karos Labs");
    expect(result.quotaShortfalls).toEqual([]);
    expect(result.prompts.length).toBeGreaterThanOrEqual(20);
  });

  it("drafts in the client's language when supported (Spanish), with real Spanish text — not just a language label", () => {
    const result = deriveDefaultPromptSet("B2B SaaS", "es", "Acme Corp");
    expect(result.language).toBe("es");
    expect(result.languageFallbackApplied).toBe(false);
    expect(result.prompts.every((p) => /[¿¡áéíóúñ]/i.test(p.promptText))).toBe(true);
  });

  it("falls back to English, honestly flagged, for an unsupported language rather than drafting nothing or fabricating translations", () => {
    const result = deriveDefaultPromptSet("B2B SaaS", "de", "Acme Corp");
    expect(result.language).toBe("en");
    expect(result.languageFallbackApplied).toBe(true);
    expect(result.prompts.length).toBeGreaterThanOrEqual(20);
  });

  it("treats an unset language the same as an explicit 'en' request", () => {
    const result = deriveDefaultPromptSet("B2B SaaS", undefined, "Acme Corp");
    expect(result.language).toBe("en");
    expect(result.languageFallbackApplied).toBe(false);
  });

  it("is deterministic — same industry and language produce byte-identical prompts", () => {
    const a = deriveDefaultPromptSet("Fintech", "en", "Acme Corp");
    const b = deriveDefaultPromptSet("Fintech", "en", "Acme Corp");
    expect(a.prompts).toEqual(b.prompts);
  });

  it("promptSetHash (via sha256Hex over {prompts, language}) differs between languages even for the same industry", () => {
    const en = deriveDefaultPromptSet("Fintech", "en", "Acme Corp");
    const es = deriveDefaultPromptSet("Fintech", "es", "Acme Corp");
    const enHash = sha256Hex({ prompts: en.prompts, language: en.language });
    const esHash = sha256Hex({ prompts: es.prompts, language: es.language });
    expect(enHash).not.toBe(esHash);
  });
});
