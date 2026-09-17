import { describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { SKELETON_BELIEF_KEY, readSkeletonHistory, recentSeriesIds } from "../src/workflow/skeleton-memory.js";
import { EDITORIAL_SERIES_IDS } from "../src/workflow/editorial-series.js";
import {
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  goodImageCandidatePool,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * RFC-21 Part 3 — THE WIRING, AND WHY THIS FILE EXISTS SEPARATELY FROM
 * `editorial-series.test.ts`.
 *
 * That file tests a pure function exhaustively: the scoring, the rotation, the
 * truncation, the import boundary. Every one of its 28 cases would still be
 * green if `04i2-select-series` returned `undefined` on every real run and the
 * writer never saw a directive in its life. `workflow-e2e.test.ts` would be
 * green too — it asserts the step id EXISTS, and a step that returns
 * `undefined` still writes a step record.
 *
 * **So the whole feature could be inert and nothing would go red.** That is the
 * failure mode this codebase keeps recording, and it is worth being blunt about
 * why it is so easy to hit here: the module is deterministic and well covered,
 * which makes it feel tested, and the two things that actually carry the
 * feature — that a real run CHOOSES a series, and that the choice REACHES the
 * writer — are wiring, not logic.
 *
 * This file asserts exactly those two, on a real workflow run, and then
 * asserts its own premise by removing the angle and watching the directive
 * disappear.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

async function run(env: TestEnvironment, runId: string, router: ReturnType<typeof fakeRouterSequence>, tools: AgentToolRegistry) {
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
  return { result, steps, durableStore, stepIds: steps.map((s) => s.stepId) };
}

describe("RFC-21 Part 3 wiring: a real run chooses a series and the writer is told", () => {
  it("chooses a series at 04i2 and puts the SKELETON on the copy step's input", async () => {
    const env = await setupTestEnvironment();
    const tools = { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
    const router = fakeRouterSequence(happyTurns());
    const { result, steps } = await run(env, "instagram_run_series_wiring", router, tools);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    // ── 1. THE STEP RAN AND IT DECIDED SOMETHING. ──
    //
    // `toBeDefined` on the step record is not enough and is the trap this file
    // exists for: a step that returns `undefined` records just as happily. The
    // OUTPUT has to name a series from the declared set.
    const series = steps.find((s) => s.stepId === "04i2-select-series")?.output as
      | { series?: { id?: string; badge?: string }; reason?: string; scores?: Record<string, number> }
      | undefined;
    expect(series, "04i2-select-series produced no output on a happy run — the feature is inert").toBeDefined();
    expect(EDITORIAL_SERIES_IDS, `04i2 chose "${series?.series?.id}", which is not a declared series`).toContain(series!.series!.id);
    expect(series!.reason, "the choice carries no reason, so a reviewer cannot ask why THIS format").toMatch(/series "/u);
    expect(Object.keys(series!.scores ?? {}), "the scores are missing, so a one-point win reads like a decision").toHaveLength(
      EDITORIAL_SERIES_IDS.length,
    );

    // ── 2. AND THE WRITER WAS ACTUALLY TOLD. ──
    //
    // The half that no other test in this repo covers. The directive has to be
    // on the FIRST copy turn's input, carry the chosen series' badge, and name
    // a layout per slide — a directive that arrived empty, or arrived without
    // the skeleton, would be a prompt section instructing the model to follow
    // an order it was never given.
    const directive = String(copyTurnInputs(router)[0]?.["seriesDirective"] ?? "");
    expect(directive, "the copy step's input carried no seriesDirective — 04i2 decided and nobody was told").not.toBe("");
    expect(directive).toContain(series!.series!.badge!);
    expect(directive).toMatch(/^\s*1\. cover$/mu);
    expect(directive).toMatch(/^\s*8\. closer$/mu);
    // The safety sentence, on the wire rather than only in the prompt file.
    expect(directive).toMatch(/content cannot fill the layout it was given/u);

    // ── 3. AND IT WAS RECORDED, WHICH IS WHAT MAKES ROTATION POSSIBLE. ──
    //
    // Rotation is a property of the NEXT run, and it reads this. Without the
    // write the pure function is handed an empty history every week and picks
    // the same best-scoring format on the same story forever — the feature
    // would look alive in the trace and be dead in the feed.
    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const history = readSkeletonHistory(beliefs);
    expect(history.entries.at(-1)?.seriesId, "the shipped post recorded no seriesId, so the next run cannot rotate away from it").toBe(
      series!.series!.id,
    );
    expect(recentSeriesIds(history)).toContain(series!.series!.id);
    expect(SKELETON_BELIEF_KEY).toBe("instagramSkeletons");

    // ── 4. AND THE READER IS *NOT* TOLD — THE BADGE IS RETIRED. ──
    //
    // RFC-21 Part 3 announced the series through the `seriesBadge` slot, and
    // Phase 5.5 item C3 deleted it. The owner's 2026-09-16 verdict is the whole
    // reason: "BY THE NUMBERS" / "{ FIELD NOTES }" is an INTERNAL label a
    // reader cannot use, it printed on all eight slides of all three posts, and
    // on geektime the brand logo disc landed on it and clipped it to `{ FIELD`
    // eight times over.
    //
    // So the assertion inverts, and what it now guards is that the SERIES still
    // does everything worth doing while reaching no pixel: it directed the
    // skeleton (asserted above), it is recorded in skeleton memory (asserted
    // above), and it prints nothing. A client's OWN standing `seriesBadge` is
    // untouched — `contentFor` still emits it, and the
    // explicit-brand-decision precedence is unchanged — which is why this
    // fixture, whose client sets none, reads `undefined` rather than "".
    const slidesData = steps.find((s) => s.stepId.startsWith("07c-emit-slides-data"))?.output as
      | { slides?: Array<{ fields?: Record<string, unknown> }> }
      | undefined;
    const badges = new Set((slidesData?.slides ?? []).map((slide) => slide.fields?.["seriesBadge"]));
    expect([...badges], "the derived series badge reached the render, and item C3 retired it").not.toContain(series!.series!.badge);
    expect([...badges], "this client sets no standing badge of its own, so the slot is simply absent").toEqual([undefined]);
  }, 120_000);

  it("ASSERT THE PREMISE: an angle that fails open leaves no series and no directive, and the run still delivers", async () => {
    // The fail-open path, and the control for the case above. Without it the
    // assertions above could be green because the fixture happens to produce
    // an angle, and nobody would know whether a directive is ever absent —
    // which is the difference between "fails open" as a claim and as a
    // behaviour.
    //
    // The angle turn is REPLACED rather than dropped, and that is not a
    // stylistic choice: `standardTurns` queues by position, so removing a turn
    // shifts every fixture after it and the copy step receives the vetting
    // fixture. (Tried it; the run held on three malformed drafts, which is the
    // queue desynchronising rather than anything about series.) Instead every
    // proposal rests on a claim this run never fetched, which is exactly what
    // `selectAngle` refuses — one of the two real ways `04i` fails open — and
    // the queue keeps its length.
    const UNGROUNDED = {
      angles: goodAngleProposal().angles.map((angle) => ({ ...angle, restsOn: ["a claim no card in this run carries"] })),
      notes: "every proposal rests on a card this run never fetched",
    };
    const env = await setupTestEnvironment();
    const tools = { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
    const router = fakeRouterSequence(happyTurns({ angle: UNGROUNDED }));
    const { result, steps } = await run(env, "instagram_run_series_no_angle", router, tools);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const record = steps.find((s) => s.stepId === "04i2-select-series");
    expect(record, "the step must still RUN on the fail-open path, and decide nothing").toBeDefined();
    // `toBeNull`, NOT `?? undefined`. The `??` was here first and it is what
    // hid the production encoding: the engine records a step that returned
    // `undefined` as `null`, and `null ?? undefined` is `undefined`, so this
    // line was green while prep was storing a value that crashed the resume.
    // See `series-null-checkpoint.test.ts` for the incident.
    expect(record?.output, "a run with no angle must not invent a series").toBeNull();
    expect(copyTurnInputs(router)[0]?.["seriesDirective"], "a run with no angle must send no directive").toBeUndefined();
  }, 120_000);
});
