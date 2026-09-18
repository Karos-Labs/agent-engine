import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodCopyOutput,
  goodImageCandidatePool,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";
import { buildGateVerdict, gateVerdictLine, draftDigestFor } from "../src/workflow/gate-verdict.js";
import { accentSlidesFor, interiorSlides, visualSystemCssBlock, type CarouselVisualSystem } from "../src/workflow/visual-system.js";
import { checkSlidesInterestFloor } from "../src/workflow/interest-floor.js";

/**
 * ══ WAVE-2 INTEGRATION: the wiring, asserted where it actually lands ══
 *
 * Each package in this wave was written and tested on its own, and every one
 * of them shipped a module that does the right thing when it is CALLED. What
 * no package could test is whether the workflow calls it — and the phase this
 * is part of exists because three prep posts shipped with a whole design
 * system resolved, recorded and visible in no pixel.
 *
 * So these cases are deliberately about the JOIN. They run the real workflow
 * against the canonical happy fixture and read the trace and the gate payload,
 * which is the one place a reviewer sees any of it.
 */

const params = { runId: "wave2_integration", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("wave-2 integration: the steps are registered and the gate carries the verdict", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("registers 04b3, 04p and 06g, and puts the verdict FIRST on the gate payload", async () => {
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router: fakeRouterSequence(happyTurns()),
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // The three steps this wave registers. `04b3` is the only new MODEL step;
    // the other two are `wf.step.code` at $0.
    expect(ids, "04b3-extract-entities is what makes a post about ChatGPT able to show ChatGPT").toContain("04b3-extract-entities");
    expect(ids, "04p-resolve-visual-system is the whole of item C — the accent switch and the pagination set").toContain("04p-resolve-visual-system");
    expect(ids, "06g-grade-picture-set is item A4's one graded set").toContain("06g-grade-picture-set-attempt-1");

    // ── THE VERDICT IS ON THE PAYLOAD, AND IT IS FIRST. ──
    //
    // The human gate approved all three 2026-09-16 runs, including one whose
    // cover device read `"2 / B B"` and one that shipped with no hashtags,
    // because nothing on the payload said a model step had failed, which
    // attempt had shipped, or what the run cost. Key order is what a JSON
    // viewer renders, so "first" is part of the fix rather than a nicety.
    const gate = await durableStore.getGate(first.pendingGateId);
    const payload = gate?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(Object.keys(payload!)[0]).toBe("verdictLine");
    expect(Object.keys(payload!)[1]).toBe("verdict");
    expect(typeof payload!["verdictLine"]).toBe("string");
    const verdict = payload!["verdict"] as { spend: { meteredUsd: number; billedUsd: number }; draftProvenance: { shippedAttempt: number }; visualQa: unknown };
    // The owner asked for the number, in as many words. It is on the block AND
    // in the one-line summary, so a reviewer who reads nothing else reads it.
    expect(verdict.spend.meteredUsd).toBeGreaterThan(0);
    expect(verdict.spend.billedUsd).toBeGreaterThanOrEqual(0);
    expect(String(payload!["verdictLine"])).toMatch(/\$/u);
    expect(verdict.draftProvenance.shippedAttempt).toBeGreaterThan(0);
    // ABSENT means NOT JUDGED and the block says so — a pass is never faked.
    expect(verdict.visualQa).toBeDefined();
  }, 180_000);

  /**
   * ── THE WAIVED PLATE REACHES THE ONE LINE A REVIEWER READS. ──
   *
   * A slide that asked for a photograph and lost it is waived from the weighted
   * content floor, and correctly: a hero is worth 2.0 and NO REDRAFT CAN FIND A
   * PICTURE, so refusing it would be a hold generator wearing a gate's clothes.
   * But the waiver was also SILENT — the finding sat in `interest.waived`, forty
   * blocks down a payload nobody scrolls, while the plate shipped as a headline
   * and a body on bare ground. Rendered on this tree with sourcing returning
   * nothing, those plates measure 2.3% occupied with 46% of the frame one empty
   * rectangle; that is the owner's *"חלק מהשקפים ריקים"*, reached by the one
   * path where nothing is allowed to object.
   *
   * The waiver stands. What this pins is that the human approving the post is
   * told, in the verdict line, before he approves.
   */
  it("a slide that lost its photograph ships as a DEGRADE MARKER on the verdict, not only inside `waived`", async () => {
    const copy = goodCopyOutput();
    // Every slide loses its picture: the run has no `image.generate` registered
    // here, so there is no rescue tier and `07a` downgrades all of them.
    const vetFindsNothing = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: null,
        reason: "no candidate cleared the vet (subjectMatch 2)",
        license: "n/a",
        rightsUsable: false,
        watermarkFree: false,
        claimMatch: 1,
        claimMatchReason: "nothing in the pool shows the claim",
      })),
    };
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router: fakeRouterSequence(happyTurns({ vet: vetFindsNothing })),
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const durableStore = new MemoryDurableStepStore();
    const runId = "wave2_degrade_markers";
    const first = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId });
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");

    // THE PREMISE: the slides really did lose their pictures and really were
    // waived, or this case would be asserting on an empty list.
    const steps = await durableStore.listSteps(runId);
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as { downgraded: number[] } | undefined;
    expect(downgrade?.downgraded.length, "no slide lost a picture, so there is nothing to report").toBeGreaterThan(0);

    const payload = (await durableStore.getGate(first.pendingGateId))?.payload as Record<string, unknown> | undefined;
    const interest = (payload!["interest"] ?? (payload!["render"] as Record<string, unknown> | undefined)?.["interest"]) as { waived?: Array<{ kind: string; slide: number }> } | undefined;
    const waivedWeight = (interest?.waived ?? []).filter((f) => f.kind === "one-element");
    expect(waivedWeight.length, "clause H waived nothing, so the marker under test has no source").toBeGreaterThan(0);

    // THE CLAIM.
    const verdict = payload!["verdict"] as { degradeMarkers: Array<{ slide: number; from: string; to: string; reason: string }> };
    expect(verdict.degradeMarkers.map((m) => m.slide).sort((a, b) => a - b)).toEqual(waivedWeight.map((f) => f.slide).sort((a, b) => a - b));
    for (const marker of verdict.degradeMarkers) {
      expect(marker.to).toBe("bare type plate");
      // The reason says what it weighed and why nobody refused it — the two
      // facts a reviewer needs to decide whether to approve.
      expect(marker.reason).toMatch(/against a floor of/u);
      expect(marker.reason).toMatch(/lost its photograph/u);
    }
    // And it reaches the ONE LINE, which is the whole point of the block.
    expect(String(payload!["verdictLine"])).toMatch(/slides? DEGRADED/u);
  }, 180_000);
});

describe("the gate verdict is built from facts the run already has", () => {
  /**
   * The builder is pure, so this case is about the SHAPE the workflow hands
   * it — the thing that broke silently when `08b`'s verdict was consumed
   * locally and never put on `DraftResult`.
   */
  it("says WHICH attempt shipped, and counts a re-judged identical draft as no redraft", () => {
    const digest = draftDigestFor("a caption", [{ headline: "h", body: "b" }]);
    const verdict = buildGateVerdict({
      budget: { actualUsd: 1.23, targetUsd: 1, maxUsd: 1.5, adaptations: [], lines: [] },
      shippedAttempt: 1,
      // deel's 2026-09-16 run, in three rows: attempt 1 drafted, attempts 2 and
      // 3 died at the output ceiling for $0, and the run re-judged attempt 1's
      // draft and failed the identical gate on the identical words.
      attempts: [
        { attempt: 1, producedDraft: true, usdBurned: 0.31, draftDigest: digest },
        { attempt: 2, producedDraft: false, status: "content_fail", reason: "hit the 16384-token output limit", usdBurned: 0 },
        { attempt: 3, producedDraft: false, status: "content_fail", reason: "hit the 16384-token output limit", usdBurned: 0 },
      ],
      imagery: { wanted: 4, generated: 0, selections: [] },
      brandAsset: { present: false, reason: "this client's brand kit carries no logoUrl" },
    });
    expect(verdict.draftProvenance.shippedAttempt).toBe(1);
    expect(verdict.stepFailures.length, "two dead redrafts are two step failures, not silence").toBeGreaterThanOrEqual(2);
    // The summary is the sentence a reviewer reads before the pixels.
    expect(gateVerdictLine(verdict)).toContain("$");
  });
});

/**
 * ── THE SHEET IS RESOLVED FOR THE DRAFT THAT SHIPS, NOT FOR EIGHT. ──
 *
 * `04p-resolve-visual-system` runs before a draft exists, so it resolves on
 * `SERIES_DIRECTIVE_SLIDES` (8). That value used to be the ONLY one
 * `headExtras()` ever saw, while `assembleSlidesData` was handed
 * `systemFor(copy.slides.length)` — so on any 6- or 7-slide carousel the
 * stylesheet and the composition disagreed about which slide is which.
 *
 * Executed against the real module before the fix, on a 6-slide post: the sheet
 * shipped `body[data-n="01"],[data-n="04"],[data-n="08"]` for the accent and
 * `[data-n="02"]..[data-n="07"]` for the index, against the correct `[1,3,6]`
 * and `[2,3,4,5]`. That is no accent on the closer, a page index ON the closer,
 * and — with `accentForm: "field"`, whose `accentSlidesFor(6)` is `[6]` against
 * the shipped `[8]` — no accent anywhere on the post at all.
 *
 * The copy prompt asks for "six to eight slides" and this phase's own
 * `merge-into-neighbour` remedy deliberately shortens a carousel by one, so the
 * mismatch is manufactured rather than hypothetical. The workflow now assigns
 * `runVisualSystem = systemFor(bounded.copy.slides.length)` inside the assembly
 * it renders from; these cases pin the property that assignment exists for.
 */
describe("the emitted sheet names the slides the carousel actually has", () => {
  const systemFor = (slideCount: number, accentForm: CarouselVisualSystem["accentForm"]): CarouselVisualSystem => ({
    systemId: "test",
    compositionGrammar: "bottom-column",
    ground: "grid",
    accentSlides: accentSlidesFor(slideCount, accentForm),
    accentForm,
    numeralSlides: interiorSlides(slideCount),
    eyebrow: { kind: "none" },
    coverForm: "typographic-poster",
    typeScale: "display",
    gutter: "wide",
    reason: "test",
  });
  const selectorsIn = (css: string, token: string): number[] => {
    // The emitter puts each selector on its own line and the declarations
    // after the brace, so the unit to read is the RULE, not the line.
    const rule = css.split("}").find((block) => block.includes(token));
    return rule === undefined ? [] : [...rule.matchAll(/data-n="(\d\d)"/g)].map((m) => Number(m[1]));
  };

  for (const slideCount of [6, 7, 8]) {
    it(`emits the accent on accentSlidesFor(${slideCount}) and the index on interiorSlides(${slideCount})`, () => {
      const css = visualSystemCssBlock(systemFor(slideCount, "rule"));
      expect(selectorsIn(css, "--fx-accent: block"), `the accent switch named the wrong slides on a ${slideCount}-slide post`).toEqual(
        accentSlidesFor(slideCount, "rule"),
      );
      expect(selectorsIn(css, "--fx-pagination: block"), `the pagination switch named the wrong slides on a ${slideCount}-slide post`).toEqual(
        interiorSlides(slideCount),
      );
      // The closer is the slide the mismatch hit hardest: it lost its accent
      // and gained a page index, which is the one plate §4.5 gives neither.
      expect(selectorsIn(css, "--fx-accent: block")).toContain(slideCount);
      expect(selectorsIn(css, "--fx-pagination: block")).not.toContain(slideCount);
    });
  }

  it("a `field` accent on a six-slide post paints on slide 6, not on a slide that does not exist", () => {
    const css = visualSystemCssBlock(systemFor(6, "field"));
    expect(selectorsIn(css, "--fx-accent: block")).toEqual([6]);
  });
});

/**
 * ── CLAUSE I'S NUMBERS REACH CLAUSE I. ──
 *
 * `checkInterestFloor` reads the cover-subject boxes off `probe.subjectBoxes`
 * and the renderer returns them on `rendered[].geometry.subjectBoxes` — a
 * second in-page read, deliberately kept off `probe` so `renderCarousel` 1.6.0
 * stayed byte-identical to 1.5.1 on the fields a 1.5.1 caller reads. Nothing
 * joined the two, so the DOM test written for *"the first slide is empty and
 * boring"* abstained on every production render.
 *
 * This is the join, asserted on the shape the renderer actually returns.
 */
describe("the renderer's subject boxes reach the floor's cover clause", () => {
  const metrics = {
    inkShare: 0.2,
    occupiedShare: 0.4,
    contentOccupiedShare: 0.3,
    flatBackgroundShare: 0.5,
    textShare: 0.1,
    imageryOrDeviceShare: 0.3,
    largestEmptyRectShare: 0.1,
    largestEmptyRect: { x: 0, y: 0, w: 10, h: 10 },
    clippedEdgeShare: 0,
    accentShare: 0.01,
    edgeDensity: 0.05,
    quantisedColourCount: 12,
    markedShare: 0,
    markColourCount: 0,
    contentBBox: { x: 0, y: 0, w: 1080, h: 1440 },
    contentCentroid: { x: 540, y: 720 },
    groundInkContrast: 12,
  } as unknown as Parameters<typeof checkSlidesInterestFloor>[0][number]["metrics"];
  const probe = {
    overflow: false,
    overflowing: [],
    offscreen: [],
    elementCount: 12,
    textBoxShare: 0.1,
    fontFamiliesUsed: ["Inter"],
    displayTypeScale: 0.08,
    markRuns: 0,
    markRunsPainted: 0,
  } as unknown as Parameters<typeof checkSlidesInterestFloor>[0][number]["probe"];

  it("refuses a cover whose geometry says it carries no subject", () => {
    const report = checkSlidesInterestFloor(
      [{ n: 1, metrics, probe: { ...probe!, subjectBoxes: { hero: 0, device: 0, graphic: 0 } } }],
      { archetypeBySlide: new Map([[1, "cover"]]) },
    );
    expect(report.findings.map((f) => f.kind), "clause I did not see the boxes it was handed").toContain("cover-subject");
  });

  it("and abstains when the renderer reported none, which is every caller before 1.6.0", () => {
    const report = checkSlidesInterestFloor([{ n: 1, metrics, probe }], { archetypeBySlide: new Map([[1, "cover"]]) });
    expect(report.findings.map((f) => f.kind), "clause I refused a plate it had no boxes for").not.toContain("cover-subject");
  });
});
