import { describe, expect, it } from "vitest";
import {
  conceptualPromptFor,
  GENERATION_EXCLUSIONS,
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

  it("carries the standing likeness and brand exclusions, in the prompt rather than in a gate downstream", () => {
    // A gate can only throw the frame away AFTER it is paid for, which is the
    // waste the floor was fixed to stop in the first place.
    const prompt = conceptualPromptFor(slide(2));
    for (const forbidden of ["No people", "No logos", "No text"]) expect(prompt).toContain(forbidden);
    expect(prompt).toContain(GENERATION_EXCLUSIONS);
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
  const filled = { imagePath: ".media-cache/x.png" };
  const refused = { imagePath: null };
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
