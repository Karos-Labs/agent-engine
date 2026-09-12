import { describe, expect, it } from "vitest";
import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import {
  DEVICE_BEARING_ARCHETYPES,
  NO_IMAGE_MEANS_DEVICE_RULE,
  NO_IMAGE_MEANS_DEVICE_RULE_ID,
  SCENE_KEYWORD_WORD_LIMIT,
  SlideVisualNeedSchema,
  VisualNeedFieldSchema,
  archetypeOfTemplate,
  checkNoImageMeansDevice,
  generationPromptFor,
  needsImageSourcing,
  normaliseVisualNeed,
  retrievalQueryFor,
  vetSubjectFor,
  type SceneRuleCopyView,
  type SceneRuleSlideView,
} from "../src/workflow/scene-brief.js";
import { INVERTED_TEMPLATE_SUFFIX } from "../src/workflow/slides-data.js";
import { checkDefaultRenderRules, templateBasename } from "../src/workflow/visual-qa-pre-checks.js";
import { checkExpectedScript, languageGateText } from "../src/workflow/language-gate.js";
import { InstagramCopyOutputSchema, type InstagramCopyOutput } from "../src/workflow/types.js";
import { goodCopyOutput } from "./test-helpers.js";

/**
 * Phase 3, brief item R — the scene brief, the one reader every consumer goes
 * through, and the fifth default render rule.
 *
 * Two of these describes are DRIFT PINS rather than behaviour tests, and they
 * are the reason `scene-brief.ts` is allowed to restate two facts that live
 * in other modules: it must import nothing from the workflow (a cycle through
 * `types.ts` → `scene-brief.ts` → `visual-qa-pre-checks.ts` → `slides-data.ts`
 * → `types.ts` would break module init), so the restatements are checked
 * against the originals HERE, where importing both is free.
 */

const LONG_SCENE = "a single laptop open on a wooden desk beside a half finished coffee, warm morning light, no people in frame at all";

function sceneCopySlide(n: number, visualNeed: SceneRuleCopyView["visualNeed"]): SceneRuleCopyView {
  return { n, visualNeed };
}

function renderedSlide(n: number, template: string, over: Partial<SceneRuleSlideView> = {}): SceneRuleSlideView {
  return { n, template, fields: { headline: `Finding ${n}`, body: "A plain sentence." }, images: {}, htmlFragments: {}, ...over };
}

describe("SlideVisualNeedSchema — the field split", () => {
  it("parses a full brief and defaults source to stock", () => {
    const parsed = SlideVisualNeedSchema.parse({ scene: "two people reviewing a printed chart at a table", why: "the slide claims teams read this together" });
    expect(parsed.source).toBe("stock");
    expect(parsed.searchTerms).toBeUndefined();
  });

  it("requires `why` — a brief with no stated purpose is a shopping list, which is what the vet cannot judge", () => {
    expect(SlideVisualNeedSchema.safeParse({ scene: "a desk" }).success).toBe(false);
  });

  it("holds scene to 240 characters and searchTerms to six terms of 40 characters", () => {
    const base = { scene: "a desk", why: "because" };
    expect(SlideVisualNeedSchema.safeParse({ ...base, scene: "x".repeat(241) }).success).toBe(false);
    expect(SlideVisualNeedSchema.safeParse({ ...base, scene: "x".repeat(240) }).success).toBe(true);
    expect(SlideVisualNeedSchema.safeParse({ ...base, searchTerms: ["a", "b", "c", "d", "e", "f", "g"] }).success).toBe(false);
    expect(SlideVisualNeedSchema.safeParse({ ...base, searchTerms: ["x".repeat(41)] }).success).toBe(false);
    expect(SlideVisualNeedSchema.safeParse({ ...base, searchTerms: [] }).success).toBe(false);
  });

  it("refuses a source outside the four the cascade knows", () => {
    expect(SlideVisualNeedSchema.safeParse({ scene: "a desk", why: "because", source: "illustration" }).success).toBe(false);
  });

  it("the union accepts both shapes — that is what keeps in-flight checkpoints and a model that regresses parsing", () => {
    expect(VisualNeedFieldSchema.safeParse("a busy open-plan office, daytime").success).toBe(true);
    expect(VisualNeedFieldSchema.safeParse({ scene: "a busy office", why: "the claim is about offices", source: "generate" }).success).toBe(true);
    expect(VisualNeedFieldSchema.safeParse("").success).toBe(false);
    expect(VisualNeedFieldSchema.safeParse({ scene: "a busy office" }).success).toBe(false);
  });
});

describe("normaliseVisualNeed — the one reader", () => {
  it("reads a legacy bare string as a stock scene with no stated why", () => {
    const need = normaliseVisualNeed({ visualNeed: "a close-up of hands typing on a laptop keyboard at a clean desk" });
    expect(need.scene).toBe("a close-up of hands typing on a laptop keyboard at a clean desk");
    expect(need.why).toBeUndefined();
    expect(need.source).toBe("stock");
  });

  it("derives at most eight keyword terms from the scene, punctuation stripped", () => {
    const need = normaliseVisualNeed({ visualNeed: LONG_SCENE });
    expect(need.searchTerms).toHaveLength(SCENE_KEYWORD_WORD_LIMIT);
    expect(need.searchTerms).toEqual(["a", "single", "laptop", "open", "on", "a", "wooden", "desk"]);
    // The third stacked constraint ("warm morning light, no people") is what
    // returned the Swedish street kiosk; truncation is what removes it.
    expect(retrievalQueryFor(need)).toBe("a single laptop open on a wooden desk");
    expect(need.searchTerms.some((term) => term.includes(","))).toBe(false);
  });

  it("strips punctuation in a non-Latin script too (Hebrew is a first-class target language)", () => {
    const need = normaliseVisualNeed({ visualNeed: "צוות קטן יושב סביב שולחן, בוחן גרפים מודפסים" });
    expect(need.searchTerms).toEqual(["צוות", "קטן", "יושב", "סביב", "שולחן", "בוחן", "גרפים", "מודפסים"]);
  });

  it("uses authored searchTerms verbatim when the writer supplied them", () => {
    const need = normaliseVisualNeed({ visualNeed: { scene: LONG_SCENE, why: "the slide claims solo mornings", source: "stock", searchTerms: ["laptop", "wooden desk", "morning light"] } });
    expect(need.searchTerms).toEqual(["laptop", "wooden desk", "morning light"]);
    expect(retrievalQueryFor(need)).toBe("laptop wooden desk morning light");
  });

  it("derives them when the writer did not, so the retrieval query is never the whole 240-character brief", () => {
    const need = normaliseVisualNeed({ visualNeed: { scene: LONG_SCENE, why: "the slide claims solo mornings", source: "stock" } });
    expect(need.searchTerms).toHaveLength(SCENE_KEYWORD_WORD_LIMIT);
    expect(retrievalQueryFor(need).length).toBeLessThan(LONG_SCENE.length);
  });

  it("hands generation the scene and the vet the scene PLUS the why — the two halves the old single string could not serve at once", () => {
    const slide = { visualNeed: { scene: "an empty meeting room mid-afternoon", why: "the claim is that the standup stopped happening", source: "generate" as const } };
    const need = normaliseVisualNeed(slide);
    expect(generationPromptFor(need)).toBe("an empty meeting room mid-afternoon");
    expect(generationPromptFor(need)).not.toContain("standup");
    expect(vetSubjectFor(need)).toEqual({ scene: "an empty meeting room mid-afternoon", why: "the claim is that the standup stopped happening" });
    expect(vetSubjectFor(normaliseVisualNeed({ visualNeed: "an empty meeting room" }))).toEqual({ scene: "an empty meeting room" });
  });

  it("only `none` opts a slide out of sourcing — a preferred tier that came back empty must not leave the slide with nothing", () => {
    expect(needsImageSourcing(normaliseVisualNeed({ visualNeed: { scene: "a desk", why: "w", source: "none" } }))).toBe(false);
    for (const source of ["stock", "generate", "client-upload"] as const) {
      expect(needsImageSourcing(normaliseVisualNeed({ visualNeed: { scene: "a desk", why: "w", source } }))).toBe(true);
    }
    expect(needsImageSourcing(normaliseVisualNeed({ visualNeed: "a desk" }))).toBe(true);
  });

  /**
   * A Hebrew post with an ENGLISH scene brief, which is what
   * `instagram-copy@15` §22 now asks for.
   *
   * The two fields never reach a reader: `searchTerms` goes to a keyword index
   * and `scene` to an image model, and §22 says so in the same words the
   * art-director prompt uses. This pins the pipeline half of that rule — the
   * query and the generation prompt come out in Latin script, and the language
   * gate (which exempts `visualNeed` on purpose) still passes the draft on its
   * Hebrew caption and slides. Hebrew search terms would return near nothing
   * from Unsplash and Pexels and would prompt the generator in a script it
   * cannot draw to.
   */
  it("keeps a Hebrew draft's scene brief in Latin script, and the language gate still passes the post", () => {
    const need = normaliseVisualNeed({
      visualNeed: {
        scene: "a small team around a table reading printed charts, window light",
        why: "the claim is that they review the numbers together",
        source: "stock" as const,
        searchTerms: ["team meeting", "printed charts", "window light"],
      },
    });
    expect(retrievalQueryFor(need)).toBe("team meeting printed charts window light");
    expect(/^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(retrievalQueryFor(need))).toBe(true);
    expect(/^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(generationPromptFor(need))).toBe(true);

    const hebrew: InstagramCopyOutput = {
      ...goodCopyOutput(),
      caption: "הצוות קורא את המספרים יחד בכל שבוע, וזה מה שהשתנה מאז. שווה לדפדף.",
      slides: goodCopyOutput().slides.map((slide) => ({
        ...slide,
        headline: "המספרים נקראים יחד",
        body: "הצוות יושב סביב שולחן אחד ובוחן את הגרפים המודפסים לפני שמישהו מחליט משהו.",
        visualNeed: {
          scene: "a small team around a table reading printed charts, window light",
          why: "the claim is that they review the numbers together",
          source: "stock" as const,
          searchTerms: ["team meeting", "printed charts", "window light"],
        },
      })),
    };
    // The gate reads the caption and the on-image prose only, which is exactly
    // why §22's English rule cannot be enforced by it and has to be stated in
    // the prompt.
    const verdict = checkExpectedScript(languageGateText(hebrew), "Hebrew");
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(languageGateText(hebrew)).not.toContain("printed charts");
  });

  it("never throws on a shape the schema was supposed to guarantee", () => {
    const malformed = { visualNeed: { scene: "a desk with nothing else on it" } as unknown as string };
    expect(() => normaliseVisualNeed(malformed)).not.toThrow();
    expect(normaliseVisualNeed(malformed).scene).toBe("a desk with nothing else on it");
    const empty = { visualNeed: null as unknown as string };
    expect(normaliseVisualNeed(empty)).toEqual({ scene: "", source: "stock", searchTerms: [] });
    expect(retrievalQueryFor(normaliseVisualNeed({ visualNeed: "…" }))).toBe("…");
  });
});

describe("the compatibility pin — every existing fixture still parses", () => {
  it("accepts every bare-string visualNeed the canonical six-slide fixture writes, and reads it back unchanged", () => {
    const fixture = goodCopyOutput();
    expect(fixture.slides.length).toBeGreaterThan(0);
    for (const slide of fixture.slides) {
      expect(VisualNeedFieldSchema.safeParse(slide.visualNeed).success).toBe(true);
      expect(normaliseVisualNeed(slide).scene).toBe(slide.visualNeed);
      expect(normaliseVisualNeed(slide).source).toBe("stock");
    }
  });

  it("the fixture still parses through the copy schema itself", () => {
    expect(() => InstagramCopyOutputSchema.parse(goodCopyOutput())).not.toThrow();
  });
});

describe("default:no-image-means-device", () => {
  it("is a render-checked rule with the id the workflow reports", () => {
    expect(NO_IMAGE_MEANS_DEVICE_RULE.id).toBe(NO_IMAGE_MEANS_DEVICE_RULE_ID);
    expect(NO_IMAGE_MEANS_DEVICE_RULE_ID).toBe("default:no-image-means-device");
    expect(NO_IMAGE_MEANS_DEVICE_RULE.check).toBe("render");
    expect(NO_IMAGE_MEANS_DEVICE_RULE.description).toContain("source");
  });

  const NO_IMAGE: SceneRuleCopyView["visualNeed"] = { scene: "no picture: the idea is a ratio", why: "a photograph would add nothing", source: "none" };

  it("fails a slide that chose no image and renders as type on bare ground, naming the slide and a remedy the writer controls", () => {
    const result = checkNoImageMeansDevice([renderedSlide(3, "headline-focus.html")], [sceneCopySlide(3, NO_IMAGE)]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.ruleId).toBe(NO_IMAGE_MEANS_DEVICE_RULE_ID);
    expect(result.failures[0]!.slide).toBe(3);
    expect(result.failures[0]!.reason).toContain("slide 3");
    expect(result.failures[0]!.reason).toContain("headline-focus.html");
    expect(result.failures[0]!.reason).toContain("figure_pair");
    expect(result.residue).toHaveLength(0);
  });

  it("passes the same slide once it carries a device", () => {
    const withDevice = renderedSlide(3, "headline-focus.html", { htmlFragments: { device: "<div class=\"cf-figure\">58%</div>" } });
    expect(checkNoImageMeansDevice([withDevice], [sceneCopySlide(3, NO_IMAGE)]).failures).toHaveLength(0);
  });

  it("counts a closer's recap strip and a list's rows as the designed block they are", () => {
    const recap = renderedSlide(6, "closer.html", { template: "closer.html", htmlFragments: { recap: "<ul><li>one</li></ul>" } });
    const rows = renderedSlide(4, "slide.html", { htmlFragments: { itemRows: "<li>one</li><li>two</li>" } });
    expect(checkNoImageMeansDevice([recap, rows], [sceneCopySlide(6, NO_IMAGE), sceneCopySlide(4, NO_IMAGE)]).failures).toHaveLength(0);
  });

  it("passes a slide that ended up with a hero anyway — a draft must never be returned over a picture it HAS", () => {
    const withHero = renderedSlide(2, "slide.html", { images: { hero: "fixtures/images/photo-1.png" } });
    expect(checkNoImageMeansDevice([withHero], [sceneCopySlide(2, NO_IMAGE)]).failures).toHaveLength(0);
  });

  it("passes every archetype that carries the frame on its own", () => {
    for (const archetype of DEVICE_BEARING_ARCHETYPES) {
      const slide = renderedSlide(1, `${archetype}.html`);
      expect(checkNoImageMeansDevice([slide], [sceneCopySlide(1, NO_IMAGE)]).failures, archetype).toHaveLength(0);
    }
  });

  it("passes the inverted variant of a device-bearing archetype (ground/fg inversion is not a different archetype)", () => {
    const slide = renderedSlide(1, `templates/stat-callout${INVERTED_TEMPLATE_SUFFIX}.html`);
    expect(checkNoImageMeansDevice([slide], [sceneCopySlide(1, NO_IMAGE)]).failures).toHaveLength(0);
  });

  it("hands a model-authored custom archetype to the judge instead of failing it — a template path cannot read its markup", () => {
    const result = checkNoImageMeansDevice([renderedSlide(5, "custom-pull-rail.html")], [sceneCopySlide(5, NO_IMAGE)]);
    expect(result.failures).toHaveLength(0);
    expect(result.residue).toEqual([{ slide: 5, note: expect.stringContaining("slide 5") }]);
  });

  it("is inert for every other source, and for a legacy bare string", () => {
    const bare = renderedSlide(1, "slide.html");
    for (const source of ["stock", "generate", "client-upload"] as const) {
      expect(checkNoImageMeansDevice([bare], [sceneCopySlide(1, { scene: "a desk", why: "w", source })]).failures).toHaveLength(0);
    }
    expect(checkNoImageMeansDevice([bare], [sceneCopySlide(1, "a desk with a laptop")]).failures).toHaveLength(0);
  });

  it("skips a drafted slide the render never produced — that is checkSlidesData's finding, not this rule's", () => {
    expect(checkNoImageMeansDevice([], [sceneCopySlide(7, NO_IMAGE)]).failures).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Drift pins for the two facts `scene-brief.ts` restates rather than imports
// ─────────────────────────────────────────────────────────────────────────

describe("drift pin — archetypeOfTemplate against the real templateBasename", () => {
  it("agrees on every path shape the renderer produces", () => {
    for (const template of [
      "slide.html",
      "cover.html",
      "stat-callout.html",
      `stat-callout${INVERTED_TEMPLATE_SUFFIX}.html`,
      "templates/default/closer.html",
      "templates\\default\\quote-card.html",
      "custom-pull-rail.html",
      "no-extension",
    ]) {
      expect(archetypeOfTemplate(template), template).toBe(templateBasename(template));
    }
  });

  it("strips the inversion suffix the renderer actually appends", () => {
    expect(archetypeOfTemplate(`cover${INVERTED_TEMPLATE_SUFFIX}.html`)).toBe("cover");
  });
});

describe("drift pin — DEVICE_BEARING_ARCHETYPES against visual-qa-pre-checks' own cover rule", () => {
  /** A one-slide carousel whose cover renders through `template` with no hero and no device — the exact shape `default:cover-carries-device` judges. */
  function coverOnly(template: string): { slidesData: RenderCarouselInput; copy: InstagramCopyOutput } {
    const slide: Slide = { n: 1, template, fields: { headline: "A finding", body: "A plain sentence about it." }, images: {}, htmlFragments: {} };
    const slidesData: RenderCarouselInput = {
      client: "acme",
      postId: "post_scene_brief",
      templateDir: "fixtures/templates",
      outDir: "out",
      repoRoot: "/repo",
      slides: [slide],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      readyFlag: "__CAROUSEL_READY__",
    };
    const copy: InstagramCopyOutput = {
      format: "carousel",
      caption: "Which of these would you change first?",
      slides: [{ n: 1, headline: "A finding", body: "A plain sentence about it.", visualNeed: "a desk", sourceRef: "claim", layout: "photo" }],
    };
    return { slidesData, copy };
  }

  function coverFailures(template: string): number {
    const { slidesData, copy } = coverOnly(template);
    return checkDefaultRenderRules(slidesData, copy).failures.filter((f) => f.ruleId === "default:cover-carries-device").length;
  }

  it("every archetype this module treats as self-carrying is one the cover rule also accepts", () => {
    for (const archetype of DEVICE_BEARING_ARCHETYPES) {
      expect(coverFailures(`${archetype}.html`), archetype).toBe(0);
    }
  });

  it("and the two shapes it deliberately excludes are refused there — so the sets cannot drift apart silently", () => {
    // `headline-focus` is the bare-headline defect itself; `slide.html` is the
    // client's own base template, a file this repo does not control.
    expect(DEVICE_BEARING_ARCHETYPES.has("headline-focus")).toBe(false);
    expect(DEVICE_BEARING_ARCHETYPES.has("slide")).toBe(false);
    expect(coverFailures("headline-focus.html")).toBe(1);
    expect(coverFailures("slide.html")).toBe(1);
  });
});
