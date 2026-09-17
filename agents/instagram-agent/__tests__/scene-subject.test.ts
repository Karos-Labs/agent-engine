import { describe, expect, it } from "vitest";
import {
  abstractNounIn,
  checkSceneBriefs,
  clampPhrase,
  deriveSubject,
  ENTITY_REF_MAX_CHARS,
  isTechniqueTerm,
  moodWordIn,
  normaliseVisualNeed,
  resolveEntityRef,
  retrievalQueryFor,
  SUBJECT_MUST_SHOW_MAX,
  SUBJECT_NOUN_MAX_CHARS,
  SlideVisualNeedSchema,
  vetSubjectFor,
} from "../src/workflow/scene-brief.js";
import { InstagramCopyOutputSchema } from "../src/workflow/types.js";
import { goodCopyOutput } from "./test-helpers.js";

/**
 * Phase 5.5, item A3 — THE SUBJECT.
 *
 * ## The failure this file is the regression test for
 *
 * Prep run `pubsub-21868183257380937` (karoslabs, 2026-09-16). The cover's
 * scene brief and the vet's own verdict are quoted VERBATIM below from the run
 * record, and they are the whole argument: a brief that could not separate the
 * subject from the grade caused a vet to refuse four correct photographs of
 * server racks, and the post shipped with no pictures in it at all. That is
 * the owner's loudest complaint, traced to one string.
 */

/** `05-write-copy-attempt-2`, slide 1, verbatim from the run record. */
const KAROSLABS_COVER_SCENE =
  "A server infrastructure corridor photographed with long exposure, near-black tones, warm shadows, sharp geometric lines receding into darkness, no people, no legible text in frame";
const KAROSLABS_COVER_WHY =
  "The cover asserts a structural market shift; long-exposure infrastructure signals precision and permanence without generic AI iconography the brand guidelines forbid";
const KAROSLABS_COVER_TERMS = ["server corridor", "data center", "long exposure", "dark infrastructure"];

describe("the legacy shapes still parse, and still get a subject", () => {
  it("a bare-string visualNeed derives one, and derives it usefully", () => {
    const need = normaliseVisualNeed({ visualNeed: "a single laptop open on a wooden desk, warm morning light" });
    expect(need.subject.origin).toBe("derived");
    expect(need.subject.noun).toBe("single laptop open on a wooden desk");
    expect(need.subject.mustShow).toEqual([]);
    expect(need.subject.entityRef).toBeUndefined();
  });

  it("a legacy {scene, why} object — no `subject` key at all — parses and derives one", () => {
    const parsed = SlideVisualNeedSchema.safeParse({ scene: KAROSLABS_COVER_SCENE, why: KAROSLABS_COVER_WHY, source: "stock" });
    expect(parsed.success).toBe(true);
    const need = normaliseVisualNeed({ visualNeed: { scene: KAROSLABS_COVER_SCENE, why: KAROSLABS_COVER_WHY, source: "stock" } });
    expect(need.subject.origin).toBe("derived");
    // The treatment clause is cut at the joiner. THIS is the string the pool
    // actually held four photographs of.
    expect(need.subject.noun).toBe("server infrastructure corridor");
    expect(need.subject.noun).not.toContain("long exposure");
  });

  it("every slide of the canonical fixture still parses through the full copy schema", () => {
    // The compatibility pin. ~30 workflow fixtures write a bare string and
    // every in-flight checkpoint predates `subject`; a resumed run re-parses
    // its own checkpointed copy.
    expect(InstagramCopyOutputSchema.safeParse(goodCopyOutput()).success).toBe(true);
    for (const slide of goodCopyOutput().slides) {
      expect(normaliseVisualNeed(slide).subject.noun.length).toBeGreaterThan(0);
    }
  });
});

describe("an authored subject leads the retrieval query, and the grade never reaches it", () => {
  it("drops the technique term that returned a road tunnel", () => {
    // The Pixabay candidate the vet was left with, verbatim: "tunnel,
    // underpass, light, long exposure, passage, dark, architecture, road".
    // It matched on "long exposure" and on nothing else.
    expect(isTechniqueTerm("long exposure")).toBe(true);
    expect(isTechniqueTerm("dark infrastructure")).toBe(false);
    expect(isTechniqueTerm("server corridor")).toBe(false);
    expect(isTechniqueTerm("morning light")).toBe(true);
    expect(isTechniqueTerm("shallow depth of field")).toBe(true);

    const need = normaliseVisualNeed({
      visualNeed: {
        subject: { noun: "server racks in a data centre", mustShow: ["server racks"] },
        scene: KAROSLABS_COVER_SCENE,
        why: "the cover claims a structural market shift",
        source: "stock",
        searchTerms: KAROSLABS_COVER_TERMS,
      },
    });
    const query = retrievalQueryFor(need);
    expect(query.startsWith("server racks in a data centre")).toBe(true);
    expect(query).not.toContain("long exposure");
    // The writer's own field is untouched — generation and the run record
    // both read it, and neither wants this module's opinion.
    expect(need.searchTerms).toEqual(KAROSLABS_COVER_TERMS);
  });

  it("falls back to the subject alone rather than to a query made of grades", () => {
    const need = normaliseVisualNeed({
      visualNeed: { subject: { noun: "a hospital corridor at night", mustShow: [] }, scene: "x", why: "y", source: "stock", searchTerms: ["long exposure", "warm light"] },
    });
    expect(retrievalQueryFor(need)).toBe("a hospital corridor at night");
  });

  it("hands the vet the subject FIRST and `scene` as declared decoration", () => {
    const need = normaliseVisualNeed({
      visualNeed: {
        subject: { noun: "server racks in a data centre", entityRef: "OpenAI", mustShow: ["server racks", "cable runs"] },
        scene: KAROSLABS_COVER_SCENE,
        why: "the cover claims a structural market shift",
        source: "stock",
      },
    });
    expect(vetSubjectFor(need)).toEqual({
      subject: "server racks in a data centre",
      mustShow: ["server racks", "cable runs"],
      entityRef: "OpenAI",
      scene: KAROSLABS_COVER_SCENE,
      why: "the cover claims a structural market shift",
    });
  });
});

describe("the deterministic guards — findings, never holds", () => {
  it("REJECTS the verbatim karoslabs brief, and names the word that did it", () => {
    // `why`, verbatim from the run: "…long-exposure infrastructure SIGNALS
    // precision and permanence…". The vet read that sentence and refused every
    // photograph that lacked the long exposure, saying so in its own reason.
    expect(moodWordIn(KAROSLABS_COVER_WHY)).toBe("signals");

    const findings = checkSceneBriefs([{ n: 1, visualNeed: { scene: KAROSLABS_COVER_SCENE, why: KAROSLABS_COVER_WHY, source: "stock" } }]);
    const mood = findings.find((f) => f.ruleId === "scene:mood-why");
    expect(mood).toBeDefined();
    expect(mood!.slide).toBe(1);
    expect(mood!.offender).toBe("signals");
    expect(mood!.reason).toContain("signals");
    expect(mood!.reason).toContain("server racks");
  });

  it("refuses an unphotographable subject noun, and only when the WRITER wrote it", () => {
    expect(abstractNounIn("a corridor signalling precision")).toBe("precision");
    expect(abstractNounIn("server racks in a data centre")).toBeUndefined();

    const authored = checkSceneBriefs([
      { n: 2, visualNeed: { subject: { noun: "organisational resilience", mustShow: [] }, scene: "a team", why: "the slide claims the team held", source: "stock" } },
    ]);
    expect(authored.map((f) => f.ruleId)).toContain("scene:abstract-subject");
    expect(authored[0]!.offender).toBe("resilience");

    // The same word, DERIVED by `deriveSubject` out of a legacy scene. No
    // finding: a finding the writer cannot act on costs an attempt for
    // nothing, and this noun is this module's own arithmetic.
    const derived = checkSceneBriefs([{ n: 2, visualNeed: "organisational resilience, rendered as a mountain" }]);
    expect(derived.map((f) => f.ruleId)).not.toContain("scene:abstract-subject");
  });

  it("drops an entityRef nothing in the run corroborates, and never fabricates one", () => {
    expect(resolveEntityRef("ChatGPT", ["ChatGPT", "OpenAI"])).toBe("ChatGPT");
    expect(resolveEntityRef("chatgpt", ["ChatGPT"])).toBe("ChatGPT");
    // Exact, never fuzzy: "Atlas" must not resolve to "Atlassian" and send the
    // pipeline after the wrong company's press kit.
    expect(resolveEntityRef("Atlas", ["Atlassian"])).toBeUndefined();

    const findings = checkSceneBriefs(
      [{ n: 3, visualNeed: { subject: { noun: "a laptop showing a chat interface", entityRef: "Atlas", mustShow: [] }, scene: "a laptop", why: "the slide claims buyers ask first", source: "stock" } }],
      { entityNames: ["Atlassian", "OpenAI"] },
    );
    const dropped = findings.find((f) => f.ruleId === "scene:unresolvable-entity");
    expect(dropped?.offender).toBe("Atlas");
  });

  it("requires a DRAWN likeness when a brief asks to generate a private person — clause L9, keyed off the field", () => {
    const photoreal = {
      n: 4,
      visualNeed: { subject: { noun: "a founder at her desk", entityRef: "Dana Levi", mustShow: [] }, scene: "a photographic portrait of a founder at her desk", why: "the slide claims she rebuilt it", source: "generate" as const },
    };
    const findings = checkSceneBriefs([photoreal], {
      entityNames: ["Dana Levi"],
      personEntityNames: ["Dana Levi"],
      illustrationDeclared: () => false,
    });
    expect(findings.map((f) => f.ruleId)).toContain("scene:person-needs-illustration");

    // Declared as an illustration, in the text the generator is actually
    // handed: approved, and it is often the right call.
    const drawn = checkSceneBriefs([photoreal], { entityNames: ["Dana Levi"], personEntityNames: ["Dana Levi"], illustrationDeclared: () => true });
    expect(drawn.map((f) => f.ruleId)).not.toContain("scene:person-needs-illustration");

    // A PUBLIC figure is not on this path at all — retrieved editorial
    // photography of them is the normal answer.
    const publicFigure = checkSceneBriefs([photoreal], { entityNames: ["Dana Levi"], personEntityNames: [], illustrationDeclared: () => false });
    expect(publicFigure.map((f) => f.ruleId)).not.toContain("scene:person-needs-illustration");
  });

  it("says nothing at all about a slide that chose no picture, or about a legacy bare string", () => {
    expect(checkSceneBriefs([{ n: 5, visualNeed: { scene: "none needed", why: "the stat callout signals the point", source: "none" } }])).toEqual([]);
    expect(checkSceneBriefs([{ n: 6, visualNeed: "a single laptop on a wooden desk" }])).toEqual([]);
  });
});

describe("an over-length subject is clamped at the FIELD, never at the draft", () => {
  it("parses, and truncates at a word boundary", () => {
    const long = "a very long and extremely specific noun phrase describing a corridor full of server racks and cable trays";
    expect(long.length).toBeGreaterThan(SUBJECT_NOUN_MAX_CHARS);
    const need = normaliseVisualNeed({ visualNeed: { subject: { noun: long, entityRef: "x".repeat(ENTITY_REF_MAX_CHARS + 40), mustShow: ["a", "b", "c", "d"] }, scene: "s", why: "w", source: "stock" } });
    expect(need.subject.origin).toBe("authored");
    expect(need.subject.noun.length).toBeLessThanOrEqual(SUBJECT_NOUN_MAX_CHARS);
    expect(need.subject.noun.endsWith(" ")).toBe(false);
    expect(long.startsWith(need.subject.noun)).toBe(true);
    expect(need.subject.entityRef!.length).toBe(ENTITY_REF_MAX_CHARS);
    expect(need.subject.mustShow).toHaveLength(SUBJECT_MUST_SHOW_MAX);
  });

  /**
   * THE POINT OF THE WHOLE ARRANGEMENT, and the reason the schema carries no
   * `max()` on these strings.
   *
   * `visualNeed` lives inside `InstagramSlideCopySchema`. A `max()` violated
   * there does not cost a field — it fails an eight-slide draft that cost
   * ~$0.31, burns an attempt, and cannot fall back to the string branch of the
   * union because an object is not a string. That is exactly how
   * `08c-package-post`'s `altText.max(125)` cost two of three live runs their
   * hashtags on 2026-09-16.
   */
  it("does not fail the DRAFT — the ceiling is enforced by truncation, not by refusal", () => {
    const draft = goodCopyOutput();
    const slide = draft.slides[0]!;
    const withLongSubject = {
      ...draft,
      slides: [{ ...slide, visualNeed: { subject: { noun: "n".repeat(400), mustShow: [] }, scene: "a corridor", why: "the slide claims it", source: "stock" as const } }, ...draft.slides.slice(1)],
    };
    const parsed = InstagramCopyOutputSchema.safeParse(withLongSubject);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(normaliseVisualNeed(parsed.data!.slides[0]!).subject.noun.length).toBeLessThanOrEqual(SUBJECT_NOUN_MAX_CHARS);
  });

  it("clampPhrase falls back to a hard cut when the first word is already longer than the ceiling", () => {
    expect(clampPhrase("abcdefghij", 4)).toBe("abcd");
    expect(clampPhrase("one two three", 8)).toBe("one two");
    expect(clampPhrase("  spaced   out  ", 40)).toBe("spaced out");
  });
});

describe("deriveSubject, over the shapes a real brief takes", () => {
  it.each([
    ["A server infrastructure corridor photographed with long exposure, near-black tones", "server infrastructure corridor"],
    ["the OpenAI office lobby, shot from the mezzanine", "OpenAI office lobby"],
    ["an empty meeting room mid-afternoon", "empty meeting room mid-afternoon"],
    ["A close-up of hands typing on a laptop; warm indoor light", "close-up of hands typing on a laptop"],
    ["", ""],
  ])("%s -> %s", (scene, expected) => {
    expect(deriveSubject(scene).noun).toBe(expected);
  });
});
