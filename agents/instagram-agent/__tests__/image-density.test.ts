import { describe, expect, it } from "vitest";
import {
  conceptualPromptFor,
  ALWAYS_EXCLUDED,
  exclusionsFor,
  ILLUSTRATION_REGISTERS,
  literalIllustrationOf,
  photorealAllowed,
  registerFor,
  planImageBackfill,
  resolveRescuedSelection,
  sceneDescribesAPicture,
} from "../src/workflow/image-density.js";
import { MIN_PICTURE_SLIDES } from "../src/workflow/imagery-floor.js";
import { MIN_GENERATED_IMAGES_PER_RUN } from "../src/workflow/run-budget.js";
import type { InstagramCopyOutput, InstagramSlideCopy, InstagramSlideLayout } from "../src/workflow/types.js";

/**
 * The picture floor could measure a shortfall it could not reach.
 *
 * Both prep carousels of 2026-09-18 opted out of a picture on six slides of
 * eight, shipped under `MIN_PICTURE_SLIDES` — Karos at 2, Geektime at 0 — and
 * recorded, in the trace, *"no slide is still without a picture, so there is
 * nothing to fill"*. Every fixture below is that post's shape.
 */

function slide(n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy {
  return {
    n,
    headline: `Headline ${n}`,
    body: `A claim on slide ${n}. And a second sentence.`,
    sourceRef: "a claim",
    layout: "list_takeaway" as InstagramSlideLayout,
    visualNeed: {
      scene: "this is a list of rules, no photograph adds to a typed checklist",
      why: "the content is the three steps",
      source: "none",
    },
    ...over,
  } as InstagramSlideCopy;
}

/** The Geektime draft's own shape: eight slides, pictures asked for on 1 and 6 only. */
function geektimeShaped(): InstagramCopyOutput {
  return {
    slides: [
      slide(1, { layout: "cover", visualNeed: { scene: "a lone developer at a workstation in a dark room", why: "x", source: "stock" } }),
      slide(2),
      slide(3, { layout: "headline_focus" }),
      slide(4),
      slide(5, { layout: "stat_callout" }),
      slide(6, { layout: "photo", visualNeed: { scene: "a presenter on a conference stage", why: "x", source: "stock" } }),
      slide(7, { layout: "quote_card" }),
      slide(8, { layout: "closer" }),
    ],
  } as unknown as InstagramCopyOutput;
}

describe("the guarantee can actually reach the floor", () => {
  it("buys at least as many frames as the floor needs from zero", () => {
    // The arithmetic that shipped Geektime with no pictures: the floor wanted
    // 3 and the guarantee stopped at 2, so a carousel that started at 0 ran
    // out one frame short every single time. A guarantee that cannot satisfy
    // the floor is not a guarantee.
    expect(MIN_GENERATED_IMAGES_PER_RUN).toBeGreaterThanOrEqual(MIN_PICTURE_SLIDES);
  });
});

describe("sceneDescribesAPicture", () => {
  it("reads an opted-out scene as the ARGUMENT it is, not as a brief", () => {
    // All four verbatim from the two runs.
    expect(sceneDescribesAPicture("typographic editorial slide, no photograph needed")).toBe(false);
    expect(sceneDescribesAPicture("a minimal security checklist on a dark background, technical context")).toBe(false);
    expect(sceneDescribesAPicture("this is a list of rules, no photograph adds to a typed checklist")).toBe(false);
    expect(sceneDescribesAPicture("closing typographic slide, no photograph needed")).toBe(false);
  });

  it("still reads a real scene as a picture, including one on a slide that then said `none`", () => {
    expect(sceneDescribesAPicture("a presenter on a tech conference stage, a screen behind them showing terminal output")).toBe(true);
    expect(sceneDescribesAPicture("access control panel, rows of switches, cold light")).toBe(true);
  });

  it("is not a refusal anywhere — an empty scene is the only false a caller can act on", () => {
    expect(sceneDescribesAPicture("")).toBe(false);
    expect(sceneDescribesAPicture("   ")).toBe(false);
  });
});

describe("conceptualPromptFor", () => {
  it("briefs from the slide's CLAIM, because the slide's own scene is a picture of a slide", () => {
    const prompt = conceptualPromptFor(
      slide(3, { headline: "Prompt injection does not look like an attack", body: "It looks like a blog post." }),
    );
    expect(prompt).toContain("Prompt injection does not look like an attack");
    expect(prompt).toContain("It looks like a blog post.");
    // And NOT the opted-out scene, which is what `generationPromptFor` would
    // have handed the model: "no photograph adds to a typed checklist".
    expect(prompt).not.toContain("typed checklist");
  });

  it("carries the exclusions in the prompt rather than in a gate downstream", () => {
    // A gate can only throw the frame away AFTER it is paid for, which is the
    // waste the floor was fixed to stop in the first place.
    expect(conceptualPromptFor(slide(2))).toContain(ALWAYS_EXCLUDED);
  });

  it("puts the run's frozen treatment in, so a made frame sits in the same world as a sourced one", () => {
    expect(conceptualPromptFor(slide(2), { treatment: "warm-desaturate" })).toContain("warm-desaturate");
    // …and says nothing about a treatment when the run froze none.
    expect(conceptualPromptFor(slide(2))).not.toContain("Treatment:");
  });
});

describe("planImageBackfill", () => {
  it("reaches the slides that put the post under the floor — the ones that never asked", () => {
    const plan = planImageBackfill(geektimeShaped(), new Set([1, 6]), 2);
    expect(plan).toHaveLength(2);
    // Never a slide that already has one.
    expect(plan.map((p) => p.n)).not.toContain(1);
    expect(plan.map((p) => p.n)).not.toContain(6);
  });

  it("puts the picture INSIDE the plate before it puts one behind it", () => {
    // The owner's ruling of 2026-09-18. Both carousels that day carried their
    // pictures only as full-bleed grounds, so the register he asked for was
    // absent from the set rather than merely rare in it.
    //
    // Slide 3 is `headline_focus` — no image slot at all, so it is skipped.
    // Slide 5 (`stat_callout`), 2, 4 (`list_takeaway`) and 7 (`quote_card`)
    // carry a bounded band; nothing here is full-bleed except a cover or a
    // photo, and both already have pictures.
    const plan = planImageBackfill(geektimeShaped(), new Set([1, 6]), 4);
    expect(plan.map((p) => p.n)).not.toContain(3);
    expect(plan.map((p) => p.n).sort((a, b) => a - b)).toEqual([2, 4, 5, 7]);
  });

  it("prefers a slide whose scene DID describe a picture, and uses the writer's own words for it", () => {
    const copy = geektimeShaped();
    copy.slides[4] = slide(5, {
      layout: "stat_callout",
      visualNeed: { scene: "a presenter on a conference stage, screen behind them", why: "x", source: "none" },
    });
    const plan = planImageBackfill(copy, new Set([1, 6]), 1);
    expect(plan[0]!.n).toBe(5);
    expect(plan[0]!.prompt).toBe("a presenter on a conference stage, screen behind them");
    expect(plan[0]!.reason).toContain("the writer's own words");
  });

  it("fills a pictureless COVER first, before any interior plate, because the cover is the grid thumbnail (2026-09-24)", () => {
    const copy = geektimeShaped();
    copy.slides[0] = slide(1, { layout: "cover", visualNeed: { scene: "why the numbers matter more than the headline", why: "x", source: "none" } });
    const plan = planImageBackfill(copy, new Set([6]), 1);
    expect(plan.map((p) => p.n)).toEqual([1]);
    // Everything after it keeps the bounded-first order.
    expect(planImageBackfill(copy, new Set([6]), 5).map((p) => p.n)).toEqual([1, 2, 4, 5, 7]);
  });

  it("fills a numbered list's item plates only in the list series (2026-09-24)", () => {
    const copy = geektimeShaped();
    expect(planImageBackfill(copy, new Set([1, 6]), 9).map((p) => p.n)).not.toContain(3);
    expect(planImageBackfill(copy, new Set([1, 6]), 9, { itemPictures: true }).map((p) => p.n)).toContain(3);
  });

  it("never touches the closer, because a picture behind the ask competes with the ask", () => {
    expect(planImageBackfill(geektimeShaped(), new Set(), 99).map((p) => p.n)).not.toContain(8);
  });

  it("never touches a slide that already asked for a picture — that path is the run's to retry, not this one's", () => {
    // Slide 6 asked and (in this fixture) got nothing. It is NOT backfilled:
    // the floor retries it through `fromFailed`, which reuses the writer's
    // real scene brief rather than a derived one.
    expect(planImageBackfill(geektimeShaped(), new Set([1]), 99).map((p) => p.n)).not.toContain(6);
  });

  it("asks for nothing when the floor is already met", () => {
    expect(planImageBackfill(geektimeShaped(), new Set([1, 2, 6]), 0)).toEqual([]);
    expect(planImageBackfill(geektimeShaped(), new Set([1, 2, 6]), -1)).toEqual([]);
  });

  it("returns fewer than asked rather than inventing slides, when the post has none left to give", () => {
    const shortCopy = { slides: [geektimeShaped().slides[0]!, geektimeShaped().slides[7]!] } as unknown as InstagramCopyOutput;
    expect(planImageBackfill(shortCopy, new Set([1]), 3)).toEqual([]);
  });
});

describe("resolveRescuedSelection", () => {
  const filled: { imagePath: string | null } = { imagePath: ".media-cache/x.png" };
  const refused: { imagePath: string | null } = { imagePath: null };
  /** The real helper's shape: it ABSTAINS on a slide that never asked for a picture. */
  const isUnfillable = (s: { imagePath: string | null }) => s.imagePath === null;
  const abstains = () => false;

  it("keeps the placeholder when the rescue produced no verdict at all", () => {
    expect(resolveRescuedSelection({ placeholder: refused, vetted: undefined, wasBackfilled: true, isUnfillable })).toBe(refused);
  });

  it("takes a BACKFILLED frame the vet approved — the run has already paid for it", () => {
    // The waste this whole area was fixed to stop: generated, vetted,
    // approved, then dropped because the fillability helper was scoped to a
    // different question. `abstains` is what `isUnfillable` actually does on
    // these slides, so a rule that leaned on it would look correct here.
    expect(resolveRescuedSelection({ placeholder: refused, vetted: filled, wasBackfilled: true, isUnfillable: abstains })).toBe(filled);
  });

  it("keeps the placeholder when a BACKFILLED frame was refused, rather than overwriting it with a null verdict", () => {
    // `isUnfillable` abstains here, so the pre-extraction rule would have
    // taken the refusal and replaced a good typographic placeholder with an
    // entry whose reason is about a picture the slide never asked for.
    expect(resolveRescuedSelection({ placeholder: refused, vetted: refused, wasBackfilled: true, isUnfillable: abstains })).toBe(refused);
  });

  it("leaves the ORDINARY rescue path exactly as it was, deciding on `isUnfillable`", () => {
    expect(resolveRescuedSelection({ placeholder: refused, vetted: filled, wasBackfilled: false, isUnfillable })).toBe(filled);
    expect(resolveRescuedSelection({ placeholder: refused, vetted: refused, wasBackfilled: false, isUnfillable })).toBe(refused);
    // …and on that path the helper is consulted, not bypassed: a verdict it
    // calls unfillable loses even when it carries a path.
    expect(resolveRescuedSelection({ placeholder: refused, vetted: filled, wasBackfilled: false, isUnfillable: () => true })).toBe(refused);
  });
});

/**
 * The owner's correction of 2026-09-18, after reading three carousels whose
 * generated frames were all abstract geometry: *"תמונות גנריות עם AI זה משעמם
 * לרוב שזה חזרתי"*. He is right about the cause. The first exclusion list
 * banned every real subject, so abstraction was the only thing left to draw.
 *
 * The line is not the subject. It is whether the frame could be read as a
 * record of something that happened.
 */
describe("exclusions, in two tiers", () => {
  it("keeps what no treatment makes acceptable", () => {
    for (const photoreal of [true, false]) {
      const rules = exclusionsFor(photoreal);
      expect(rules, String(photoreal)).toContain("No text");
      // A staged event is a fabricated record whatever style it is drawn in.
      expect(rules, String(photoreal)).toContain("Do not stage an event");
      expect(rules, String(photoreal)).toContain("Nothing mocking");
    }
  });

  it("lifts the person and brand ban the moment the frame is openly an illustration", () => {
    expect(exclusionsFor(true)).toContain("No identifiable real person");
    expect(exclusionsFor(false)).not.toContain("No identifiable real person");
  });

  it("refuses photorealism for a person, a company or a product, and allows it elsewhere", () => {
    expect(photorealAllowed([{ name: "Sam Altman", kind: "person", isPublicFigure: true }])).toBe(false);
    expect(photorealAllowed([{ name: "OpenAI", kind: "company" }])).toBe(false);
    expect(photorealAllowed([{ name: "Tel Aviv", kind: "place" }])).toBe(true);
    expect(photorealAllowed([])).toBe(true);
  });
});

describe("illustration registers", () => {
  it("is a list, because one house style repeated IS the repetition", () => {
    expect(ILLUSTRATION_REGISTERS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ILLUSTRATION_REGISTERS.map((r) => r.id)).size).toBe(ILLUSTRATION_REGISTERS.length);
    for (const r of ILLUSTRATION_REGISTERS) expect(r.phrase.length, r.id).toBeGreaterThan(30);
  });

  it("is stable inside one run and varies across runs", () => {
    expect(registerFor("run_a").id).toBe(registerFor("run_a").id);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => registerFor(`run_${i}`).id));
    expect(seen.size, "forty runs drew fewer than three distinct registers").toBeGreaterThan(2);
  });

  it("lets a NAMED REAL SUBJECT into the frame, drawn, which is the whole correction", () => {
    const prompt = conceptualPromptFor(slide(2, { headline: "The money behind the models", body: "Capital decides which models ship." }), {
      register: ILLUSTRATION_REGISTERS[0],
      subjects: [{ name: "Sam Altman", kind: "person", isPublicFigure: true }],
    });
    expect(prompt).toContain("Sam Altman");
    expect(prompt).toContain(ILLUSTRATION_REGISTERS[0]!.phrase);
    expect(prompt).toContain("never photographically");
    // …and the photoreal-only ban is lifted, because the register replaced it.
    expect(prompt).not.toContain("No identifiable real person");
  });

  it("will not put a named subject in a frame with no register to draw it in", () => {
    // Without a declared illustration there is nothing signalling commentary,
    // so the subject is dropped rather than rendered photorealistically.
    const prompt = conceptualPromptFor(slide(2), { subjects: [{ name: "Sam Altman", kind: "person" }] });
    expect(prompt).not.toContain("Sam Altman");
    expect(prompt).toContain("No identifiable real person");
  });
});

describe("literalIllustrationOf", () => {
  it("catches the three shapes that shipped on 2026-09-18", () => {
    expect(literalIllustrationOf("a gold pocket clock", "Two clocks run your marketing. Only one catches the buyer.")).toContain("clock");
    expect(literalIllustrationOf("a lit window in a wall", "Buyers open their window when they are ready. Not when you post.")).toContain("window");
    expect(literalIllustrationOf("a watch and a phone on a schedule board", "Most B2B funnels respond to buyer signals on a publishing schedule")).toBeDefined();
  });

  it("says nothing about a picture of the SITUATION rather than of a word", () => {
    expect(literalIllustrationOf("a founder alone at a kitchen table late at night", "Buyers open their window when they are ready")).toBeUndefined();
    expect(literalIllustrationOf("a crowded conference hall", "Two clocks run your marketing")).toBeUndefined();
  });

  it("ignores the words every headline has", () => {
    // Only stopwords overlap, so there is no echo to report.
    expect(literalIllustrationOf("a quiet workshop", "The most that your people can do when they are ready")).toBeUndefined();
  });
});
