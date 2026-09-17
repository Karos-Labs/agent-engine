import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tools";
import {
  ALT_TEXT_MAX_CHARS,
  EVENT_DATED_WINDOW_DAYS,
  FIRST_COMMENT_MAX_SOURCES,
  MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET,
  PostPackageSchema,
  STALE_AFTER_HOURS,
  buildFirstCommentSources,
  buildTimingNote,
  checkPackageRules,
  checkPostPackage,
  packageLanguageGateFields,
  resolveHashtagPlacement,
  type PackagedFactCard,
  type PackagedSlide,
  type PostPackage,
  type PostPackageCheckInput,
} from "../src/workflow/post-package.js";

/**
 * RFC-18 §6 — the whole post: hashtags, alt text, a sourced first comment and
 * a timing constraint.
 *
 * ## The one test this file exists for
 *
 * "THE BUILDER NEVER READS THE MODEL" below is the load-bearing case. Every
 * other guard here refuses something; that one proves a class of failure has
 * no way in at all. A packager reply carrying an invented URL — in its prose
 * AND in an extra `sources` array it was never asked for — must produce a
 * shipped post with that URL nowhere in it, and the sources that DO ship must
 * be a subset of this run's own fact-card URLs.
 *
 * It fails the moment `buildFirstCommentSources` ever reads the packager's
 * output, and it cannot even be written against a builder whose signature
 * admits one: the function takes the slides and the fact cards, and that is
 * the whole of its input.
 *
 * Nothing in this file calls a model. The two gate calls go to the REAL
 * `createKarosGatesTools()` — no workspace, no network — for the reason
 * `native-corrections.test.ts` already gives: a stubbed gate proves nothing
 * about whether a real one would have said yes.
 */

const ctx: AgentContext = { runId: "run_post_package", clientSlug: "coldline", productId: "instagram-agent", runKind: "recurring", metadata: {} };

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — a commercial-kitchen servicer, RFC-18 §5.6's neutral trade
// ─────────────────────────────────────────────────────────────────────────

const CARD_COIL: PackagedFactCard = {
  claim: "A condenser coil cleaned quarterly draws 12 percent less power than one cleaned annually",
  source: "ASHRAE Journal",
  date: "2026-03-11",
  url: "https://ashrae.org/journal/coil-fouling-2026",
};
const CARD_DOWNTIME: PackagedFactCard = {
  claim: "Unplanned walk-in failures cost independent restaurants a median 2,400 dollars per incident",
  source: "Restaurant Equipment Council",
  date: "2026-01-22",
  url: "https://rec.example.org/downtime-2026",
};
/** No `url`: a citation a reader cannot follow is not a source line. */
const CARD_NO_URL: PackagedFactCard = {
  claim: "Most independent kitchens service refrigeration reactively",
  source: "internal service log",
  date: "2026-02-02",
};

const FACT_CARDS: readonly PackagedFactCard[] = [CARD_COIL, CARD_DOWNTIME, CARD_NO_URL];

function slides(...refs: ReadonlyArray<{ n: number; headline: string; sourceRef: string }>): PackagedSlide[] {
  return refs.map((r) => ({ n: r.n, headline: r.headline, sourceRef: r.sourceRef }));
}

const SHIPPED: PackagedSlide[] = slides(
  { n: 1, headline: "Your walk-in is not dying of old age", sourceRef: CARD_COIL.claim },
  { n: 2, headline: "What a dirty coil actually costs", sourceRef: CARD_DOWNTIME.claim },
  { n: 3, headline: "Most kitchens wait for the failure", sourceRef: CARD_NO_URL.claim },
  { n: 4, headline: "Quarterly, not annually", sourceRef: CARD_COIL.claim },
);

function englishPackage(over: Partial<PostPackage> = {}): PostPackage {
  return {
    hashtags: ["restaurantequipment", "walkincooler", "kitchenmaintenance"],
    altText: [
      { n: 1, alt: "A rooftop condenser unit with a grey-furred coil, shot close." },
      { n: 2, alt: "A dark walk-in interior, door propped, thermometer on the shelf." },
      { n: 3, alt: "A service technician kneeling beside an open equipment panel." },
      { n: 4, alt: "A wall calendar with four service dates circled in accent ink." },
    ],
    firstCommentText: "Sources for the two figures on slides 1 and 2 are below, in the order they appear.",
    ...over,
  };
}

function englishCheck(over: Partial<PostPackageCheckInput> = {}): PostPackageCheckInput {
  return { pkg: englishPackage(), slides: SHIPPED, coreTerms: ["restaurant equipment", "walk-in cooler", "refrigeration"], ...over };
}

function hebrewPackage(over: Partial<PostPackage> = {}): PostPackage {
  return {
    hashtags: ["ציודמסעדות", "קירורמסחרי", "תחזוקתמטבח"],
    altText: [
      { n: 1, alt: "יחידת עיבוי על הגג, סליל אפור ומאובק, צילום מקרוב." },
      { n: 2, alt: "חדר קירור חשוך עם דלת פתוחה ומדחום על המדף." },
      { n: 3, alt: "טכנאי שירות כורע ליד לוח ציוד פתוח." },
      { n: 4, alt: "לוח שנה על הקיר עם ארבעה מועדי שירות מסומנים." },
    ],
    firstCommentText: "המקורות לשני הנתונים שמופיעים בשקופיות הראשונה והשנייה מופיעים כאן, לפי סדר הופעתם.",
    ...over,
  };
}

function hebrewCheck(over: Partial<PostPackageCheckInput> = {}): PostPackageCheckInput {
  return {
    pkg: hebrewPackage(),
    slides: slides(
      { n: 1, headline: "חדר הקירור שלכם לא מת מזקנה", sourceRef: CARD_COIL.claim },
      { n: 2, headline: "כמה באמת עולה סליל מלוכלך", sourceRef: CARD_DOWNTIME.claim },
      { n: 3, headline: "רוב המטבחים מחכים לתקלה", sourceRef: CARD_NO_URL.claim },
      { n: 4, headline: "רבעוני, לא שנתי", sourceRef: CARD_COIL.claim },
    ),
    coreTerms: ["ציוד מסעדות", "קירור מסחרי"],
    allowedLatinTerms: ["HACCP"],
    targetLanguage: "Hebrew",
    ...over,
  };
}

/** The reason a refusal gave, or a message saying it did not refuse at all. */
function reasonOf(verdict: { ok: boolean; reason?: string }): string {
  return verdict.ok ? "<<PASSED — this case was supposed to refuse>>" : (verdict.reason ?? "");
}

// ─────────────────────────────────────────────────────────────────────────
describe("THE BUILDER NEVER READS THE MODEL — RFC-18 §6.4", () => {
  /**
   * A packager reply as it arrives from the vendor: prose with a plausible,
   * entirely invented URL in it, plus a `sources` array nothing asked for and
   * the schema has no field for. Both halves are how a model actually
   * fabricates a citation.
   */
  const INVENTED = "https://kitchen-safety-institute.example/coil-study-2026";
  const RAW_PACKAGER_REPLY: Record<string, unknown> = {
    hashtags: ["restaurantequipment", "walkincooler", "kitchenmaintenance"],
    altText: [
      { n: 1, alt: "A rooftop condenser unit with a grey-furred coil, shot close." },
      { n: 2, alt: "A dark walk-in interior, door propped, thermometer on the shelf." },
      { n: 3, alt: "A service technician kneeling beside an open equipment panel." },
      { n: 4, alt: "A wall calendar with four service dates circled in accent ink." },
    ],
    firstCommentText: `Full study: ${INVENTED} — worth reading before your next service call.`,
    sources: [
      { label: "Kitchen Safety Institute, 2026", url: INVENTED },
      { label: "ASHRAE Journal, 2026", url: "https://ashrae.example/not-the-real-one" },
    ],
  };

  it("the schema has nowhere for a source to go, so the model's `sources` array does not survive parsing", () => {
    const parsed = PostPackageSchema.parse(RAW_PACKAGER_REPLY);
    expect(parsed).not.toHaveProperty("sources");
    expect(Object.keys(parsed).sort()).toEqual(["altText", "firstCommentText", "hashtags"]);
  });

  it("the free rules refuse the invented URL in the prose too, before any re-ask is paid for", () => {
    const pkg = PostPackageSchema.parse(RAW_PACKAGER_REPLY);
    const verdict = checkPackageRules(englishCheck({ pkg }));
    expect(reasonOf(verdict)).toContain("URL");
    expect(reasonOf(verdict)).toContain("built in code");
  });

  /**
   * THE LOAD-BEARING ASSERTION.
   *
   * The built sources are a subset of this run's own fact-card URLs — not
   * "do not contain the invented one", which a filter could fake, but a
   * subset of a set the model never had write access to.
   *
   * Make `buildFirstCommentSources` read the packager's output in any way and
   * this test cannot compile, because its signature does not admit it.
   */
  it("builds the first comment's sources from the SLIDES and the FACT CARDS, and never from the packager's reply", () => {
    const built = buildFirstCommentSources(SHIPPED, FACT_CARDS);

    const runUrls = new Set(FACT_CARDS.map((c) => c.url).filter((u): u is string => typeof u === "string"));
    for (const source of built) {
      expect(runUrls.has(source.url), `built source "${source.url}" is not one of this run's fact-card URLs`).toBe(true);
    }
    expect(built.length).toBeGreaterThan(0);
    expect(JSON.stringify(built)).not.toContain(INVENTED);

    // Not "the built sources happen to exclude the invented one", which a
    // filter could fake: the invented URL is not in the run's fact cards at
    // all, so a builder that could reach the model's output would have had to
    // INVENT this set to pass. Both of the model's fabricated sources are
    // absent — the plausible one (an ASHRAE URL that is not the real ASHRAE
    // URL) as much as the obvious one.
    expect(RAW_PACKAGER_REPLY["sources"]).toHaveLength(2);
    for (const fabricated of RAW_PACKAGER_REPLY["sources"] as Array<{ url: string }>) {
      expect(built.some((s) => s.url === fabricated.url)).toBe(false);
    }
  });

  /**
   * And the whole shipped post, end to end, on the path a run actually takes:
   * the free rules refuse the URL-bearing prose, the packager is re-asked once
   * under `08c-package-post-retry`, and the post that ships is assembled from
   * the re-ask's prose plus CODE-BUILT sources.
   *
   * Asserting this over the REFUSED reply — as an earlier draft of this test
   * did — asserts something the workflow never ships and goes red for the right
   * reason at the wrong step. What must be true is that no URL the model ever
   * wrote survives into the shipped object, and the two mechanisms that make it
   * true are a refusal and a builder, tested here together.
   */
  it("ships a post with no model-written URL anywhere in it, after the free refusal and the one re-ask", () => {
    const refused = checkPackageRules(englishCheck({ pkg: PostPackageSchema.parse(RAW_PACKAGER_REPLY) }));
    expect(refused.ok).toBe(false);

    const reAsked = PostPackageSchema.parse({
      ...RAW_PACKAGER_REPLY,
      firstCommentText: "Both figures on slides 1 and 2 are sourced below, in the order they appear.",
    });
    expect(checkPackageRules(englishCheck({ pkg: reAsked }))).toEqual({ ok: true });

    const post = {
      hashtags: reAsked.hashtags,
      hashtagPlacement: resolveHashtagPlacement(undefined),
      altText: reAsked.altText,
      firstComment: { text: reAsked.firstCommentText, sources: buildFirstCommentSources(SHIPPED, FACT_CARDS) },
      timing: buildTimingNote(FACT_CARDS, new Date("2026-09-13T00:00:00Z")),
    };
    const shipped = JSON.stringify(post);
    expect(shipped).not.toContain("kitchen-safety-institute");
    expect(shipped).not.toContain("ashrae.example");
    // Every URL in the shipped post, whatever field it sits in, came from a
    // fact card — scanned out of the serialised object rather than read out of
    // the one field this test remembered to look at.
    for (const url of shipped.match(/https?:\/\/[^"\s]+/g) ?? []) {
      expect(FACT_CARDS.some((c) => c.url === url), `shipped URL "${url}" is not one of this run's fact-card URLs`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("buildFirstCommentSources", () => {
  it("follows the slides' sourceRefs, in slide order, labelled from the card", () => {
    const built = buildFirstCommentSources(SHIPPED, FACT_CARDS);
    expect(built).toEqual([
      { label: "ASHRAE Journal, 2026-03-11", url: CARD_COIL.url },
      { label: "Restaurant Equipment Council, 2026-01-22", url: CARD_DOWNTIME.url },
    ]);
  });

  it("dedupes by URL — two slides resting on one study is one source line", () => {
    // Slides 1 and 4 both cite CARD_COIL.
    const built = buildFirstCommentSources(SHIPPED, FACT_CARDS);
    expect(built.filter((s) => s.url === CARD_COIL.url)).toHaveLength(1);
  });

  it("skips a card with no URL — a citation a reader cannot follow is not a source line", () => {
    const built = buildFirstCommentSources(slides({ n: 1, headline: "h", sourceRef: CARD_NO_URL.claim }), FACT_CARDS);
    expect(built).toEqual([]);
  });

  it("skips a sourceRef that matches no card rather than inventing a label for it", () => {
    const built = buildFirstCommentSources(slides({ n: 1, headline: "h", sourceRef: "a claim no card carries" }), FACT_CARDS);
    expect(built).toEqual([]);
  });

  it(`caps at ${FIRST_COMMENT_MAX_SOURCES} — past that a first comment is a bibliography`, () => {
    const cards: PackagedFactCard[] = Array.from({ length: 8 }, (_, i) => ({
      claim: `claim ${i}`,
      source: `Source ${i}`,
      date: "2026-04-01",
      url: `https://example.org/${i}`,
    }));
    const built = buildFirstCommentSources(
      cards.map((c, i) => ({ n: i + 1, headline: `h${i}`, sourceRef: c.claim })),
      cards,
    );
    expect(built).toHaveLength(FIRST_COMMENT_MAX_SOURCES);
    expect(built.map((s) => s.url)).toEqual(["https://example.org/0", "https://example.org/1", "https://example.org/2", "https://example.org/3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("resolveHashtagPlacement — the caption, whatever the client's own feed does", () => {
  const measured = (hashtagsPerPost: number) => ({
    measured: { posts: 22, meanSentenceWords: 12, meanCaptionChars: 300, questionsPerPost: 0.2, emojiPerPost: 0.4, hashtagsPerPost },
  });

  it("keeps the tags in the caption even for an account whose own posts never carry one", () => {
    // This case returned "firstComment" until Phase 5.6. The owner's
    // specification makes caption placement a HARD rule, and a habit of
    // accounts that do not need reach is not a technique to imitate.
    expect(resolveHashtagPlacement(measured(0))).toBe("caption");
  });

  it("keeps them in the caption when the client's own posts carry tags", () => {
    expect(resolveHashtagPlacement(measured(4.1))).toBe("caption");
  });

  it("NO register produces a first-comment placement — the union member is dead, and this is what keeps it dead", () => {
    const everyShape = [undefined, {}, measured(0), measured(0.4), measured(12), measured(Number.NaN)];
    for (const register of everyShape) {
      expect(resolveHashtagPlacement(register as never)).toBe("caption");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("checkPackageRules — hashtags (RFC-18 §6.3)", () => {
  it("passes a clean English package, and a clean Hebrew one", () => {
    expect(checkPackageRules(englishCheck())).toEqual({ ok: true });
    expect(checkPackageRules(hebrewCheck())).toEqual({ ok: true });
  });

  /** Each of these fails ON ITS OWN, from an otherwise clean package. */
  const badTags: ReadonlyArray<[label: string, tags: string[], expect: string]> = [
    ["a leading hash", ["#restaurantequipment", "walkincooler", "kitchenmaintenance"], "leading"],
    ["a space", ["restaurant equipment", "walkincooler", "kitchenmaintenance"], "legal tag"],
    ["punctuation", ["restaurant-equipment", "walkincooler", "kitchenmaintenance"], "legal tag"],
    ["a one-character tag", ["restaurantequipment", "walkincooler", "k"], "legal tag"],
    ["a duplicate after case folding", ["restaurantequipment", "RestaurantEquipment", "kitchenmaintenance"], "case folding"],
  ];
  for (const [label, tags, expected] of badTags) {
    it(`refuses ${label}`, () => {
      expect(reasonOf(checkPackageRules(englishCheck({ pkg: englishPackage({ hashtags: tags }) })))).toContain(expected);
    });
  }

  it("refuses nikud, and says so — a pointed tag is a different string from the one anyone searches", () => {
    const pointed = "צִיוּדמסעדות";
    const verdict = checkPackageRules(hebrewCheck({ pkg: hebrewPackage({ hashtags: [pointed, "קירורמסחרי", "תחזוקתמטבח"] }) }));
    // The grammar rule would also reject this (a combining mark is neither
    // `\p{L}` nor `\p{N}`), so the REASON is what proves the nikud rule is the
    // one that fired. Delete that rule and this goes red on the message.
    expect(reasonOf(verdict)).toContain("nikud");
  });

  it("refuses a tag that mixes scripts within itself", () => {
    const verdict = checkPackageRules(hebrewCheck({ pkg: hebrewPackage({ hashtags: ["ציודrestaurant", "קירורמסחרי", "תחזוקתמטבח"] }) }));
    expect(reasonOf(verdict)).toContain("mixes");
  });

  it("refuses a tag set with no overlap with the client's own core terms — derivation, not invention", () => {
    const verdict = checkPackageRules(
      englishCheck({ pkg: englishPackage({ hashtags: ["aimarketing", "growthhacking", "contentstrategy"] }) }),
    );
    expect(reasonOf(verdict)).toContain("core terms");
  });

  it("accepts a tag that concatenates a multiword core term", () => {
    expect(checkPackageRules(englishCheck({ pkg: englishPackage({ hashtags: ["restaurantequipment", "coilcleaning", "hvacr"] }) }))).toEqual({ ok: true });
  });

  it(`refuses more than ${MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET} Latin tags for a Hebrew client`, () => {
    const verdict = checkPackageRules(
      hebrewCheck({ pkg: hebrewPackage({ hashtags: ["ציודמסעדות", "HACCP", "HVAC", "NSF", "קירורמסחרי"] }), allowedLatinTerms: ["HACCP", "HVAC", "NSF"] }),
    );
    expect(reasonOf(verdict)).toContain("Latin-script");
  });

  it(`allows exactly ${MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET} Latin tags when both are on the client's own allowedLatinTerms`, () => {
    expect(
      checkPackageRules(hebrewCheck({ pkg: hebrewPackage({ hashtags: ["ציודמסעדות", "HACCP", "HVAC", "קירורמסחרי"] }), allowedLatinTerms: ["HACCP", "HVAC"] })),
    ).toEqual({ ok: true });
  });

  it("refuses a Latin tag the client's own term policy has never sanctioned — no translating a Hebrew term into English for reach", () => {
    const verdict = checkPackageRules(hebrewCheck({ pkg: hebrewPackage({ hashtags: ["ציודמסעדות", "commercialkitchen", "קירורמסחרי"] }) }));
    expect(reasonOf(verdict)).toContain("allowedLatinTerms");
  });

  it("applies no Latin cap at all to a Latin-script client", () => {
    expect(checkPackageRules(englishCheck({ targetLanguage: "English" }))).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("checkPackageRules — alt text (RFC-18 §6.4)", () => {
  it("requires one per shipped slide", () => {
    const pkg = englishPackage({ altText: englishPackage().altText.slice(0, 3) });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("slide 4 has no alt text");
  });

  it("refuses alt text for a slide that is not in the shipped carousel", () => {
    const pkg = englishPackage({ altText: [...englishPackage().altText, { n: 7, alt: "A slide that never shipped." }] });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("not in the shipped carousel");
  });

  it("refuses alt text that only restates the headline — the headline is already on the plate", () => {
    const pkg = englishPackage({ altText: englishPackage().altText.map((a) => (a.n === 2 ? { n: 2, alt: "What a dirty coil actually costs" } : a)) });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("restates its headline");
  });

  const openers: ReadonlyArray<[string, string]> = [
    ["English", "Image of a rooftop condenser unit, shot close."],
    ["Hebrew", "תמונה של יחידת עיבוי על הגג."],
  ];
  for (const [label, alt] of openers) {
    it(`refuses a redundant "${label}" opener`, () => {
      const base = label === "Hebrew" ? hebrewCheck() : englishCheck();
      const pkg = { ...base.pkg, altText: base.pkg.altText.map((a) => (a.n === 1 ? { n: 1, alt } : a)) };
      expect(reasonOf(checkPackageRules({ ...base, pkg }))).toContain("opens with");
    });
  }

  it("refuses a URL in alt text — the field is read aloud", () => {
    const pkg = englishPackage({ altText: englishPackage().altText.map((a) => (a.n === 1 ? { n: 1, alt: "See https://ashrae.org for the study." } : a)) });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("URL");
  });

  it("refuses a hashtag in alt text, but not an ordinal hash", () => {
    const tagged = englishPackage({ altText: englishPackage().altText.map((a) => (a.n === 1 ? { n: 1, alt: "A furred coil. #restaurantequipment" } : a)) });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg: tagged })))).toContain("hashtag");

    // "#1" is ordinary English. A rule that refuses it is a false-positive
    // generator sitting in front of a re-ask we pay for.
    const ordinal = englishPackage({ altText: englishPackage().altText.map((a) => (a.n === 1 ? { n: 1, alt: "The #1 cause of walk-in failure, close up." } : a)) });
    expect(checkPackageRules(englishCheck({ pkg: ordinal }))).toEqual({ ok: true });
  });

  it(`refuses alt text past ${ALT_TEXT_MAX_CHARS} characters`, () => {
    const long = "A ".repeat(80).trim();
    const pkg = { ...englishPackage(), altText: englishPackage().altText.map((a) => (a.n === 1 ? { n: 1, alt: long } : a)) };
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain(`${ALT_TEXT_MAX_CHARS}-character cap`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("checkPackageRules — the first comment", () => {
  it("refuses a URL in the prose, naming why the model does not write one", () => {
    const pkg = englishPackage({ firstCommentText: "Sources: www.ashrae.org and the council's 2026 downtime report." });
    const reason = reasonOf(checkPackageRules(englishCheck({ pkg })));
    expect(reason).toContain("URL");
    expect(reason).toContain("fact cards");
  });

  it("refuses a bare hostname, which is how a model writes a URL when told not to write a URL", () => {
    const pkg = englishPackage({ firstCommentText: "The full study is on ashrae.org if you want the methodology." });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("URL");
  });

  it("refuses a hashtag in the first comment — the tags are a typed field placed in code", () => {
    const pkg = englishPackage({ firstCommentText: "Sources below. #restaurantequipment" });
    expect(reasonOf(checkPackageRules(englishCheck({ pkg })))).toContain("hashtag");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("packageLanguageGateFields", () => {
  it("names the comment and each slide's alt text, and shows the judge NO hashtags", () => {
    const fields = packageLanguageGateFields(hebrewPackage());
    expect(fields.map((f) => f.id)).toEqual(["comment", "alt-1", "alt-2", "alt-3", "alt-4"]);
    // A one-word tag has no span to anchor a correction into (RFC-18 §6.3);
    // the tag rules are deterministic and free instead.
    expect(JSON.stringify(fields)).not.toContain("ציודמסעדות");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("checkPostPackage — the two free gates", () => {
  const tools = createKarosGatesTools();

  it("passes a clean package through both gates", async () => {
    await expect(checkPostPackage(tools, ctx, englishCheck())).resolves.toEqual({ ok: true });
  });

  it("routes a `gate.lintPost` failure in the first comment back with the field named", async () => {
    // An em dash: banned by `gate.lintPost` in every language, and the exact
    // character a prep run failed craft hygiene on twice in three attempts.
    const pkg = englishPackage({ firstCommentText: "Sources below — both figures are from 2026." });
    const verdict = await checkPostPackage(tools, ctx, englishCheck({ pkg }));
    expect(reasonOf(verdict)).toContain("first comment failed the post lint");
  });

  it("maps a failing alt text back to ITS SLIDE NUMBER, not to a thread part index", async () => {
    const pkg = englishPackage({ altText: englishPackage().altText.map((a) => (a.n === 3 ? { n: 3, alt: "A technician kneeling beside a panel — mid repair." } : a)) });
    const verdict = await checkPostPackage(tools, ctx, englishCheck({ pkg }));
    expect(reasonOf(verdict)).toContain("slide 3's alt text");
  });

  it("runs the free rules FIRST, so a free refusal never reaches a gate", async () => {
    const pkg = englishPackage({ hashtags: ["#restaurantequipment", "walkincooler", "kitchenmaintenance"] });
    const verdict = await checkPostPackage(tools, ctx, englishCheck({ pkg }));
    expect(reasonOf(verdict)).toContain("leading");
  });

  it("degrades to `ok` rather than throwing when the registry has no gates at all — a missing tool must never cost the package", async () => {
    await expect(checkPostPackage({}, ctx, englishCheck())).resolves.toEqual({ ok: true });
  });

  /**
   * RFC-18 §6.1: "there is no state in which the whole post costs us the post".
   *
   * This paragraph used to say `checkCraftHygiene` throws on exactly this
   * outcome and that it is correct THERE. RFC-19's Mechanism C has since made
   * the first half false: a REGISTERED `gate.lintPost` that fails, at either
   * gate, now forms no opinion and records a ledger warn. Both call sites take
   * the same posture on an outage, and this one simply took it first.
   *
   * The reasoning below is what survives, and it is about an UNREGISTERED tool,
   * where the two still differ on purpose: `07b` runs inside the drafting loop
   * on copy that must not ship unchecked and throws; here the loop has already
   * broken and the carousel is approved, gated and rendered, so a throw would
   * end that run over a missing tool.
   *
   * Both shapes an outage takes, because they arrive on different lines: a
   * non-success `execute` outcome, and a success carrying a `tooling_error`
   * verdict.
   */
  // `ReturnType` takes the FUNCTION, not the tool: the brackets belong inside,
  // around `["execute"]`. Written the other way round it asked for
  // `ReturnType<AgentTool>`, which is why this line was the last error in
  // `tsc -p tsconfig.test.json`. `NonNullable` because the registry is indexed
  // under `noUncheckedIndexedAccess` (the same reason line 511 carries a `!`).
  //
  // Resolving to the real `AgentToolOutcome<unknown>` also costs both entries
  // their `as never`: the first one was spelling the refusal field `error`,
  // and the union calls it `reason`. Nothing consumed it — `checkPostPackage`
  // only reads `status` — but a cast that wide would have hidden the drift
  // just as happily if it HAD been consumed.
  type LintOutcome = Awaited<ReturnType<NonNullable<(typeof tools)["gate.lintPost"]>["execute"]>>;
  const outages: ReadonlyArray<[string, LintOutcome]> = [
    ["a non-success outcome", { status: "tooling_error", reason: "lint provider unavailable" }],
    ["a `tooling_error` verdict", { status: "success", result: { verdict: "tooling_error", reason: "lint provider unavailable" } }],
  ];
  for (const [label, outcome] of outages) {
    it(`treats ${label} from gate.lintPost as no opinion, not as a refusal and not as a throw`, async () => {
      const outaged = { ...tools, "gate.lintPost": { ...tools["gate.lintPost"]!, execute: async () => outcome } };
      // The em dash that the real gate refuses two tests above. With the gate
      // out, the package ships — degraded, never held.
      const pkg = englishPackage({ firstCommentText: "Sources below — both figures are from 2026." });
      await expect(checkPostPackage(outaged as never, ctx, englishCheck({ pkg }))).resolves.toEqual({ ok: true });
    });
  }

  it("catches a Hebrew alt text written in the wrong script, through `gate.nativeLanguage`", async () => {
    const base = hebrewCheck();
    const pkg = { ...base.pkg, altText: base.pkg.altText.map((a) => (a.n === 2 ? { n: 2, alt: "A dark walk-in interior with the door propped open and a thermometer resting on the shelf" } : a)) };
    const verdict = await checkPostPackage(tools, ctx, { ...base, pkg, scriptName: "Hebrew", scriptPattern: "\\p{Script=Hebrew}" });
    expect(reasonOf(verdict)).toContain("conventions gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("buildTimingNote — 08c3, $0 (RFC-18 §6.4)", () => {
  const now = new Date("2026-09-13T12:00:00Z");

  it("calls a post evergreen when nothing it rests on is dated recently", () => {
    expect(buildTimingNote(FACT_CARDS, now)).toEqual({ basis: "evergreen", reason: "no dated claim — no timing constraint" });
  });

  it(`marks a claim inside the ${EVENT_DATED_WINDOW_DAYS}-day window event-dated, and says when the hook goes off`, () => {
    const fresh: PackagedFactCard = { claim: "c", source: "Reuters", date: "2026-09-10T09:00:00Z", url: "https://reuters.example/x" };
    const note = buildTimingNote([...FACT_CARDS, fresh], now);
    expect(note.basis).toBe("event-dated");
    expect(note.staleAfter).toBe(new Date(Date.parse(fresh.date) + STALE_AFTER_HOURS * 3_600_000).toISOString());
    expect(note.reason).toContain("Reuters");
  });

  it("takes the FRESHEST card in the window — that is the claim the hook rides on", () => {
    const older: PackagedFactCard = { claim: "a", source: "Older", date: "2026-09-08T00:00:00Z" };
    const newer: PackagedFactCard = { claim: "b", source: "Newer", date: "2026-09-12T00:00:00Z" };
    expect(buildTimingNote([older, newer], now).reason).toContain("Newer");
    expect(buildTimingNote([newer, older], now).reason).toContain("Newer");
  });

  it("treats a future-dated card as the most perishable hook there is", () => {
    const announced: PackagedFactCard = { claim: "c", source: "Press release", date: "2026-09-20T00:00:00Z" };
    expect(buildTimingNote([announced], now).basis).toBe("event-dated");
  });

  it("treats a date it cannot parse as no dated claim, rather than guessing a constraint onto a real calendar", () => {
    expect(buildTimingNote([{ claim: "c", source: "Trade survey", date: "Q3" }], now).basis).toBe("evergreen");
  });

  it(`drops out of the window at ${EVENT_DATED_WINDOW_DAYS} days`, () => {
    const justInside: PackagedFactCard = { claim: "c", source: "S", date: "2026-09-07T00:00:00Z" };
    const justOutside: PackagedFactCard = { claim: "c", source: "S", date: "2026-09-05T00:00:00Z" };
    expect(buildTimingNote([justInside], now).basis).toBe("event-dated");
    expect(buildTimingNote([justOutside], now).basis).toBe("evergreen");
  });
});
