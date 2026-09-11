import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolRegistry } from "@agent-engine/core";
import type { Slide } from "@agent-engine/tool-karos-publish";
import { MemoryDurableStepStore, WorkflowEngine, type DurableStepStore } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  boringSlideMetrics,
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  makePromptStore,
  passingSlideMetrics,
  qaTurnInputs,
  setupTestEnvironment,
  type FakeRenderCarouselOptions,
  type TestEnvironment,
} from "./test-helpers.js";
import type { SlideMetrics } from "../src/workflow/interest-floor.js";
import { happyTurns, standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { goodTrendScoutOutput, goodResearchOutput, goodImageVettingOutput, goodRelevanceVerdict, goodVisualQaOutput } from "./test-helpers.js";

/**
 * RFC-14 item L, at the workflow level: where the interest floor runs, what a
 * failure costs, and what it must never cost.
 *
 * The cost claim this file exists to prove is exact: `08a1-interest-floor`
 * runs immediately after the render and STRICTLY BEFORE `08a2`'s palette
 * gate, `08a4`'s vision inspection (~$0.008) and `08b`'s Flash judge
 * ($0.004), so a failing attempt spends a render and **zero model calls**.
 * Then the free re-layout (`08a1b`/`08a1c`/`08a1d`) gets a second $0 chance
 * before the $0.126 redraft is spent at all.
 *
 * ## Why this file is gated on the wiring
 *
 * WP-C2 owns the POLICY (`interest-floor.ts`, `interest-relayout.ts`,
 * pinned exhaustively by `interest-floor.test.ts`); the integrator owns the
 * five step ids in `create-instagram-agent-workflow.ts`. Until those land
 * there are no `08a1*` steps to assert on, so the assertions below are gated
 * on a source probe rather than left red or deleted — and the FIRST test in
 * this file asserts the probe's own premise (that it is reading the real
 * workflow source and can see step ids that certainly exist), so the gate
 * cannot silently be a guard that never opens.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_SOURCE = readFileSync(path.join(HERE, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
const INTEREST_FLOOR_WIRED = WORKFLOW_SOURCE.includes("08a1-interest-floor");

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** The exact ids the integrator wires, in the order they run. Asserted as a set, so a rename shows up here rather than in a silent skip. */
const INTEREST_STEP_IDS = {
  floor: "08a1-interest-floor-attempt-1",
  relayout: "08a1b-relayout-for-interest-attempt-1",
  reRender: "08a1c-render-relayout-attempt-1",
  recheck: "08a1d-interest-floor-recheck-attempt-1",
} as const;

function registry(env: TestEnvironment, opts: FakeRenderCarouselOptions): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!, opts) };
}

/**
 * Metrics that fail the floor on the FIRST render of a run and pass on every
 * later one — i.e. the free re-layout worked.
 *
 * Counts renders by counting how many times slide 1 has been measured: the
 * fake renderer walks `input.slides` in carousel order, so slide 1 is asked
 * exactly once per render call.
 */
function failsFirstRenderOnly(): (slide: Slide) => SlideMetrics {
  let renders = 0;
  return (slide: Slide) => {
    if (slide.n === 1) renders += 1;
    return renders === 1 && slide.n === 1 ? boringSlideMetrics() : passingSlideMetrics();
  };
}

/** The audit slide on slide 1 of every render, forever — nothing free can fix it. */
function alwaysFailsCover(): (slide: Slide) => SlideMetrics {
  return (slide: Slide) => (slide.n === 1 ? boringSlideMetrics() : passingSlideMetrics());
}

async function runToGate(env: TestEnvironment, runId: string, router: ReturnType<typeof fakeRouterSequence>, opts: FakeRenderCarouselOptions) {
  const durableStore: DurableStepStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const workflowFn = createInstagramAgentWorkflow({
    tools: registry(env, opts),
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
  });
  const result = await engine.run(workflowFn, { ...base, runId });
  const steps = await durableStore.listSteps(runId);
  return { result, engine, durableStore, workflowFn, steps, stepIds: steps.map((s) => s.stepId) };
}

async function runAutoApproved(env: TestEnvironment, runId: string, router: ReturnType<typeof fakeRouterSequence>, opts: FakeRenderCarouselOptions) {
  const durableStore: DurableStepStore = new MemoryDurableStepStore();
  const result = await new WorkflowEngine(durableStore).run(
    createInstagramAgentWorkflow({
      tools: registry(env, opts),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    }),
    { ...base, runId },
  );
  const steps = await durableStore.listSteps(runId);
  return { result, durableStore, steps, stepIds: steps.map((s) => s.stepId) };
}

describe("the wiring probe's own premise", () => {
  // Without this, a renamed step id (or a probe pointed at the wrong file)
  // would turn every assertion below into a permanent green skip.
  it("reads the real workflow source and can see step ids that certainly exist", () => {
    expect(WORKFLOW_SOURCE.length).toBeGreaterThan(10_000);
    expect(WORKFLOW_SOURCE).toContain("08-render-carousel-attempt-");
    expect(WORKFLOW_SOURCE).toContain("08a2-visual-qa-pre-checks-attempt-");
    expect(WORKFLOW_SOURCE).toContain("returnToCopyWith");
  });

  it("sees item L's own step id in the workflow, which is what the suite below exercises", () => {
    // Was a `skipIf` gate while WP-C2 and the integrator landed separately.
    // The wiring is in, so it is an assertion now: a renamed `08a1` fails
    // HERE, next to the ids it names, rather than turning the suite below
    // into a silent green skip.
    expect(INTEREST_FLOOR_WIRED).toBe(true);
  });
});

describe("08a1-interest-floor: where it runs and what it costs", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("runs the free re-layout and re-check, and spends ZERO extra copy turns when the re-layout fixes it", async () => {
    const router = fakeRouterSequence(happyTurns());
    const { result, steps, stepIds } = await runToGate(env, "interest_relayout_fixes_it", router, { metrics: failsFirstRenderOnly() });

    expect(result.status).toBe("awaiting_gate");
    for (const id of Object.values(INTEREST_STEP_IDS)) expect(stepIds).toContain(id);

    // The whole point of stage 1: one render, one re-render, no redraft.
    expect(copyTurnInputs(router)).toHaveLength(1);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    // The re-layout's own decision is on its step, so a reviewer can see
    // what code changed rather than only that something changed.
    const relayout = steps.find((s) => s.stepId === INTEREST_STEP_IDS.relayout)?.output as { changes?: Array<{ kind: string; slide: number }>; notes?: string[] } | undefined;
    expect(relayout?.changes?.length).toBeGreaterThan(0);
    expect(relayout?.changes?.every((c) => c.slide === 1)).toBe(true);
    expect(relayout?.notes?.length).toBe(relayout?.changes?.length);
  }, 40000);

  /**
   * A DROPPED DEVICE IS PART OF THE STEER.
   *
   * `collectDeviceIssues` knows that a device the writer set was never
   * painted — its archetype declares no slot, so `contentFor` dropped the
   * fragment — but it only ever reached the gate payload and the deliverable.
   * The writer of a slide that measured empty was therefore told "give this
   * slide a device" while it already had one, and had no way to learn why the
   * one it set did not count. It would set the same field again and measure
   * the same.
   */
  it("tells the redraft which devices this attempt set that did not render", async () => {
    const drafted = goodCopyOutput();
    // `list_takeaway` declares no device slot, so the fragment is dropped.
    const copy = {
      ...drafted,
      slides: drafted.slides.map((s) =>
        s.n === 3
          ? {
              ...s,
              layout: "list_takeaway" as const,
              items: [{ title: "Automate intake" }, { title: "Measure the queue" }],
              device: { kind: "figure" as const, value: "30%", label: "more tickets resolved", source: "support dashboard export" },
            }
          : s,
      ),
    };
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy, vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() }),
      ...happyTurns({ scout: undefined, research: undefined, angle: undefined, copy }),
    ]);
    // Slide 1 fails on the first render and its re-render, so the attempt is
    // escalated to a paid redraft — which is the path the steer travels.
    let renders = 0;
    const { result, stepIds } = await runToGate(env, "interest_device_drop_steer", router, {
      metrics: (slide: Slide) => {
        if (slide.n === 1) renders += 1;
        return renders <= 2 && slide.n === 1 ? boringSlideMetrics() : passingSlideMetrics();
      },
    });

    expect(result.status).toBe("awaiting_gate");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    const steer = String(copyTurnInputs(router)[1]?.["selfCheckSteer"] ?? "");
    // The measured numbers are still there...
    expect(steer).toContain("slide 1");
    // ...and so is the fact that slide 3's device never painted, named with
    // the archetype that dropped it.
    expect(steer).toContain("Devices this attempt set that did not render");
    expect(steer).toContain("slide 3 (figure)");
    expect(steer).toContain("no device slot");
  }, 60000);

  it("carries interestRelayout onto the gate payload", async () => {
    const router = fakeRouterSequence(happyTurns());
    const { durableStore } = await runToGate(env, "interest_relayout_on_gate", router, { metrics: failsFirstRenderOnly() });
    const gate = await durableStore.getGate("interest_relayout_on_gate__09a-batch-review-r0");
    const payload = gate?.payload as { interestRelayout?: { changes: Array<{ kind: string }>; notes: string[] }; interest?: { findings: unknown[] } };
    expect(payload.interestRelayout?.changes.length).toBeGreaterThan(0);
    expect(payload.interestRelayout?.notes.length).toBeGreaterThan(0);
  }, 40000);

  it("spends no model call on a failing attempt: 08a2, 08a4 and 08b are all downstream of 08a1", async () => {
    // Attempt 1's floor fails and stays failed; attempt 2's passes.
    let renders = 0;
    const metrics = (slide: Slide) => {
      if (slide.n === 1) renders += 1;
      // Renders 1 and 2 are attempt 1 (the render and the re-layout's
      // re-render); render 3 onward is attempt 2.
      return renders <= 2 && slide.n === 1 ? boringSlideMetrics() : passingSlideMetrics();
    };
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() }),
      // Attempt 2 only: copy, vet, relevance, and the ONE visual-QA turn.
      ...happyTurns({ scout: undefined, research: undefined, angle: undefined }),
    ]);
    const { result, stepIds } = await runToGate(env, "interest_zero_model_calls", router, { metrics });

    expect(result.status).toBe("awaiting_gate");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    // Attempt 1 never reached a single paid check.
    expect(stepIds).not.toContain("08a2-visual-qa-pre-checks-attempt-1");
    expect(stepIds).not.toContain("08a4-inspect-rendered-attempt-1");
    expect(stepIds).not.toContain("08b-visual-qa-attempt-1");
    // Exactly one visual-QA model turn was consumed: the passing attempt's.
    expect(qaTurnInputs(router)).toHaveLength(1);
  }, 40000);

  it("returns the draft to 05 with the measured numbers when nothing free fixes it", async () => {
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() }),
      ...happyTurns({ scout: undefined, research: undefined, angle: undefined }),
    ]);
    let renders = 0;
    const { result, stepIds } = await runToGate(env, "interest_returns_to_copy", router, {
      metrics: (slide: Slide) => {
        if (slide.n === 1) renders += 1;
        return renders <= 2 && slide.n === 1 ? boringSlideMetrics() : passingSlideMetrics();
      },
    });

    expect(result.status).toBe("awaiting_gate");
    expect(stepIds).toContain("05-write-copy-attempt-2");

    const inputs = copyTurnInputs(router);
    expect(inputs).toHaveLength(2);
    const steer = String(inputs[1]?.["selfCheckSteer"] ?? "");
    // The slide number, the measured share, and the word the owner used.
    expect(steer).toMatch(/slide 1\b/);
    expect(steer).toMatch(/93%/);
    expect(steer).toMatch(/flat|background colour/i);
    // A mechanism the writer controls, never an aesthetic.
    expect(steer).toMatch(/device|visualNeed|merge/);
  }, 40000);

  it("records one ledger warn per failed attempt, keyed so a retried attempt overwrites its own row", async () => {
    const router = fakeRouterSequence(happyTurns());
    await runAutoApproved(env, "interest_ledger_warn", router, { metrics: alwaysFailsCover() });
    const events = await env.store.listJson("acme", ["ledger", "events", "interest_ledger_warn"]);
    const warns = events.filter((e) => (e.data as { level: string }).level === "warn");
    const interestWarns = warns.filter((e) => String(e.id).includes("interest-floor-a"));
    expect(interestWarns.length).toBeGreaterThanOrEqual(1);
    expect(interestWarns[0]?.id).toBe("interest_ledger_warn__interest-floor-a1");
    expect(String((interestWarns[0]!.data as { message: string }).message)).toMatch(/slide 1/);
  }, 40000);
});

describe("08a1-interest-floor: it can never become a fourth hold", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("delivers `degraded` with the finding on the deliverable when the floor never clears", async () => {
    // Attempts 1 and 2 are refused at `08a1`, which sits BEFORE `08b` — so
    // they spend copy + vetting + relevance and NO visual-QA turn. Only
    // attempt 3, which degrades and ships, reaches the judge. Queuing a `qa`
    // turn per attempt would leave two unconsumed turns that the next
    // attempt's copy step would pull instead of its own draft.
    const attemptTurns = () =>
      standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() });
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal() }),
      ...attemptTurns(),
      ...attemptTurns(),
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result } = await runAutoApproved(env, "interest_degrades_and_ships", router, { metrics: alwaysFailsCover() });

    expect(result.status).toBe("completed");
    const record = await env.store.readJson<{ deliverable: { visualInterest?: { findings: Array<{ slide: number; kind: string }>; reason?: string } } }>(
      "acme",
      ["ledger", "deliverables", "interest_degrades_and_ships", "_", "instagram-carousel"],
    );
    expect(record?.deliverable.visualInterest?.findings.some((f) => f.slide === 1)).toBe(true);
  }, 60000);

  it("stops escalating past the hard max: over $1.50 it ships degraded on the cheapest path with no second attempt", async () => {
    // The same lever `run-budget-workflow.test.ts` uses: a copy turn
    // reporting 120k Sonnet output tokens is $1.80 measured, straight through
    // the $1.00 target and the $1.50 hard max at `05-write-copy-attempt-1`.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()),
      finalTurn(goodCopyOutput(), { outputTokens: 120_000 }),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      // No visual-QA turn: past the hard max the optional model QA is
      // skipped. A second copy turn would exhaust the router and fail here,
      // which is exactly the assertion.
    ]);
    const { result, stepIds } = await runAutoApproved(env, "interest_past_hard_max", router, { metrics: alwaysFailsCover() });

    expect(result.status).toBe("completed");
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(copyTurnInputs(router)).toHaveLength(1);
    const record = await env.store.readJson<{ deliverable: { visualInterest?: { findings: unknown[]; reason?: string } } }>(
      "acme",
      ["ledger", "deliverables", "interest_past_hard_max", "_", "instagram-carousel"],
    );
    expect(record?.deliverable.visualInterest?.findings.length).toBeGreaterThan(0);
  }, 60000);

  /**
   * THE RE-LAYOUT IS ALL-OR-NOTHING.
   *
   * `08a1b` mutates the copy, the image selections, the type-scale overrides
   * and the validated custom set, and `08a1c` re-renders them. If that render
   * does not succeed the workflow keeps the FIRST render and its findings, so
   * every one of those mutations has to be rolled back with it: on the final
   * attempt (or past the hard max) there is no `continue`, and `finalCopy` and
   * `finalRendered` ship together.
   *
   * The concrete defect: a `text-wall` finding at the smallest fontScale
   * yields `move-sentence-to-caption`, which strips a sentence from the slide
   * body and appends it to the caption. Committed before the render and kept
   * when the render failed, the post shipped with that sentence BOTH in the
   * caption and still burned into the slide's PNG.
   *
   * `content_fail` on the second render is the reachable version:
   * `promote-image-to-cover` attaches an image path that may not exist on this
   * instance's disk.
   */
  it("rolls the re-layout back when its re-render fails, so the shipped copy matches the shipped pixels", async () => {
    // Three rounds, like the degrade test above: attempts 1 and 2 are refused
    // at `08a1` (before `08b`, so no QA turn), and only the third reaches the
    // judge and ships.
    const attemptTurns = () => standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() });
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal() }),
      ...attemptTurns(),
      ...attemptTurns(),
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, steps } = await runAutoApproved(env, "interest_relayout_rolled_back", router, {
      // Slide 1 fails on every render, so the free re-layout always runs...
      metrics: alwaysFailsCover(),
      // ...and every re-render fails. Render calls alternate 08 / 08a1c, so
      // the even-numbered calls are the re-layout's.
      failRenderCall: (call) => (call % 2 === 0 ? { status: "content_fail", reason: "hero image not found on this instance" } : undefined),
    });

    // The run COMPLETES (item L is never a hold cause); the floor's own
    // degrade marker rides the output. What matters here is that what SHIPS
    // is internally consistent.
    expect(result.status).toBe("completed");

    // The premise: the re-layout DID plan changes, and they did touch the copy.
    const plan = steps.find((s) => s.stepId === INTEREST_STEP_IDS.relayout)?.output as { changes: Array<{ kind: string; slide: number }> } | undefined;
    expect(plan?.changes.length ?? 0).toBeGreaterThan(0);
    // ...and the re-render really did fail, so `08a1d` never ran.
    const reRender = steps.find((s) => s.stepId === INTEREST_STEP_IDS.reRender)?.output as { outcome: { status: string } } | undefined;
    expect(reRender?.outcome.status).toBe("content_fail");
    expect(steps.map((s) => s.stepId)).not.toContain(INTEREST_STEP_IDS.recheck);

    const record = await env.store.readJson<{
      deliverable: {
        slides: Array<{ n: number; fields: Record<string, string> }>;
        caption: string;
        interestRelayout?: { discarded?: boolean; discardedReason?: string };
      };
    }>("acme", ["ledger", "deliverables", "interest_relayout_rolled_back", "_", "instagram-carousel"]);
    const delivered = record!.deliverable;

    // THE ASSERTION. The delivered copy is the copy the FIRST render painted:
    // the caption is the draft's own, with nothing moved into it, and the
    // slides-data that shipped is the first render's.
    const drafted = goodCopyOutput();
    expect(delivered.caption).toBe(drafted.caption);
    for (const slide of drafted.slides) {
      const shipped = delivered.slides.find((s) => s.n === slide.n);
      // Every slide's rendered prose is still the drafted prose. A committed
      // `move-sentence-to-caption` would have left a shortened body here and
      // a longer caption above.
      if (shipped?.fields["body"] !== undefined) expect(shipped.fields["body"]).toBe(slide.body);
    }

    // And the attempt is not silent about it: the plan still rides the gate
    // payload, flagged, so a reviewer can see that code tried something the
    // render refused rather than that code fixed something.
    expect(delivered.interestRelayout?.discarded).toBe(true);
    expect(delivered.interestRelayout?.discardedReason).toContain("content_fail");
    expect(delivered.interestRelayout?.discardedReason).toContain("rolled back");
  }, 60000);

  /**
   * A PROMOTED PICTURE CARRIES ITS OWN RECORD, OR IT IS A FALSIFIED ONE.
   *
   * `ImageSelectionSchema` is a compliance artefact: one row per slide naming
   * the image's licence, its rights/watermark verdict, and whether the
   * picture carries THAT slide's claim. There is exactly one row per slide,
   * so moving only `imagePath` onto the cover left a real third-party
   * photograph described by the row the cover already had — on the reachable
   * path, the typographic stand-in: `license: "n/a — typographic layout, no
   * image used"`, `claimMatch: 5`, "no photograph to judge". `09b` persists
   * that array on the deliverable and the shipped-image ledger reads
   * `imagePath` from it, so the falsified row is what ships.
   *
   * And `claimMatch` is capped: the vet scored the picture against slide 3's
   * claim, nothing re-scores it against the cover's headline (`07a` and
   * `07-self-check` both run before `08a1b`), and an uncapped 5 on slide 1 is
   * exactly the "photos of one team's fans under another team's headline"
   * defect `claimMatch` exists to close — on the one slide the whole audience
   * sees.
   */
  it("promotes a vetted image onto the cover WITH its licence and a capped, re-stated claim verdict", async () => {
    // Slide 1 is typographic (so its row is the stand-in `07a` writes for a
    // slide that never wanted a photograph) and slide 3 carries a vetted
    // image no slide renders — the promotable case.
    const drafted = goodCopyOutput();
    const copy = {
      ...drafted,
      slides: drafted.slides.map((s) =>
        s.n === 1
          ? { ...s, layout: "stat_callout" as const, stat: { figure: "42%", subLabel: "of teams onboard by hand", source: "internal survey" } }
          : s.n === 3
            ? { ...s, layout: "text_only" as const }
            : s,
      ),
    };
    const PROMOTED_PATH = goodImageCandidatePool()[0]!.path;
    const vetting = {
      selections: copy.slides
        .filter((s) => s.n !== 1)
        .map((s) => ({
          n: s.n,
          imagePath: PROMOTED_PATH,
          reason: `candidate matches "${s.visualNeed}" closely enough`,
          license: s.n === 3 ? "CC0, Openverse — the promotable one" : "CC0, test fixture",
          rightsUsable: true,
          watermarkFree: true,
          claimMatch: 5,
          claimMatchReason: s.n === 3 ? "shows slide 3's claimed subject" : "shows the claimed subject",
        })),
    };
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy, vet: vetting, relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, steps } = await runAutoApproved(env, "interest_promote_cover", router, { metrics: failsFirstRenderOnly() });
    expect(result.status, JSON.stringify(result)).toBe("completed");

    // The premise: the promotion really is the remedy that ran.
    const plan = steps.find((s) => s.stepId === INTEREST_STEP_IDS.relayout)?.output as
      | { changes: Array<{ kind: string; slide: number; fromSlide?: number }> }
      | undefined;
    expect(plan?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 1, fromSlide: 3 });

    const record = await env.store.readJson<{
      deliverable: { selections: Array<{ n: number; imagePath: string | null; license: string; rightsUsable: boolean; watermarkFree: boolean; claimMatch: number; claimMatchReason: string; reason: string }> };
    }>("acme", ["ledger", "deliverables", "interest_promote_cover", "_", "instagram-carousel"]);
    const cover = record!.deliverable.selections.find((s) => s.n === 1)!;

    // THE ASSERTION: the shipped cover's row describes the picture it ships.
    expect(cover.imagePath).toBe(PROMOTED_PATH);
    expect(cover.license).toBe("CC0, Openverse — the promotable one");
    expect(cover.rightsUsable).toBe(true);
    expect(cover.watermarkFree).toBe(true);
    // Capped, and the cap says why in the row itself.
    expect(cover.claimMatch).toBe(3);
    expect(cover.claimMatchReason).toContain("vetted for slide 3's claim");
    expect(cover.claimMatchReason).toContain("without a re-vet");
    expect(cover.reason).toContain("promoted from slide 3");
    // The stand-in's wording is gone: it described a slide with no photograph.
    expect(cover.license).not.toContain("typographic layout");
    expect(cover.claimMatchReason).not.toContain("no photograph to judge");
  }, 60000);

  it("an UNMEASURABLE png is a fact, not a verdict: the run delivers, warns once, and never holds", async () => {
    const router = fakeRouterSequence(happyTurns());
    const { result, stepIds } = await runAutoApproved(env, "interest_not_measured", router, {
      metrics: () => undefined,
      measureFailure: () => "measureSlidePng: the PNG could not be decoded (interlaced)",
    });

    expect(result.status).toBe("completed");
    // No escalation of any kind on an unmeasured attempt.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).not.toContain(INTEREST_STEP_IDS.relayout);
    expect(copyTurnInputs(router)).toHaveLength(1);

    const events = await env.store.listJson("acme", ["ledger", "events", "interest_not_measured"]);
    const notMeasured = events.filter((e) => String(e.id).includes("interest-not-measured"));
    expect(notMeasured).toHaveLength(1);
    expect(String((notMeasured[0]!.data as { message: string }).message)).toMatch(/could not be measured/i);
  }, 40000);
});
