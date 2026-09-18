import { describe, expect, it } from "vitest";
import { guaranteedGapCount, partitionGaps } from "../src/workflow/image-gap-partition.js";
import { enforceImageryBand, imageryShortfallsFor, type ImageryShortfall } from "../src/workflow/imagery-floor.js";
import { MIN_GENERATED_IMAGES_PER_RUN, planRunBudget, DEFAULT_RUN_SHAPE, EMPTY_RUN_BUDGET_HISTORY } from "../src/workflow/run-budget.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PHASE 5.5, BRIEF ITEMS A1 + A5 — "IMAGES ARE THE LAST THING CUT, NEVER THE
 * FIRST"
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ## The defect these tests are written against, in the runs' own numbers
 *
 * On 2026-09-16 the owner ran three prep posts and judged them as a CMO. The
 * loudest complaint was that the posts had no pictures in them. The cause was
 * two independent failures that happened to point the same way:
 *
 *  1. `planRunBudget`'s rung 1 was `generatedImagesCap 4 -> 2 -> 0`, so the
 *     ladder's FIRST act on an over-target estimate was to delete the
 *     pictures. `run-budget.test.ts` covers that half.
 *  2. Even with a cap, three gates in the workflow `continue` over the whole
 *     generate tier — the plan's `optionalRevets` flag, the live meter's
 *     posture, and the remaining-generation slice. **A cap the gates skip is
 *     not a floor**, and this file covers that half.
 *
 * ## WHAT THIS FILE CAN AND CANNOT SEE — read this before adding to it
 *
 * Everything here is a UNIT test of `partitionGaps`, `guaranteedGapCount` and
 * `imageryShortfallsFor`. It cannot observe the workflow. The simulation below
 * is a private re-implementation of the three gates, and it was written while
 * they were still unwired, with a comment that said the workflow "WILL run it
 * this way" — which stayed there after the wiring landed, so the file read as
 * though it were guarding the wiring. **It is not.** Reverting
 * `create-instagram-agent-workflow.ts`'s three `skipOptional(...)` calls to the
 * bare `continue` they replaced leaves every assertion in this file green, on
 * the owner's loudest complaint (*"אין תמונות למרות שאמרנו שיהיו"*).
 *
 * The guard that DOES observe the gates is
 * `run-budget-workflow.test.ts` → *"a plan that turned optional rescue work off
 * still generates the run's guaranteed images"*, which drives the real workflow
 * with a plan that pulled the optional rung and asserts `image.generate` was
 * asked for exactly `MIN_GENERATED_IMAGES_PER_RUN` needs. The simulation stays
 * here for one thing it is genuinely good at — proving the three gates are safe
 * to CHAIN, because the partition is idempotent — and is labelled as that.
 *
 * Each case is written to fail if `partitionGaps` ever returns everything as
 * optional (the pre-Phase-5.5 behaviour), and the premise of each is asserted
 * before the conclusion is.
 */

/** The workflow's own gap shape (`create-instagram-agent-workflow.ts`: `type ImageGap = { n: number; prompt: string }`). */
interface ImageGap {
  n: number;
  prompt: string;
}

const gap = (n: number): ImageGap => ({ n, prompt: `a picture for slide ${n}` });

describe("partitionGaps — the guarantee the three generation gates may not skip", () => {
  it("guarantees the floor, concept slide first, and makes everything past it optional", () => {
    // A tier with five gaps, the concept on slide 6 (so slide order alone
    // cannot produce the right answer and the test means something).
    const gaps = [gap(2), gap(3), gap(6), gap(7), gap(8)];
    const { guaranteed, optional } = partitionGaps(gaps, 0, { conceptSlide: 6 });
    // Five gaps against the floor, so the partition has something to split.
    expect(gaps.length).toBeGreaterThan(MIN_GENERATED_IMAGES_PER_RUN);

    expect(guaranteed).toHaveLength(MIN_GENERATED_IMAGES_PER_RUN);
    // THE CONCEPT FIRST. It is the one picture retrieval can never recover:
    // every other gap can still be answered by a photograph and a drawn
    // metaphor cannot.
    expect(guaranteed[0]!.n).toBe(6);
    // Then slide order — an early picture earns the swipe.
    expect(guaranteed[1]!.n).toBe(2);
    // Derived from the floor rather than listed, because the floor moves: it
    // went 2 -> 3 on 2026-09-18 and this line was three separate hard-coded
    // arrays away from saying anything true.
    expect(optional.map((g) => g.n)).toEqual([2, 3, 6, 7, 8].filter((n) => !guaranteed.some((g) => g.n === n)));
    expect(optional).toHaveLength(5 - MIN_GENERATED_IMAGES_PER_RUN);
    // Nothing is lost: a caller that records `rescueSkipped` for `optional` and
    // generates `guaranteed` has accounted for every gap it was handed.
    expect([...guaranteed, ...optional].map((g) => g.n).sort((a, b) => a - b)).toEqual([2, 3, 6, 7, 8]);
    // The prompts ride along untouched — the partition orders gaps, it does not
    // author them.
    expect(guaranteed[0]!.prompt).toBe("a picture for slide 6");
  });

  it("orders by slide number when the tier carries no concept, and never guarantees more than it was given", () => {
    expect(partitionGaps([gap(7), gap(3), gap(5)], 0).guaranteed.map((g) => g.n)).toEqual(
      [3, 5, 7].slice(0, MIN_GENERATED_IMAGES_PER_RUN),
    );
    // One gap against the floor: the guarantee is what exists, not a promise
    // the tier cannot keep.
    const one = partitionGaps([gap(4)], 0);
    expect(one.guaranteed.map((g) => g.n)).toEqual([4]);
    expect(one.optional).toEqual([]);
    expect(partitionGaps([], 0).guaranteed).toEqual([]);
  });

  it("counts the guarantee per RUN, so a run that already made its images owes nothing further", () => {
    // The floor is a floor on the POST, not a multiplier on the attempts. Three
    // attempts x two guaranteed images would be six guaranteed generations
    // ($0.234) on a run whose plan was already in trouble.
    expect(guaranteedGapCount(0)).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    expect(guaranteedGapCount(1)).toBe(MIN_GENERATED_IMAGES_PER_RUN - 1);
    expect(guaranteedGapCount(MIN_GENERATED_IMAGES_PER_RUN)).toBe(0);
    expect(guaranteedGapCount(99)).toBe(0);
    const spent = partitionGaps([gap(2), gap(3)], MIN_GENERATED_IMAGES_PER_RUN);
    expect(spent.guaranteed).toEqual([]);
    expect(spent.optional).toHaveLength(2);
    // Garbage reads as ZERO generated, which is the direction that keeps the
    // pictures: a NaN must never be allowed to satisfy the floor.
    expect(guaranteedGapCount(Number.NaN)).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    expect(guaranteedGapCount(-4)).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    expect(guaranteedGapCount(1.9)).toBe(MIN_GENERATED_IMAGES_PER_RUN - 1);
  });

  /**
   * ── CHAINING, NOT WIRING. ──
   *
   * The workflow closes up to three gates in a row on one tier, and each one
   * re-partitions what the previous one left. That is only safe if the
   * partition is IDEMPOTENT — if the second call found something optional
   * inside the first call's guarantee, the pictures would drain one gate at a
   * time. This case proves it is, on a two-deep chain, with a control that
   * proves the harness can fail.
   *
   * It does NOT prove the workflow calls the partition at all; see this file's
   * header for what does. `runGate` is a local model of the gates' SHAPE, not a
   * view of them.
   *
   * `rescueSkipped` is the workflow's own `Map<number, string>`: a slide in it
   * ships heroless with the budget named as the reason. Before this phase every
   * gap went into that map on a run whose plan had pulled a rung; the whole of
   * item A1 is that the guaranteed ones no longer can.
   */
  it("partitioning twice in a row is idempotent, so chained gates skip the OPTIONAL gaps only", () => {
    const gaps = [gap(1), gap(4), gap(5), gap(6)];

    /** A LOCAL MODEL of the two optional-spend gates' shape. It reads no workflow code and observes none. */
    const runGate = (
      partition: (g: readonly ImageGap[]) => { guaranteed: ImageGap[]; optional: ImageGap[] },
      posture: "normal" | "essential-only" | "cheapest-path",
      optionalRevets: boolean,
    ) => {
      const rescueSkipped = new Map<number, string>();
      let toGenerate = gaps;
      if (!optionalRevets) {
        const { guaranteed, optional } = partition(toGenerate);
        for (const g of optional) rescueSkipped.set(g.n, "optional rescue re-vets skipped by the run budget plan");
        toGenerate = guaranteed;
      }
      if (posture !== "normal") {
        const { guaranteed, optional } = partition(toGenerate);
        for (const g of optional) rescueSkipped.set(g.n, "run budget target crossed — no more generated images");
        toGenerate = guaranteed;
      }
      return { generated: toGenerate.map((g) => g.n), skipped: [...rescueSkipped.keys()].sort((a, b) => a - b) };
    };

    const real = (g: readonly ImageGap[]) => partitionGaps(g, 0, { conceptSlide: 5 });

    // Both gates closed at once — the exact state of every prep run on
    // 2026-09-16 — and the concept plus one more picture still get made.
    const both = runGate(real, "essential-only", false);
    // Concept first, then slide order, cut at the floor — derived, because the
    // floor moved 2 -> 3 on 2026-09-18 and a literal here would have gone red
    // saying nothing about idempotence, which is this test's actual subject.
    expect(both.generated).toEqual([5, 1, 4, 6].slice(0, MIN_GENERATED_IMAGES_PER_RUN));
    expect(both.generated).toHaveLength(MIN_GENERATED_IMAGES_PER_RUN);
    expect(both.skipped).toEqual([1, 4, 5, 6].filter((n) => !both.generated.includes(n)));
    // …and the split is a real one, or the idempotence below is vacuous.
    expect(both.skipped.length).toBeGreaterThan(0);
    // The second gate is a NO-OP on what the first one left: it re-partitions
    // the guarantee and finds nothing optional in it. That idempotence is what
    // makes three gates safe to wire to one helper.
    expect(runGate(real, "cheapest-path", false).generated).toEqual(both.generated);
    // A run in normal posture with the full plan generates everything.
    expect(runGate(real, "normal", true).generated).toEqual([1, 4, 5, 6]);

    // ── THE CONTROL. Break the partition — return everything as optional, the
    // ── pre-Phase-5.5 behaviour — and the simulation must produce the defect.
    // ── Without this line the three assertions above would also pass against a
    // ── `partitionGaps` that did nothing at all.
    const broken = (g: readonly ImageGap[]) => ({ guaranteed: [] as ImageGap[], optional: [...g] });
    const brokenRun = runGate(broken, "essential-only", false);
    expect(brokenRun.generated).toEqual([]);
    expect(brokenRun.skipped).toEqual([1, 4, 5, 6]);
    expect(brokenRun.generated.length).toBeLessThan(both.generated.length);
  });

  it("the plan's cap and the partition's floor agree: no planned run can ask for fewer than the floor", () => {
    // The two halves of item A1, checked against each other. The plan can no
    // longer cap below the floor (`run-budget.test.ts` sweeps that), and the
    // partition guarantees the floor whatever the plan says — so the binding
    // number is the same one in both places, by construction rather than by
    // coincidence.
    const saturated = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true, photoSlides: 8 }, {
      ...EMPTY_RUN_BUDGET_HISTORY,
      ewmaRatio: 3,
      runs: [],
    });
    expect(saturated.plan.generatedImagesCap).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    const gaps = [gap(2), gap(3), gap(4)];
    expect(partitionGaps(gaps, 0).guaranteed.length).toBeLessThanOrEqual(saturated.plan.generatedImagesCap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item A5 — a slide that lost its photograph
// ─────────────────────────────────────────────────────────────────────────────

/** Eight slides, five of them structured archetypes, three plain text plates — the karoslabs shape of 2026-09-16. */
function eightSlideDraft(): InstagramCopyOutput {
  const slides = Array.from({ length: 8 }, (_, i) => ({
    n: i + 1,
    headline: `headline ${i + 1}`,
    body: `body ${i + 1}`,
    layout: (i === 0 ? "cover" : i < 4 ? "stat_callout" : "text_only") as InstagramCopyOutput["slides"][number]["layout"],
  }));
  return { caption: "caption", slides } as unknown as InstagramCopyOutput;
}

describe("imageryShortfallsFor — the loss stops being silent (item A5)", () => {
  it("a band-promoted slide that loses its picture reports a real remedy, not 'none'", () => {
    // The band promotes text plates to `photo` when a carousel is under the
    // picture floor — `enforceImageryBand`'s own job — and a promotion is a
    // REQUEST for a picture, never a promise of one. When sourcing then finds
    // nothing, today the slide silently reverts to a bare type plate and clause
    // E's `downgradedForImages` waiver hides it in `waived`. That is the
    // owner's *"some of the slides are empty"*, and this is the record that
    // ends it.
    const band = enforceImageryBand(eightSlideDraft());
    expect(band.promotions.map((p) => p.slide)).toEqual([5, 6]);
    expect(band.after).toBe(3);

    const shortfalls = imageryShortfallsFor(
      [{ slide: 5, wanted: "stock", got: "text_only", why: "no candidate cleared the vet (subjectMatch 2)" }],
      { promotedSlides: band.promotions.map((p) => p.slide), mergeable: [2, 3, 4, 5, 6, 7] },
    );
    expect(shortfalls).toHaveLength(1);
    const only = shortfalls[0]!;
    expect(only.promotedByBand).toBe(true);
    expect(only.remedy).not.toBe("none");
    expect(only.remedy).toBe("merge");
    expect(only.why).toContain("no candidate cleared the vet");
    expect(only.wanted).toBe("stock");
    expect(only.got).toBe("text_only");
  });

  /**
   * ── `merge` IS NO LONGER A PRIVILEGE OF THE BAND'S OWN PROMOTIONS. ──
   *
   * It was, and the consequence was the plate the owner named: a plain photo
   * slide that sourced nothing and carries no figure of its own fell all the
   * way to `font-scale` — *set the same two strings larger* — while clause H is
   * simultaneously waived for exactly those slides, so nothing objected either.
   * Rendered with sourcing returning nothing, karoslabs slides 3 and 6 measured
   * `occupiedShare` 0.023/0.024 with 46% of the plate one empty rectangle.
   *
   * Which slides a neighbour can absorb is the CALLER's fact (the same four
   * preconditions `mergeRemedy` applies), so the two halves are asserted
   * separately: told nothing, nobody merges; told the carousel's shape, the
   * plate with nothing on it does.
   */
  it("offers `merge` to any shortfall slide a neighbour can absorb, not only to a band promotion", () => {
    const rows = [{ slide: 6, wanted: "stock" as const, got: "text_only" as const, why: "no candidate cleared the vet" }];
    // The caller that cannot apply a merge is told so, and gets the rung that
    // does not need one. A remedy the planner would refuse reads like a fix in
    // the trace and moves nothing.
    expect(imageryShortfallsFor(rows)[0]!.remedy).toBe("font-scale");
    // Slide 6 was never band-promoted here, and it still merges.
    const merged = imageryShortfallsFor(rows, { mergeable: [2, 3, 4, 5, 6, 7] })[0]!;
    expect(merged.remedy).toBe("merge");
    expect(merged.promotedByBand).toBe(false);
    // A slide the caller did NOT list — the cover, the closer, a post already
    // at `slides_min` — still cannot be merged away.
    expect(imageryShortfallsFor([{ slide: 1, wanted: "stock", got: "text_only", why: "provider 503" }], { mergeable: [2, 3] })[0]!.remedy).toBe("font-scale");
  });

  it("plans at most ONE merge per attempt, because the workflow renumbers from a single table", () => {
    // Two merges planned against the same pre-merge numbering cannot both be
    // applied: `create-instagram-agent-workflow.ts`'s apply case builds one
    // `renumber` map out of the surviving order, and the second change's
    // `slide`/`into` would no longer mean what the planner meant.
    const out = imageryShortfallsFor(
      [
        { slide: 3, wanted: "stock", got: "text_only", why: "provider 503" },
        { slide: 5, wanted: "stock", got: "text_only", why: "provider 503" },
        { slide: 6, wanted: "stock", got: "text_only", why: "provider 503" },
      ],
      { mergeable: [2, 3, 4, 5, 6, 7] },
    );
    expect(out.filter((s) => s.remedy === "merge")).toHaveLength(1);
    // And it is the EARLIEST one, for the same reason the spare lands on the
    // earliest plate.
    expect(out.find((s) => s.remedy === "merge")!.slide).toBe(3);
    expect(out.filter((s) => s.remedy === "font-scale").map((s) => s.slide)).toEqual([5, 6]);
  });

  it("walks the remedy ladder in `interest-relayout.ts`'s order and never invents a second use for one spare image", () => {
    const shortfalls = imageryShortfallsFor(
      [
        { slide: 6, wanted: "generate", got: "none", why: "generation budget for this run spent" },
        { slide: 2, wanted: "stock", got: "text_only", why: "provider 503" },
        { slide: 4, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasOwnFigure: true },
      ],
      { promotedSlides: [6], spareVettedImages: 1, mergeable: [2, 3, 4, 5, 6, 7] },
    );
    // Slide order, so the one spare lands on the earliest plate — the same
    // argument the band makes when it promotes lowest-first.
    expect(shortfalls.map((s) => s.slide)).toEqual([2, 4, 6]);
    const remedies = Object.fromEntries(shortfalls.map((s) => [s.slide, s.remedy]));
    // Slide 4 keeps `attach-device` ahead of the merge rung: it has its own
    // figure with a complete label, so there is something to PUT on the plate,
    // and merging is what is left when there is not.
    expect(remedies).toEqual({ 2: "promote", 4: "attach-device", 6: "merge" });
    // The spare was CONSUMED: two slides must not both be told to use the one
    // unplaced image, because the relayout has no way to tell which of them was
    // meant to get it.
    expect(shortfalls.filter((s) => s.remedy === "promote")).toHaveLength(1);
  });

  it("a slide that asked for no picture has not lost one, and a plate with a designed object needs no remedy", () => {
    // `source: "none"` is the writer opting out of imagery, and
    // `NO_IMAGE_MEANS_DEVICE_RULE` already governs it. Reporting it here would
    // turn every deliberate quiet plate into a defect, which is how a gate
    // stops being able to see the failure it exists for.
    expect(imageryShortfallsFor([{ slide: 3, wanted: "none", got: "text_only", why: "the brief asked for no picture" }])).toEqual([]);
    // `none` is for the plate that survives the loss intact: a designed object
    // is not an empty slide, so there is nothing for the relayout to fix.
    const [designed] = imageryShortfallsFor([
      { slide: 3, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasDesignedObject: true },
    ]) as [ImageryShortfall];
    expect(designed.remedy).toBe("none");
    // But a spare image still beats a designed object: the slide asked for a
    // photograph and one is sitting unplaced.
    const [withSpare] = imageryShortfallsFor(
      [{ slide: 3, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasDesignedObject: true }],
      { spareVettedImages: 1 },
    ) as [ImageryShortfall];
    expect(withSpare.remedy).toBe("promote");
  });

  it("reads a garbage spare count as no spare rather than throwing, and gates nothing either way", () => {
    // This record is EMITTED and gates nothing — losing a picture is never a
    // hold. So every path through it has to return a record rather than throw:
    // a shortfall builder that can fail is a new way for a run to die over
    // furniture.
    for (const spareVettedImages of [Number.NaN, -3, 2.7, Number.POSITIVE_INFINITY]) {
      const out = imageryShortfallsFor([{ slide: 2, wanted: "stock", got: "none", why: "provider 503" }], { spareVettedImages });
      expect(out).toHaveLength(1);
      expect(["promote", "font-scale"]).toContain(out[0]!.remedy);
    }
    expect(imageryShortfallsFor([])).toEqual([]);
  });
});
