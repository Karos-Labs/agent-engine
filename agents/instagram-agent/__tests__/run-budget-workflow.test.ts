import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { RUN_BUDGET_BELIEF_KEY, type RunBudgetDecision, type RunBudgetSummary } from "../src/workflow/run-budget.js";
import { DEFAULT_RENDER_RULES } from "../src/workflow/visual-qa-pre-checks.js";
import type { InstagramCopyOutput, StyleConfig } from "../src/workflow/types.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodStyleConfig,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  copyTurnInputs,
  makePromptStore,
  qaTurnInputs,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { happyTurns, standardTurns } from "./turns.js";

/**
 * Phase 0 cost controls and default render rules, through the real workflow.
 *
 * The owner's rule (2026-09-09 amendment, binding): the budget ADAPTS and
 * never holds. An estimate over the $1.00 target adapts the plan before the
 * attempt loop and records a note; an actual spend over the $1.50 hard max
 * finishes the run on the cheapest complete path and DELIVERS, marked
 * degraded, with a ledger row; the next run reads that history and starts
 * tighter. A test that asserts a budget hold is wrong by definition.
 *
 * The render-rule proofs at the bottom are the ones WP0-4 left as todos:
 * `07h-default-render-rules-attempt-N` exists only when the frozen config
 * declares no render rules, feeds 08b a non-empty rule list, and a
 * deterministic failure on attempt 1 costs a copy redraft and nothing else.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const ctx = { runId: "budget-test", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const, metadata: {} };

function testTools(env: TestEnvironment, extra: Record<string, AgentTool> = {}): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!), ...extra };
}

async function run(env: TestEnvironment, runId: string, router: ReturnType<typeof fakeRouterSequence>, opts: { tools?: AgentToolRegistry; styleConfig?: StyleConfig } = {}) {
  const durableStore = new MemoryDurableStepStore();
  const workflowFn = createInstagramAgentWorkflow({
    tools: opts.tools ?? testTools(env),
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
    autoApprove: true,
  });
  const result = await new WorkflowEngine(durableStore).run(workflowFn, { runId, ...base });
  const steps = await durableStore.listSteps(runId);
  const stepIds = steps.map((s) => s.stepId);
  const plan = steps.find((s) => s.stepId === "02j-plan-run-budget")?.output as RunBudgetDecision | undefined;
  const deliverable = await env.store.readJson<{ deliverable: { budget: RunBudgetSummary; spendUsd: number } }>("acme", ["ledger", "deliverables", runId, "_", "instagram-carousel"]);
  return { result, steps, stepIds, plan, deliverable: deliverable?.deliverable, router };
}

/**
 * The Nth QA (`08b`) or copy (`05`) turn's own input, selected by SHAPE rather
 * than by call index: every new unconditional model turn (the trend scout, the
 * relevance judge, and now `04i-propose-angles`) shifts every index in every
 * fixture at once.
 */
function qaInputAt(router: ReturnType<typeof fakeRouterSequence>, attempt = 0): Record<string, unknown> {
  const input = qaTurnInputs(router)[attempt];
  if (input === undefined) throw new Error(`no 08b-visual-qa turn at index ${attempt}`);
  return input;
}
function copyInputAt(router: ReturnType<typeof fakeRouterSequence>, attempt = 0): Record<string, unknown> {
  const input = copyTurnInputs(router)[attempt];
  if (input === undefined) throw new Error(`no 05-write-copy turn at index ${attempt}`);
  return input;
}

describe("run budget: estimate, adapt, meter, learn — never a hold (owner's rule)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    // Several full runs against one client: enough catalog rows that the topic-floor guard never intervenes.
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 14 }, (_, i) => `budget topic ${i + 1}`) });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a fresh client's cold plan is adapted BEFORE the loop, the note names the lever, and estimate vs actual reaches the deliverable", async () => {
    const { result, plan, deliverable, stepIds } = await run(env, "budget_fresh", fakeRouterSequence(happyTurns()));
    expect(result.status).toBe("completed");
    expect(stepIds.indexOf("02j-plan-run-budget")).toBeLessThan(stepIds.indexOf("03-claim-topic"));
    // The plan is made before ANY paid step: `00b1`/`00b2` bill about $0.18 on
    // a brief refresh, so the plan sits between `00b-check-client-brief` (a
    // free store read) and the writing.
    expect(stepIds.indexOf("02j-plan-run-budget")).toBeGreaterThan(stepIds.indexOf("00b-check-client-brief"));
    expect(stepIds.indexOf("02j-plan-run-budget")).toBeLessThan(stepIds.indexOf("03c-trend-scout"));
    // A cold, uncalibrated Phase 3 carousel estimates $1.26 (03e's signal
    // pulls, 04a2's three lanes, 04a3's fetches, the angle, the re-priced
    // scout and extraction, and the @15 copy draft priced on BOTH sides of
    // the call), so the FIRST lever fires exactly as the owner's amendment
    // asks and it steps three times: an image cap of 4 reads $1.1018 and a
    // cap of 2 reads $1.0238, so the cap goes to 0 and the estimate lands at
    // $0.9458. No hold, and no attempt given up for a picture — the owner's
    // lever order is pictures first, and one delivered run's history relaxes
    // it again (the "UNDER the estimate" test below).
    expect(plan?.adaptations).toEqual(["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"]);
    expect(plan?.plan).toEqual({ maxSelfCheckAttempts: 3, generatedImagesCap: 0, evidencePulls: "full", optionalRevets: true });
    expect(plan?.note).toMatch(/^budget: estimate \$1\.\d\d > \$1\.00 → images capped at 4, images capped at 2, no generated images \(stock or text-only\) \(now \$0\.\d\d\)$/);
    expect(plan?.spentBeforePlanUsd).toBe(0);
    expect(deliverable?.budget).toMatchObject({
      crossedTarget: false,
      crossedMax: false,
      posture: "normal",
      adaptations: ["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"],
    });
    expect(deliverable?.budget.estimatedUsd).toBe(plan!.estimate.estimatedUsd);
    expect(deliverable?.budget.actualUsd).toBe(deliverable?.spendUsd);
    expect(deliverable?.budget.actualUsd).toBeGreaterThan(0);
    expect(deliverable?.budget.notes[0]).toBe(plan!.note);
    // The learning row: this run is now the client's budget history.
    const beliefs = await env.tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
    const history = ((beliefs as { result: { beliefs: Record<string, unknown> } }).result.beliefs[RUN_BUDGET_BELIEF_KEY] as { runs: Array<{ runId: string }> }).runs;
    expect(history.map((r) => r.runId)).toEqual(["budget_fresh"]);
    const budgetEvent = await env.store.readJson<{ level: string; message: string }>("acme", ["ledger", "events", "budget_fresh", "budget_fresh__budget"]);
    expect(budgetEvent?.level).toBe("info");
    expect(budgetEvent?.message).toMatch(
      /^budget: estimated \$0\.\d\d, actual \$0\.\d\d \(under target\); adaptations: images capped at 4, images capped at 2, no generated images \(stock or text-only\)$/,
    );
  });

  it("a client whose runs come in UNDER the estimate gets the full plan back, and the note says so", async () => {
    // The learning loop closing: a client whose delivered runs cost half the
    // cold worst case is planned at $0.57, so every picture and every attempt
    // is back on the table.
    await env.tools["memory.updateBeliefs"]!.execute({ diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 0.5, overrunStreak: 0, underTargetStreak: 0, runs: [] } } }, { ctx });
    const { result, plan, deliverable } = await run(env, "budget_calibrated", fakeRouterSequence(happyTurns()));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(plan?.adaptations).toEqual([]);
    expect(plan?.plan).toEqual({ maxSelfCheckAttempts: 3, generatedImagesCap: 8, evidencePulls: "full", optionalRevets: true });
    expect(plan?.note).toMatch(/^budget: estimate \$0\.\d\d ≤ \$1\.00 → full plan$/);
    expect(deliverable?.budget.adaptations).toEqual([]);
  });

  it("a client whose runs run HOT pulls further rungs of the image ladder, never a shorter run and never a hold", async () => {
    // 1.05x reads the cold plan as $1.32, so the ladder runs to the last rung
    // of the IMAGE lever — stock and text-only pictures, with all three
    // attempts intact. (The ratio moved 1.15 -> 1.08 -> 1.05 as `copyAttempt`
    // was re-priced on the @14 and then the @15 call's OUTPUT as well as its
    // input: a hotter ratio now pulls the evidence lever too, which is the
    // opposite of what this test is about. The rung ORDER — pictures before
    // evidence before attempts — is what it pins, and that is unchanged.)
    await env.tools["memory.updateBeliefs"]!.execute({ diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 1.05, overrunStreak: 0, underTargetStreak: 0, runs: [] } } }, { ctx });
    const { result, plan, deliverable } = await run(env, "budget_adapted", fakeRouterSequence(happyTurns()));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(plan?.initialEstimateUsd).toBeGreaterThan(1);
    expect(plan?.estimate.estimatedUsd).toBeLessThanOrEqual(1);
    expect(plan?.adaptations).toEqual(["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"]);
    expect(plan?.plan.generatedImagesCap).toBe(0);
    expect(plan?.plan.maxSelfCheckAttempts).toBe(3);
    // Phase 4 re-priced the non-English path (`copyLanguageBrief` +
    // `nativeJudge` x2 on a revision), which moves the post-adaptation figure
    // to exactly $1.00. `\$0\.\d\d` was never the claim — it was an accident
    // of where the old arithmetic happened to land. The claim is that the
    // ladder stopped AT OR UNDER the $1.00 target (`fits()` is `<=`), so read
    // the figure out and assert that, rather than widening the pattern to
    // `[01]` — which would also accept "$1.99", i.e. a ladder that ran every
    // rung and still never adapted enough.
    const adaptedNote = plan?.note ?? "";
    const adapted = /^budget: estimate \$(\d+\.\d\d) > \$1\.00 → images capped at 4, images capped at 2, no generated images \(stock or text-only\) \(now \$(\d+\.\d\d)\)$/.exec(adaptedNote);
    expect(adapted, `the note did not have the adapted shape: ${adaptedNote}`).not.toBeNull();
    expect(Number(adapted![1]), "the cold estimate must be over target, or there was nothing to adapt").toBeGreaterThan(1);
    expect(Number(adapted![2]), "the adapted estimate must land at or under the $1.00 target").toBeLessThanOrEqual(1);
    expect(deliverable?.budget.plan.generatedImagesCap).toBe(0);
  });

  it("actual over the hard max mid-run -> the run COMPLETES degraded with a full deliverable on the cheapest path, writes the ledger row, and the NEXT run starts tighter", async () => {
    // The copy turn reports 120k output tokens on Sonnet ($15/1M): $1.80 measured, straight through $1.00 and $1.50.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(goodCopyOutput(), { outputTokens: 120_000 }),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      // No visual-QA turn: over the hard max the optional model QA is skipped. A further call would exhaust the router and fail this test.
    ]);
    const { result, stepIds, steps, deliverable } = await run(env, "budget_overrun", router);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.renderedCount).toBe(6);
    expect(result.output.budget?.status).toBe("degraded");
    expect(result.output.budget?.reason).toMatch(/^budget: estimated \$0\.\d\d, actual \$1\.\d\d \(over the hard max\); budget: \$1\.\d\d spent at 05-write-copy-attempt-1, over the \$1\.50 hard max — finishing on the cheapest complete path/);
    // scout + research + angle + copy + vet + relevance; no visual-QA turn.
    expect(router.complete).toHaveBeenCalledTimes(6);
    // Every mandatory gate still ran; the optional model QA was consciously skipped under its own id.
    for (const id of ["06-vet-images-attempt-1", "07-self-check-attempt-1", "07b-craft-hygiene-attempt-1", "07g-relevance-attempt-1", "08-render-carousel-attempt-1", "08a2-visual-qa-pre-checks-attempt-1", "08b-visual-qa-attempt-1", "09b-deliver-and-log"]) {
      expect(stepIds).toContain(id);
    }
    const qa = steps.find((s) => s.stepId === "08b-visual-qa-attempt-1")?.output as { skipped?: string; reason?: string };
    expect(qa.skipped).toBe("budget");
    expect(qa.reason).toMatch(/hard max crossed/);
    // The deliverable is complete and carries the money story.
    expect(deliverable?.budget).toMatchObject({ crossedTarget: true, crossedMax: true, posture: "cheapest-path" });
    expect(deliverable?.budget.actualUsd).toBeGreaterThan(1.5);
    expect(deliverable?.budget.notes).toHaveLength(3);
    expect(deliverable?.budget.notes[1]).toMatch(/over the \$1\.00 target — optional work stopped/);
    expect(deliverable?.budget.notes[2]).toMatch(/over the \$1\.50 hard max — finishing on the cheapest complete path/);
    const copyLine = deliverable?.budget.lines.find((l) => l.label === "05-write-copy-attempt-1");
    expect(copyLine?.basis).toBe("measured");
    // $1.80 of output tokens plus the 100 input tokens the fixture reports.
    expect(copyLine?.measuredUsd).toBeGreaterThanOrEqual(1.8);
    const budgetEvent = await env.store.readJson<{ level: string; message: string }>("acme", ["ledger", "events", "budget_overrun", "budget_overrun__budget"]);
    expect(budgetEvent?.level).toBe("warn");
    expect(budgetEvent?.message).toMatch(
      /\(over the hard max\); adaptations: images capped at 4, images capped at 2, no generated images \(stock or text-only\); delivered degraded on the cheapest complete path$/,
    );

    // The next run reads the history and starts tight: images capped at 4 before any estimate, and the calibration ratio now reflects the overrun.
    // (A different post than run 1's, so 07d's dedupe check against the shipped-output window does not spend an attempt.)
    const secondPost: InstagramCopyOutput = {
      ...goodCopyOutput(),
      caption: "A completely separate story about how the design department reorganized their weekly critique sessions.",
      slides: goodCopyOutput().slides.map((s, i) => ({ ...s, headline: `Another take ${i + 1}`, body: `Distinct sentence ${i + 1} exploring an unrelated dimension of the quarterly workflow experiments nobody wrote about yet.` })),
    };
    const next = await run(env, "budget_after_overrun", fakeRouterSequence(happyTurns({ copy: secondPost })));
    expect(next.result.status, JSON.stringify(next.result)).toBe("completed");
    expect(next.plan?.calibration.posture).toBe("tight");
    expect(next.plan?.calibration.pastRuns).toBe(1);
    expect(next.plan?.calibration.ratio).toBeGreaterThan(1);
    expect(next.plan?.adaptations[0]).toMatch(/^started tight after 1 run\(s\) over target: images capped at 4$/);
    expect(next.plan?.plan.generatedImagesCap).toBeLessThanOrEqual(4);
    expect(next.result.status === "completed" && next.result.output.budget).toBeUndefined();
  });

  it("the image cap is an adaptation, not a hold: 4 gaps x 3 attempts asks image.generate for at most 8 images and the excess ships text-only with the budget named", async () => {
    // This proof is about the RUN-scoped cap, so the client is calibrated
    // (past runs at half the cold worst case) and the plan's own cap is the
    // full 8 — a fresh client's cold plan adapts it to 4 before the loop,
    // which the first test in this file proves separately.
    await env.tools["memory.updateBeliefs"]!.execute({ diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 0.5, overrunStreak: 0, underTargetStreak: 0, runs: [] } } }, { ctx });
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    const requested: number[] = [];
    const generate: AgentTool = {
      name: "image.generate",
      version: "1.0.0",
      async execute(args: unknown) {
        const needs = (args as { needs: Array<{ n: number; prompt: string }> }).needs;
        requested.push(needs.length);
        return {
          status: "success",
          result: { model: "gemini-2.5-flash-image", unmet: [], candidates: needs.map((g) => ({ path: pool[0]!.path, description: `generated for slide ${g.n}`, provider: "gemini", licenseConfidence: "generated" })) },
        };
      },
    } as unknown as AgentTool;
    const gaps = [1, 2, 3, 4];
    const vetWithGaps = () => ({
      selections: copy.slides.map((s) =>
        gaps.includes(s.n)
          ? { n: s.n, imagePath: null, reason: "no candidate matched", license: "n/a", rightsUsable: false, watermarkFree: false, claimMatch: 1, claimMatchReason: "nothing shows the claim" }
          : { n: s.n, imagePath: pool[0]!.path, reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "shows the claimed subject" },
      ),
    });
    /** The generate re-vet rejects every generated picture too, so the gaps stay gaps and every attempt asks again. */
    const revetRejects = () => ({
      selections: gaps.map((n) => ({ n, imagePath: null, reason: "the generated picture does not show the claim", license: "n/a", rightsUsable: false, watermarkFree: false, claimMatch: 1, claimMatchReason: "generic illustration" })),
    });
    const failingQa = { pass: false, findings: [{ ruleId: "font-hierarchy", slide: 6, passed: false, note: "the closer's headline and body are the same size" }] };
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      // attempt 1: copy, vet (4 gaps), generate re-vet, relevance, QA fails
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(revetRejects()), finalTurn(goodRelevanceVerdict()), finalTurn(failingQa),
      // attempt 2: same — the second four images spend the cap
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(revetRejects()), finalTurn(goodRelevanceVerdict()), finalTurn(failingQa),
      // attempt 3: no generate re-vet — the cap is spent, the gaps go text-only, QA passes
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
    ]);
    const { result, steps, stepIds } = await run(env, "budget_image_cap", router, { tools: testTools(env, { "image.generate": generate }) });
    expect(result.status).toBe("completed");
    expect(requested).toEqual([4, 4]);
    expect(requested.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8);
    expect(stepIds).toContain("06d-generate-images-attempt-1");
    expect(stepIds).toContain("06d-generate-images-attempt-2");
    expect(stepIds).not.toContain("06d-generate-images-attempt-3");
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-3")?.output as { downgraded: number[]; reason: string };
    expect(downgrade.downgraded).toEqual(gaps);
    expect(downgrade.reason).toContain("generation budget for this run spent (8 images)");
    // Not a hold, and not a budget note either: the cap is the plan working as designed.
    // scout + research + angle, then attempts of 5 + 5 + 4 turns.
    expect(router.complete).toHaveBeenCalledTimes(3 + 5 + 5 + 4);
  });
});

describe("default render rules through the workflow (WP0-4's workflow-level proofs)", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  it("frozen config with zero render rules -> 07h present and 08b's renderRules input carries the residue + elevated criteria (never empty)", async () => {
    env = await setupTestEnvironment();
    const { result, stepIds, router } = await run(env, "drr_defaults", fakeRouterSequence(happyTurns()));
    expect(result.status).toBe("completed");
    expect(stepIds).toContain("07h-default-render-rules-attempt-1");
    const qaInput = qaInputAt(router);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds.length).toBeGreaterThan(0);
    // goodCopyOutput's closer has neither a question mark nor a lexicon CTA, so that rule reaches the judge as residue; the deterministic passes do not.
    expect(ruleIds).toContain("default:closer-carries-cta");
    expect(ruleIds).not.toContain("default:cover-carries-device");
    expect(ruleIds).not.toContain("default:numbers-are-devices");
    // The writer was told the rules it is judged by (the copy input).
    const copyInput = copyInputAt(router);
    const copyRuleIds = ((copyInput["styleConfig"] as { rules: Array<{ id: string }> }).rules).map((r) => r.id);
    for (const rule of DEFAULT_RENDER_RULES) expect(copyRuleIds).toContain(rule.id);
  });

  it("frozen config WITH render rules -> 07h absent and 08b judges exactly the client's rules plus the elevated criteria", async () => {
    const clientRules = [{ id: "figures-are-designed", check: "render" as const, description: "Any number is rendered as a designed device, never as prose." }];
    env = await setupTestEnvironment({ styleConfig: { ...goodStyleConfig(), rules: [...goodStyleConfig().rules, ...clientRules] }, brandTokens: goodBrandTokens() });
    const { result, stepIds, router } = await run(env, "drr_client", fakeRouterSequence(happyTurns()));
    expect(result.status).toBe("completed");
    expect(stepIds).not.toContain("07h-default-render-rules-attempt-1");
    const qaInput = qaInputAt(router);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds).toContain("figures-are-designed");
    expect(ruleIds.some((id) => id.startsWith("default:"))).toBe(false);
    const copyInput = copyInputAt(router);
    const copyRuleIds = ((copyInput["styleConfig"] as { rules: Array<{ id: string }> }).rules).map((r) => r.id);
    expect(copyRuleIds.some((id) => id.startsWith("default:"))).toBe(false);
  });

  it("a default-rule failure on attempt 1 costs a copy redraft and nothing else: no render, no QA turn, then attempt 2 ships", async () => {
    env = await setupTestEnvironment();
    // Slide 4 opens with a sourced figure ("25%" is in its fact) but renders as prose on a photo slide -> default:numbers-are-devices.
    const bad: InstagramCopyOutput = { ...goodCopyOutput(), slides: goodCopyOutput().slides.map((s) => (s.n === 4 ? { ...s, body: "25% more satisfied teams after the process change, per the internal pulse survey." } : s)) };
    const router = fakeRouterSequence([
      ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: bad, vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict() }),
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const { result, steps, stepIds } = await run(env, "drr_fail_then_pass", router);
    expect(result.status).toBe("completed");
    const drr = steps.find((s) => s.stepId === "07h-default-render-rules-attempt-1")?.output as { failures: Array<{ ruleId: string; slide?: number }> };
    expect(drr.failures).toEqual([expect.objectContaining({ ruleId: "default:numbers-are-devices", slide: 4 })]);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("08b-visual-qa-attempt-1");
    expect(stepIds).toContain("08-render-carousel-attempt-2");
    expect(stepIds).toContain("08b-visual-qa-attempt-2");
    // scout + research + angle + (copy + vet + relevance) + (copy + vet + relevance + QA): zero QA turns on attempt 1.
    expect(router.complete).toHaveBeenCalledTimes(10);
    // The redraft is told WHICH rule and WHICH slide failed (prompt §16), not
    // just asked again: the SECOND copy turn is attempt 2's.
    expect(copyInputAt(router, 0)["selfCheckSteer"]).toBeUndefined();
    const steer = copyInputAt(router, 1)["selfCheckSteer"];
    expect(steer).toMatch(/default:numbers-are-devices \(slide 4\)/);
    expect(steer).toMatch(/"25%"/);
    // The remedy has to name a mechanism THIS archetype can perform. Slide 4
    // renders through the client's own `slide.html` (the `photo`/`text_only`
    // route), which declares no `{{html:device}}` slot at all, so "give the
    // slide a device" would be advice for the exact thing `withDevice` drops.
    expect(steer).toMatch(/has no device slot/);
    expect(steer).toMatch(/set this slide as a stat_callout or a comparison_card/);
    expect(steer).not.toMatch(/give the slide a device carrying that figure/);
  });
});

