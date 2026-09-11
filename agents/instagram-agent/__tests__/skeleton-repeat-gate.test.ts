import { describe, expect, it, afterEach } from "vitest";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  MIN_SKELETON_DISTANCE,
  SKELETON_BELIEF_KEY,
  readSkeletonHistory,
  skeletonDistance,
  skeletonSignature,
  type SkeletonEntry,
  type SkeletonHistory,
} from "../src/workflow/skeleton-memory.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  boringSlideMetrics,
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  qaTurnInputs,
  passingSlideMetrics,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { happyTurns, standardTurns } from "./turns.js";

/**
 * Item P through the real workflow: `07k-skeleton-variety-attempt-N`.
 *
 * The owner's second complaint is that the feed reads as machine-made because
 * every post has the same shape. This file is the enforceable half of that: a
 * carousel whose layout sequence repeats the previous post's is refused BEFORE
 * a render, the numbers reach the redraft, and the run still delivers.
 *
 * ## Wiring dependency
 *
 * Green once the integrator lands step 7 of the Phase 2 wiring order (WP-C5
 * integration note (c)): `07k-skeleton-variety-attempt-N` immediately after
 * `07h` and BEFORE any render, calling `checkSkeletonVariety` and, on
 * `action: "return"`, `returnToCopyWith(verdict.reason)` then `continue`. The
 * pre-render placement is not a detail: the zero-render assertion below is the
 * whole cost claim, and a check placed after `08` would pay for a Chromium
 * launch to learn something `07k` already knew.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** `goodCopyOutput()` is six `photo` slides, so every one resolves to the client's own `slide.html` with a hero. */
function signatureOfGoodCopy(): string {
  return skeletonSignature(
    goodCopyOutput().slides.map((slide) => ({ n: slide.n, template: "slide.html", hasImage: true })),
  );
}

function lastWeek(signature: string, runId = "run_last_week"): SkeletonHistory {
  const entry: SkeletonEntry = {
    runId,
    at: "2026-09-03T09:00:00.000Z",
    signature,
    archetypes: signature.split(">").map((t) => t.split(":")[1]!),
    deviceKinds: signature.split(">").map(() => ""),
    roles: signature.split(">").map((t) => t.split(":")[0] as "cover" | "interior" | "closer"),
    occupancy: [],
    edited: false,
  };
  return { version: 1, entries: [entry] };
}

/** Slide 2 becomes a `stat_callout`: exactly ONE position of six changes, which is a 0.17 near-match. */
function copyWithOneSwap(): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
    ...copy,
    slides: copy.slides.map((slide, i) =>
      i === 1
        ? {
            ...slide,
            layout: "stat_callout" as const,
            stat: { figure: "30%", subLabel: "more tickets resolved", source: "support dashboard export" },
          }
        : slide,
    ),
  };
}

/** Counts every `publish.renderCarousel` execution, so "a repeat costs no render" is asserted rather than claimed. */
function countingRender(env: TestEnvironment): { tool: AgentTool; calls: () => number } {
  const inner = fakeRenderCarousel(env.tools["publish.renderCarousel"]!);
  let calls = 0;
  return {
    tool: {
      ...inner,
      async execute(args: unknown, opts: never) {
        calls += 1;
        return inner.execute(args, opts);
      },
    } as AgentTool,
    calls: () => calls,
  };
}

async function run(
  env: TestEnvironment,
  runId: string,
  router: ReturnType<typeof fakeRouterSequence>,
  tools: AgentToolRegistry,
) {
  const durableStore = new MemoryDurableStepStore();
  const workflowFn = createInstagramAgentWorkflow({
    tools,
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
    autoApprove: true,
  });
  const result = await new WorkflowEngine(durableStore).run(workflowFn, { runId, ...base });
  const steps = await durableStore.listSteps(runId);
  return { result, steps, stepIds: steps.map((s) => s.stepId), durableStore };
}

describe("07k-skeleton-variety (item P): repetition is refused before a render, and never held", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  it("no history: 07k passes, consumes nothing, and the run is turn-for-turn what it was before item P", async () => {
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton topic ${i + 1}`) });
    const render = countingRender(env);
    const router = fakeRouterSequence(happyTurns());
    const { result, stepIds } = await run(env, "skel_first_post", router, { ...env.tools, "publish.renderCarousel": render.tool });

    expect(result.status).toBe("completed");
    // A first run has nothing to repeat: both clauses are inert, one render.
    expect(stepIds.filter((id) => id.startsWith("07k-"))).toEqual(["07k-skeleton-variety-attempt-1"]);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(render.calls()).toBe(1);
  }, 60000);

  it("HARD clause: last week's exact signature fails attempt 1 with ZERO render calls, names both sequences, and the run delivers", async () => {
    const repeated = signatureOfGoodCopy();
    env = await setupTestEnvironment({
      seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton topic ${i + 1}`),
      seedSkeletons: lastWeek(repeated),
    });
    const render = countingRender(env);
    // Attempt 1 repeats last week exactly; attempt 2 moves two positions.
    const varied = copyWithOneSwap();
    const variedTwice: InstagramCopyOutput = {
      ...varied,
      slides: varied.slides.map((slide, i) =>
        i === 4
          ? { ...slide, layout: "quote_card" as const, quote: { text: "the report has to write itself", attribution: "an operations lead, 2026" } }
          : slide,
      ),
    };
    // `07k` sits after `07h`, so an attempt refused there has ALREADY spent
    // its copy, vetting and relevance turns; only `08b` is saved along with
    // the render. Attempt 2 moves two positions and ships.
    const router = fakeRouterSequence([
      ...happyTurns({ qa: undefined }),
      ...standardTurns({ copy: variedTwice, vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, stepIds } = await run(env, "skel_repeat", router, { ...env.tools, "publish.renderCarousel": render.tool });

    expect(result.status).toBe("completed");
    expect(stepIds).toContain("07k-skeleton-variety-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("07k-skeleton-variety-attempt-2");

    // THE COST CLAIM: attempt 1 was refused pre-render, so only the attempt
    // that passed 07k ever reached Chromium.
    expect(render.calls()).toBe(1);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");

    // The steer names BOTH sequences, so the writer can see what to change.
    const steer = String(copyTurnInputs(router)[1]?.["selfCheckSteer"] ?? "");
    expect(steer).toContain(repeated);
    expect(steer).toContain("identical to the previous post's");
    expect(steer).toContain("starting with the cover");

    // ...and attempt 2's input carries the avoid-list itself, not only the steer.
    expect(copyTurnInputs(router)[1]?.["recentSkeletons"]).toEqual([repeated]);
    expect(String(copyTurnInputs(router)[1]?.["skeletonRule"] ?? "")).toContain("Do not reproduce any of them");
  }, 90000);

  it("SOFT clause: a 0.17 near-match returns on attempt 1 and only WARNS from attempt 2", async () => {
    const previous = signatureOfGoodCopy();
    const near = skeletonSignature(
      copyWithOneSwap().slides.map((slide) => ({
        n: slide.n,
        template: slide.layout === "stat_callout" ? "stat-callout.html" : "slide.html",
        hasImage: slide.layout === "photo",
      })),
    );
    expect(skeletonDistance({ signature: near }, { signature: previous })).toBe(0.17);
    expect(0.17).toBeLessThan(MIN_SKELETON_DISTANCE);

    env = await setupTestEnvironment({
      seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton topic ${i + 1}`),
      seedSkeletons: lastWeek(previous),
    });
    const render = countingRender(env);
    // The SAME near-match on both attempts: attempt 1 returns, attempt 2 ships
    // with a warning. Variety is enforced while it is free, never at the cost
    // of the post.
    const router = fakeRouterSequence([
      ...happyTurns({ copy: copyWithOneSwap(), qa: undefined }),
      ...standardTurns({ copy: copyWithOneSwap(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, stepIds, steps } = await run(env, "skel_near", router, { ...env.tools, "publish.renderCarousel": render.tool });

    expect(result.status).toBe("completed");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(render.calls()).toBe(1);

    const secondVerdict = steps.find((s) => s.stepId === "07k-skeleton-variety-attempt-2")?.output as { action?: string; distance?: number } | undefined;
    expect(secondVerdict?.action).toBe("warn");
    expect(secondVerdict?.distance).toBe(0.17);

    // 08b is told about it, because the residue judgment is its half.
    const qaInput = qaTurnInputs(router)[0];
    expect(qaInput?.["previousSkeleton"]).toBe(previous);
    expect(qaInput?.["thisSkeleton"]).toBe(near);
  }, 90000);

  it("THREE identical drafts DELIVER degraded rather than holding: repetition is a design defect, never a fourth hold cause", async () => {
    const repeated = signatureOfGoodCopy();
    env = await setupTestEnvironment({
      seedTopics: Array.from({ length: 14 }, (_, i) => `skeleton topic ${i + 1}`),
      seedSkeletons: lastWeek(repeated),
    });
    const render = countingRender(env);
    // Every attempt spends copy + vetting + relevance; only the final one,
    // which ships, also spends `08b`.
    const attempt = (n: number) =>
      n === 1
        ? happyTurns({ qa: undefined })
        : standardTurns({
            copy: goodCopyOutput(),
            vet: goodImageVettingOutput(),
            relevance: goodRelevanceVerdict(),
            ...(n === 3 ? { qa: goodVisualQaOutput() } : {}),
          });
    const router = fakeRouterSequence([...attempt(1), ...attempt(2), ...attempt(3)]);
    const { result, stepIds, steps } = await run(env, "skel_stubborn", router, { ...env.tools, "publish.renderCarousel": render.tool });

    expect(["completed", "degraded"]).toContain(result.status);
    expect(result.status).not.toBe("held");
    expect(stepIds).toContain("07k-skeleton-variety-attempt-3");
    // The final attempt ships with the finding recorded rather than returning again.
    const finalVerdict = steps.find((s) => s.stepId === "07k-skeleton-variety-attempt-3")?.output as { ok?: boolean; action?: string } | undefined;
    expect(finalVerdict?.ok).toBe(true);
    expect(finalVerdict?.action).toBe("warn");
    expect(render.calls()).toBe(1);

    // The deliverable and the gate payload carry the fact, so the portal can
    // answer "are we shipping the same post every week".
    const deliverable = await env.store.readJson<{ deliverable: { skeleton?: { signature: string; previous?: string; repeatedPrevious: boolean } } }>(
      "acme",
      ["ledger", "deliverables", "skel_stubborn", "_", "instagram-carousel"],
    );
    expect(deliverable?.deliverable.skeleton?.repeatedPrevious).toBe(true);
    expect(deliverable?.deliverable.skeleton?.previous).toBe(repeated);
  }, 120000);

  /**
   * ITEM P.2's THIRD BULLET, which was dead code.
   *
   * "Two ADJACENT slides sharing both archetype and (post-render, at `08a1`)
   * the same occupancy bucket -> warn, joined to `08b`'s input." `07k` is
   * deliberately pre-render, so it has no occupancy to read and passed none:
   * `adjacentRepeatWarnings` skips every pair whose share is absent, so
   * `warnings` was structurally always empty and the `skeletonWarnings` key
   * on the judge's input was a permanently-false branch. The measured shares
   * now come back at `08a1e`.
   */
  it("joins the MEASURED within-carousel repetition to 08b: adjacent same-archetype slides at the same occupancy warn", async () => {
    env = await setupTestEnvironment();
    const router = fakeRouterSequence(happyTurns());
    // Every slide of `goodCopyOutput()` is a `photo` through the client's own
    // `slide.html`, so every adjacent pair shares an archetype token. Giving
    // them all the SAME occupied share is what makes them one slide shown six
    // times, which is the thing the judge is asked about.
    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!, {
        metrics: () => passingSlideMetrics({ occupiedShare: 0.54 }),
      }),
    };
    const { result, stepIds } = await run(env, "skel_occupancy", router, tools);
    expect(result.status).toBe("completed");

    // The step exists and runs after the render, which is the placement the
    // clause needs.
    expect(stepIds).toContain("08a1e-skeleton-occupancy-attempt-1");
    expect(stepIds.indexOf("08a1e-skeleton-occupancy-attempt-1")).toBeGreaterThan(stepIds.indexOf("08-render-carousel-attempt-1"));
    expect(stepIds.indexOf("08a1e-skeleton-occupancy-attempt-1")).toBeLessThan(stepIds.indexOf("08b-visual-qa-attempt-1"));

    // THE ASSERTION: the judge was actually told.
    const qaInput = qaTurnInputs(router)[0];
    const warnings = qaInput?.["skeletonWarnings"] as string[] | undefined;
    expect(warnings, `08b received no skeletonWarnings: ${JSON.stringify(Object.keys(qaInput ?? {}))}`).toBeDefined();
    // Three, not five: the signature's tokens are `role:archetype`, so the
    // cover-to-interior and interior-to-closer pairs differ by role and only
    // the three interior-to-interior pairs are candidates. That is the clause
    // working as written, and it is why the token carries the role at all.
    expect(warnings!.length).toBe(3);
    expect(warnings![0]).toContain("slides 2 and 3");
    expect(warnings![0]).toContain("54%");
    expect(warnings![0]).toContain("one slide shown twice");
  }, 60000);

  it("does NOT warn when the measured occupancy differs between adjacent slides, even on the same archetype", async () => {
    env = await setupTestEnvironment();
    const router = fakeRouterSequence(happyTurns());
    // Several photo slides in a row is the normal rhythm of a carousel (§7
    // says so explicitly). What the clause catches is several that are all
    // filled to the same degree, so a real difference in occupancy must be
    // silent. Buckets are tenths: 0.54 against 0.31 is two buckets apart.
    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!, {
        metrics: (slide) => passingSlideMetrics({ occupiedShare: slide.n % 2 === 0 ? 0.31 : 0.54 }),
      }),
    };
    const { result } = await run(env, "skel_occupancy_varied", router, tools);
    expect(result.status).toBe("completed");
    const qaInput = qaTurnInputs(router)[0];
    expect(qaInput?.["skeletonWarnings"]).toBeUndefined();
  }, 60000);

  /**
   * THE REPORTED SKELETON MUST BE THE ONE THAT SHIPPED.
   *
   * `07k` runs PRE-render, on `slidesDataAttempt`. `08a1b`'s free re-layout
   * then mutates layouts and devices and commits a new `slidesDataForQa`, and
   * every remedy kind changes the signature: `attach-device` appends
   * `+<kind>`, and `switch-archetype`, `promote-image-to-cover`,
   * `colour-block-ground`, `build-recap` and `add-question-block` all change
   * an archetype token.
   *
   * Carrying `07k`'s tokens past a re-layout put a carousel that did not ship
   * on the gate payload and on the deliverable — and paired the OLD tokens
   * with the NEW slides' measured shares inside `08a1e`'s adjacency
   * warnings — while `09b` independently recorded the real one under
   * `SKELETON_BELIEF_KEY`. Item P's whole purpose is that the portal can
   * answer "are we shipping the same post every week"; the answer shown was
   * wrong exactly when a re-layout ran.
   */
  it("recomputes the signature AFTER the free re-layout, so the gate, the deliverable and the belief all name the same carousel", async () => {
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton relayout topic ${i + 1}`) });
    // Slide 2 is a `headline_focus` that fails the floor on the first render
    // only, so `08a1b` attaches a figure device from its own text — a change
    // whose ONLY signature effect is the `+figure` suffix on slide 2's token.
    const drafted = goodCopyOutput();
    const copy: InstagramCopyOutput = {
      ...drafted,
      slides: drafted.slides.map((s) => (s.n === 2 ? { ...s, layout: "headline_focus" as const } : s)),
    };
    let renders = 0;
    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!, {
        metrics: (slide) => {
          if (slide.n === 1) renders += 1;
          return renders === 1 && slide.n === 2 ? boringSlideMetrics() : passingSlideMetrics();
        },
      }),
    };
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy, vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, steps } = await run(env, "skel_relayout", router, tools);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    // The premise: the re-layout ran and it really did change the skeleton.
    const plan = steps.find((s) => s.stepId === "08a1b-relayout-for-interest-attempt-1")?.output as
      | { changes: Array<{ kind: string; slide: number }> }
      | undefined;
    expect(plan?.changes[0]).toMatchObject({ kind: "attach-device", slide: 2 });

    const preRender = (steps.find((s) => s.stepId === "07k-skeleton-variety-attempt-1")?.output as { signature: string }).signature;
    const reported = (steps.find((s) => s.stepId === "08a1e-skeleton-occupancy-attempt-1")?.output as { signature: string }).signature;

    // THE ASSERTION: what the portal is shown equals what the history records.
    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const stored = readSkeletonHistory(beliefs).entries[0]!.signature;
    expect(reported).toBe(stored);
    const deliverable = await env.store.readJson<{ deliverable: { skeleton?: { signature: string } } }>(
      "acme",
      ["ledger", "deliverables", "skel_relayout", "_", "instagram-carousel"],
    );
    expect(deliverable?.deliverable.skeleton?.signature).toBe(stored);

    // ...and it is NOT the pre-render one, which is what made this a defect
    // rather than a tidy-up.
    expect(reported).not.toBe(preRender);
    expect(reported).toContain("headline_focus+figure");
    expect(preRender).not.toContain("+figure");
  }, 90000);

  /**
   * PAST THE HARD MAX, A LAYOUT REPEAT IS NOT WORTH A REDRAFT.
   *
   * The standing amendment: past the run's hard max, finish on the cheapest
   * complete path and DELIVER. `08a1` applies it (`attempt < maxAttempts &&
   * meter.posture !== "cheapest-path"`); `07k` did not, so a run that had
   * already crossed $1.50 still bought a Sonnet copy attempt plus its vet,
   * relevance and inspect legs (~$0.19) for a purely stylistic repeat — which
   * this module's own reasoning calls "a design defect, not a compliance
   * one", i.e. exactly the optional work the cheapest path exists to drop.
   */
  it("does NOT buy a redraft for a repeated layout past the run's hard max — it ships with the finding recorded", async () => {
    const repeated = signatureOfGoodCopy();
    env = await setupTestEnvironment({
      seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton topic ${i + 1}`),
      seedSkeletons: lastWeek(repeated),
    });
    const render = countingRender(env);
    // The copy turn reports $1.80 of Sonnet output, so the meter crosses the
    // $1.50 hard max on attempt 1 and the posture is `cheapest-path` by the
    // time `07k` runs. ONE attempt's worth of turns is queued: a second would
    // exhaust the router, so this passing IS the assertion that no redraft
    // was bought.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()),
      finalTurn(goodCopyOutput(), { outputTokens: 120_000 }),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const { result, stepIds, steps } = await run(env, "skel_cheapest_path", router, { ...env.tools, "publish.renderCarousel": render.tool });

    expect(result.status, JSON.stringify(result)).not.toBe("held");
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("09b-deliver-and-log");

    // The repeat is not swept under the carpet: it is demoted to a warning
    // whose reason says why it was not redrafted.
    const verdict = steps.find((s) => s.stepId === "07k-skeleton-variety-attempt-1")?.output as
      | { action?: string; ok?: boolean; repeatedPrevious?: boolean }
      | undefined;
    expect(verdict?.repeatedPrevious).toBe(true);
    // `07k`'s own step output is the pre-render verdict; the suppression is
    // applied to the verdict the gate and the ledger carry.
    const deliverable = await env.store.readJson<{ deliverable: { skeleton?: { repeatedPrevious: boolean } } }>(
      "acme",
      ["ledger", "deliverables", "skel_cheapest_path", "_", "instagram-carousel"],
    );
    expect(deliverable?.deliverable.skeleton?.repeatedPrevious).toBe(true);
    const suppressed = await env.store.readJson<{ level: string; message: string }>(
      "acme",
      ["ledger", "events", "skel_cheapest_path", "skel_cheapest_path__skeleton-variety-a1"],
    );
    expect(suppressed?.level).toBe("warn");
    expect(suppressed?.message).toContain("identical to the previous post's");
    expect(suppressed?.message).toContain("past the run's hard max");
  }, 90000);

  it("the delivered run writes the skeleton back under SKELETON_BELIEF_KEY, idempotently", async () => {
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `skeleton topic ${i + 1}`) });
    const render = countingRender(env);
    await run(env, "skel_write", fakeRouterSequence(happyTurns()), { ...env.tools, "publish.renderCarousel": render.tool });

    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const history = readSkeletonHistory(beliefs);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.runId).toBe("skel_write");
    expect(history.entries[0]!.signature).toBe(signatureOfGoodCopy());
    // The budget history is a SIBLING key in the same document, not a
    // replacement for it: `updateBeliefs` merges a diff, which is why these
    // are new keys rather than a widened one.
    expect(beliefs?.[SKELETON_BELIEF_KEY]).toBeDefined();
    expect(beliefs?.["instagramRunBudget"]).toBeDefined();
  }, 60000);
});
