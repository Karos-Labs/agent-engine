import { describe, expect, it, afterEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, parseContentModeFromSummary } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { angleDecisionSummary, angleFromDecisionSummary, type AngleDecision } from "../src/workflow/angle-selection.js";
import { STEP_COST_ESTIMATES_USD } from "../src/workflow/run-budget.js";
import {
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns, standardTurns } from "./turns.js";
import { goodAngleProposal, surprisingNumberAngle, whatItMeansAngle, wrongAssumptionAngle } from "./angle-fixtures.js";

/**
 * RFC-13 §K through the real workflow: `04i-propose-angles` (one Sonnet call
 * per REVISION, at the top of `draftOnce`, outside the attempt loop) and
 * `04j-select-angle` (the deterministic pick), the `angle` block on the copy
 * input, `angleDecision` on the gate payload, and the angle in `09b`'s
 * decision row so next week's proposal knows what this account already said.
 *
 * Step ids are the spec's; these tests need the integrator's wiring of
 * `04i`/`04j`, the copy input's `angle` field, the gate payload's
 * `angleDecision` and `09b`'s `angleDecisionSummary(...)` call. Everything
 * they assert about the pick itself is unit-tested in
 * `angle-selection.test.ts`.
 *
 * The load-bearing posture, tested twice below: the angle FAILS OPEN. A
 * malformed proposal delivers a post without an angle and a ledger warn,
 * never a hold — an angle improves a post, it is not a precondition for one
 * (owner's rule: a deliverable always reaches the client).
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

function workflowFor(env: TestEnvironment, router: ReturnType<typeof fakeRouterSequence>, opts: { autoApprove?: boolean } = {}) {
  return createInstagramAgentWorkflow({
    tools: testTools(env),
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
    ...(opts.autoApprove === false ? {} : { autoApprove: true }),
  });
}

/** The `04i-propose-angles` input the workflow assembled, parsed back out of the prompt the fake router saw. */
function angleTurnInputs(router: ReturnType<typeof fakeRouterSequence>): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      // The angle step is the only one handed `pastAngles`.
      if (parsed.input && typeof parsed.input === "object" && "pastAngles" in parsed.input) inputs.push(parsed.input);
    } catch {
      // not a JSON prompt
    }
  }
  return inputs;
}

describe("04i / 04j — the angle step in the instagram workflow", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  it("proposes once, picks deterministically, and hands the copy step the chosen angle and the two rejected ones", async () => {
    env = await setupTestEnvironment();
    const router = fakeRouterSequence(happyTurns({ angle: goodAngleProposal() }));
    const runId = "ig_angle_happy";
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(env, router), { ...base, runId });
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps(runId);
    const stepIds = steps.map((s) => s.stepId);
    expect(stepIds).toContain("04i-propose-angles");
    expect(stepIds).toContain("04j-select-angle");
    // Once per revision, not once per attempt: the ids are not attempt-scoped.
    expect(stepIds.filter((id) => id.startsWith("04i-propose-angles"))).toHaveLength(1);

    const decision = steps.find((s) => s.stepId === "04j-select-angle")?.output as AngleDecision | undefined;
    expect(decision?.status).toBe("selected");
    if (decision === undefined || decision.status !== "selected") throw new Error("unreachable");
    expect(decision.rejected).toHaveLength(2);

    // The copy step argues the chosen angle and is told which moves it is NOT making.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(1);
    const angle = copyInputs[0]!["angle"] as { chosen: { id: string; rememberLine: string }; rejected: Array<{ id: string }> };
    expect(angle.chosen.id).toBe(decision.chosen.id);
    expect(angle.chosen.rememberLine).toBe(decision.chosen.rememberLine);
    expect(angle.rejected).toHaveLength(2);
    expect(angle.rejected.map((r) => r.id)).not.toContain(decision.chosen.id);

    // The proposer saw the brief, the facts and the account's history.
    const angleInputs = angleTurnInputs(router);
    expect(angleInputs).toHaveLength(1);
    expect(typeof angleInputs[0]!["clientBrief"]).toBe("string");
    expect(Array.isArray(angleInputs[0]!["facts"])).toBe(true);
    expect((angleInputs[0]!["facts"] as unknown[]).length).toBeGreaterThan(0);
    expect(angleInputs[0]!["pastAngles"]).toEqual([]);

    // ONE ordered slice of the fact set for both prompts: the proposer read
    // exactly the writer's list, so the chosen angle's `restsOn` cards are
    // always in front of the writer that has to cite them verbatim with their
    // source, date and URL (prompt @13 §17). Two independent 14-card slices
    // of the same set can disagree, and then the argument rests on evidence
    // the writer never received.
    const writerClaims = (copyInputs[0]!["facts"] as Array<{ claim: string }>).map((c) => c.claim);
    expect((angleInputs[0]!["facts"] as Array<{ claim: string }>).map((f) => f.claim)).toEqual(writerClaims);
    for (const claim of decision.chosen.restsOn) expect(writerClaims).toContain(claim);

    // The reviewer sees the decision and its arithmetic, and the money: one
    // Sonnet angle call, on the meter, once for the run.
    const deliverables = await env.store.listJson<{ deliverable: { angleDecision?: AngleDecision; budget?: { lines: Array<{ label: string; usd: number }> } } }>(
      "acme",
      ["ledger", "deliverables", runId, "_"],
    );
    expect(deliverables).toHaveLength(1);
    const delivered = deliverables[0]!.data.deliverable.angleDecision;
    expect(delivered?.status).toBe("selected");

    const angleLines = (deliverables[0]!.data.deliverable.budget?.lines ?? []).filter((l) => l.label.includes("04i"));
    expect(angleLines).toHaveLength(1);
    expect(angleLines[0]!.usd).toBeGreaterThanOrEqual(STEP_COST_ESTIMATES_USD.angle);

    // The ledger row carries the angle INSIDE the parenthesis, and the mode
    // still parses out of the same group.
    const ctx: AgentContext = { ...base, runId, metadata: {} };
    const read = await env.tools["memory.read"]!.execute({ scope: "decisions", limit: 10 }, { ctx });
    expect(read.status).toBe("success");
    const row = (read as { result: { items: Array<{ decisionId: string; summary: string }> } }).result.items.find((d) => d.decisionId === `${runId}__topic`);
    expect(row).toBeDefined();
    expect(row!.summary).toContain(`; angle: ${decision.chosen.id} | `);
    expect(parseContentModeFromSummary(row!.summary)).toBeDefined();
    expect(angleFromDecisionSummary(row!.summary)).toEqual({ id: decision.chosen.id, rememberLine: decision.chosen.rememberLine });
  }, 60000);

  it("reads last run's angle back out of the decision log, so the second run cannot repeat it", async () => {
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `topic ${i + 1} for the angle ledger test`) });
    const ctx: AgentContext = { ...base, runId: "seed", metadata: {} };
    const seeded = angleDecisionSummary(
      'instagram post: "automated weekly reporting" (mode: deep-value; source: reserved; archetypes: photo)',
      wrongAssumptionAngle(),
    );
    await env.tools["memory.appendDecision"]!.execute({ decisionId: "seed-angle", summary: seeded }, { ctx });

    const router = fakeRouterSequence(happyTurns({ angle: goodAngleProposal() }));
    const runId = "ig_angle_past";
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(env, router), { ...base, runId });
    expect(result.status).toBe("completed");

    // The proposer is told what this account already said...
    const angleInputs = angleTurnInputs(router);
    const pastAngles = angleInputs[0]!["pastAngles"] as Array<{ id: string; rememberLine: string }>;
    expect(pastAngles).toContainEqual({ id: "wrong-assumption", rememberLine: wrongAssumptionAngle().rememberLine });

    // ...and the pick will not choose the repeat, whatever briefFit it claimed.
    const decision = (await durableStore.getStep(runId, "04j-select-angle"))?.output as AngleDecision | undefined;
    expect(decision?.status).toBe("selected");
    if (decision === undefined || decision.status !== "selected") throw new Error("unreachable");
    expect(decision.chosen.rememberLine).not.toBe(wrongAssumptionAngle().rememberLine);
    expect(decision.scores.find((s) => s.id === "wrong-assumption")?.novelty).toBe(0);
  }, 60000);

  it("a reviewer's revise round proposes a FRESH angle: 04i-propose-angles-r1, with the revision request attached", async () => {
    env = await setupTestEnvironment();
    const revised = goodCopyOutput();
    const router = fakeRouterSequence([
      ...happyTurns({ angle: goodAngleProposal() }),
      // The revision round: a new angle proposal, then a full drafting pass.
      ...standardTurns({
        angle: goodAngleProposal({ angles: [whatItMeansAngle(), surprisingNumberAngle(), wrongAssumptionAngle()] }),
        copy: revised,
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    ]);
    const runId = "ig_angle_revision";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFor(env, router, { autoApprove: false }), { ...base, runId });
    expect(first.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with what it means for a two person team, not with the number.",
      at: new Date().toISOString(),
    });
    const second = await engine.run(workflowFor(env, router, { autoApprove: false }), { ...base, runId });
    expect(second.status).toBe("awaiting_gate");

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).toContain("04i-propose-angles");
    expect(stepIds).toContain("04i-propose-angles-r1");
    expect(stepIds).toContain("04j-select-angle-r1");

    const angleInputs = angleTurnInputs(router);
    expect(angleInputs).toHaveLength(2);
    // Revision 0 had nothing to revise; revision 1 carries the reviewer's words.
    expect(angleInputs[0]!["revisionRequest"]).toBeUndefined();
    expect(String(angleInputs[1]!["revisionRequest"])).toContain("two person team");
  }, 90000);

  it("a malformed proposal FAILS OPEN: the run delivers without an angle, with a ledger warn and no hold", async () => {
    env = await setupTestEnvironment();
    // Two angles instead of three fails `AngleProposalSchema` inside
    // BaseAgent -> content_fail -> `angleDecision.status === "unavailable"`.
    const router = fakeRouterSequence(happyTurns({ angle: { angles: [wrongAssumptionAngle(), whatItMeansAngle()] } }));
    const runId = "ig_angle_unavailable";
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(env, router), { ...base, runId });
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps(runId);
    const decision = steps.find((s) => s.stepId === "04j-select-angle")?.output as AngleDecision | undefined;
    // Either the code step records the fail-open decision, or the workflow
    // skips it entirely; what must NOT happen is a hold or a missing post.
    if (decision !== undefined) expect(decision.status).toBe("unavailable");

    // Copy ran anyway, and ran WITHOUT an angle block (prompt §17: "no `angle`
    // in your input" is a documented, unchanged drafting path).
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(1);
    expect(copyInputs[0]!["angle"]).toBeUndefined();

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(1);

    const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", ["ledger", "events", runId]);
    const warn = events.find((e) => e.data.eventId.includes("angle"));
    expect(warn).toBeDefined();
    expect(warn!.data.level).toBe("warn");
  }, 60000);
});

describe("resume across the deploy that added `decisions` to 03d", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * The shape of the bug this pins: `03d-select-content-mode` gained an
   * ADDITIVE `decisions` field in this phase, and `03f-rank-topic-candidates`
   * / `04i-propose-angles` are NEW step ids. So a run that was sitting at
   * `09a-batch-review-r0` when the phase deployed replays 03d's OLD
   * checkpoint (no `decisions` key at all) while the new steps execute their
   * bodies for the first time — and an unguarded `modeSelection.decisions
   * .slice(0, 5)` there is a `TypeError`, which the engine records as a
   * `degraded` run with no deliverable. The owner's rule is that a limit, a
   * deploy or a missing field never costs the client their post.
   *
   * Seeded rather than mutated after the fact: a pre-existing completed step
   * record for this `runId` is exactly what the engine replays on the first
   * pass, so the run below genuinely reads a pre-Phase-1 03d.
   */
  it("replays a pre-Phase-1 03d checkpoint (no `decisions`) and still ranks, proposes and delivers", async () => {
    env = await setupTestEnvironment();
    const router = fakeRouterSequence(happyTurns({ angle: goodAngleProposal() }));
    const runId = "ig_angle_legacy_03d";
    const durableStore = new MemoryDurableStepStore();
    const now = Date.now();
    await durableStore.saveStep(runId, {
      stepId: "03d-select-content-mode",
      kind: "code",
      status: "completed",
      // The pre-Phase-1 output, verbatim: mode, source, priorMode. No `decisions`.
      output: { mode: "hot-news", source: "rotation" },
      startedAt: now,
      completedAt: now,
    });

    const result = await new WorkflowEngine(durableStore).run(workflowFor(env, router), { ...base, runId });
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const steps = await durableStore.listSteps(runId);
    const stepIds = steps.map((s) => s.stepId);
    // The replayed step was NOT re-executed, and both new consumers ran.
    expect(steps.find((s) => s.stepId === "03d-select-content-mode")?.output).toEqual({ mode: "hot-news", source: "rotation" });
    expect(stepIds).toContain("03f-rank-topic-candidates");
    expect(stepIds).toContain("04i-propose-angles");
    expect(stepIds).toContain("04j-select-angle");

    // A checkpoint with no decision rows means no past angles — an empty
    // history, never a crash.
    const angleInputs = angleTurnInputs(router);
    expect(angleInputs).toHaveLength(1);
    expect(angleInputs[0]!["pastAngles"]).toEqual([]);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(1);
  }, 60000);
});
