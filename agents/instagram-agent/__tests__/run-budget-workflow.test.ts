import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { MIN_GENERATED_IMAGES_PER_RUN, RUN_BUDGET_BELIEF_KEY, type RunBudgetDecision, type RunBudgetSummary, MAX_RUN_SPEND_USD} from "../src/workflow/run-budget.js";
import { DEFAULT_RENDER_RULES } from "../src/workflow/visual-qa-pre-checks.js";
import type { InstagramCopyOutput, StyleConfig } from "../src/workflow/types.js";
import { copyTurnInputs, fakeRenderCarousel, fakeRouterSequence, finalTurn, fixtureHeadline, goodBrandTokens, goodCopyOutput, goodImageCandidatePool, goodImageVettingOutput, goodRelevanceVerdict, goodResearchOutput, goodStyleConfig, goodTrendScoutOutput, goodVisualQaOutput, makePromptStore, qaTurnInputs, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS, happyTurns, standardTurns } from "./turns.js";

/**
 * Phase 0 cost controls and default render rules, through the real workflow.
 *
 * The owner's rule (2026-09-09 amendment, binding): the budget ADAPTS and
 * never holds. An estimate over the $1.80 target adapts the plan before the
 * attempt loop and records a note; an actual spend over the $2.60 hard max
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
    // A cold, uncalibrated Phase 5 carousel estimates $1.3563 (03e's signal
    // pulls, 04a2's three lanes, 04a3's fetches, the angle, the re-priced
    // scout and extraction, the value judge and packager, and the @17 copy
    // draft priced on BOTH sides of the call), so the FIRST lever fires
    // exactly as the owner's amendment asks and it steps three times: an image
    // cap of 4 reads $1.2003 and a cap of 2 reads $1.1223, so the cap goes to
    // 0 — and at $1.0143 that is STILL over target, so the second rung fires
    // and reduced trend evidence lands it at $0.9933.
    //
    // Phase 5 is where a fourth rung starts firing on a cold ENGLISH run, and
    // the fourth rung is evidence, not attempts. @17's prompt is +16,300
    // characters, +$0.0124 an attempt, +$0.037 across three — more than the
    // $0.0143 of headroom the cap-0 plan had. No hold, and no attempt given up
    // for a picture or for a trend query: the two rungs that cost the post
    // something are still untouched, and one delivered run's history relaxes
    // all of it again (the "UNDER the estimate" test below).
    //
    // PHASE 5.5 RE-BASELINE (spec §2 A1). The ladder is re-ordered so that
    // OPTIONAL work goes first and the image cap goes LAST with a floor of
    // two. The cold English plan now costs $1.95 against a $1.80 target and
    // fits after a single rung whose own name is "optional", landing at $1.75
    // WITH ALL EIGHT GENERATED IMAGES STILL ON THE TABLE.
    //
    // The three lines this list used to open with — `images capped at 4`,
    // `images capped at 2`, `no generated images (stock or text-only)` — were
    // rungs 1 to 3, and they are why all six prep runs of 2026-09-16 shipped
    // a post with no pictures in it. The last of them is now unreachable from
    // any plan.
    const COLD_ADAPTATIONS = ["optional rescue re-vets skipped"];
    expect(plan?.adaptations).toEqual(COLD_ADAPTATIONS);
    expect(plan?.plan).toEqual({ maxSelfCheckAttempts: 3, generatedImagesCap: 8, evidencePulls: "full", optionalRevets: false, duplicateVisionPasses: true });
    expect(plan?.note).toMatch(/^budget: estimate \$1\.\d\d > \$1\.80 → optional rescue re-vets skipped \(now \$1\.\d\d\)$/);
    expect(plan?.spentBeforePlanUsd).toBe(0);
    expect(deliverable?.budget).toMatchObject({
      crossedTarget: false,
      crossedMax: false,
      posture: "normal",
      adaptations: COLD_ADAPTATIONS,
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
    expect(budgetEvent?.message).toMatch(/^budget: estimated \$1\.\d\d, actual \$\d\.\d\d \(under target\); adaptations: optional rescue re-vets skipped$/);
    // The ledger's adaptation list is the reviewer's copy of the plan's, so it
    // is asserted to be that list rather than a hand-retyped one — the two
    // drifting apart is how a reviewer ends up reading last phase's ladder.
    expect(budgetEvent?.message).toContain(COLD_ADAPTATIONS.join(", "));
  });

  it("a client whose runs come in UNDER the estimate gets the full plan back, and the note says so", async () => {
    // The learning loop closing: a client whose delivered runs cost half the
    // cold worst case is planned at $0.57, so every picture and every attempt
    // is back on the table.
    await env.tools["memory.updateBeliefs"]!.execute({ diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 0.5, overrunStreak: 0, underTargetStreak: 0, runs: [] } } }, { ctx });
    const { result, plan, deliverable } = await run(env, "budget_calibrated", fakeRouterSequence(happyTurns()));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(plan?.adaptations).toEqual([]);
    expect(plan?.plan).toEqual({ maxSelfCheckAttempts: 3, generatedImagesCap: 8, evidencePulls: "full", optionalRevets: true, duplicateVisionPasses: true });
    expect(plan?.note).toMatch(/^budget: estimate \$0\.\d\d ≤ \$1\.80 → full plan$/);
    expect(deliverable?.budget.adaptations).toEqual([]);
  });

  it("a client whose runs run HOT spends EVERY optional rung before it will shorten the run — never a shorter run, never a hold", async () => {
    // 1.01x reads the cold plan as $1.3699 and the ladder runs all the way to
    // the optional-rescue rung: no generated images, reduced trend evidence,
    // rescue re-vets and the lead-claim verification off — and **all three
    // drafting attempts intact**, landing at $0.8931.
    //
    // This is RFC-18 §7.3's rung swap seen at the workflow level, and it is
    // the property worth pinning here rather than "how many rungs fire": a hot
    // client gives up every piece of OPTIONAL work the run has before it gives
    // up a draft. Until Phase 5 the order was the other way round, and a
    // client at this ratio lost an attempt while $0.109 of work whose own name
    // is "optional" sat unspent. Phase 5's value gate rides the attempt loop,
    // so that order would have paid for the value gate by taking away the
    // redraft the value gate exists to ask for.
    //
    // (The ratio has not moved since RFC-16; what moved is how far down the
    // ladder it reaches. It walked 1.15 -> 1.08 -> 1.05 -> 1.01 across the
    // @14/@15 output re-prices and RFC-16's concept line, and @17's measured
    // +$0.0124 an attempt now takes even the EMPTY-history ratio of 1.0 past
    // the image rungs. Do not walk the ratio again to keep an old rung count:
    // the rung count is not the invariant, the rung ORDER is.)
    //
    // PHASE 5.5 RE-BASELINE (spec §2 A1). The ratio moved 1.01 -> 1.25 and the
    // rung ORDER — which is this test's stated invariant, not the rung count —
    // is now the reverse of what it was: optional work first, images LAST, and
    // the image rung stops at a floor of two rather than at zero. At 1.01 the
    // new ladder fits after a single rung, which would have made this test
    // assert nothing; 1.25 is the ratio that walks the whole ladder, so the
    // assertion still reads "every optional rung is spent and the run still
    // gets three drafts" AND now also "and it still buys two pictures".
    await env.tools["memory.updateBeliefs"]!.execute({ diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 1.25, overrunStreak: 0, underTargetStreak: 0, runs: [] } } }, { ctx });
    const { result, plan, deliverable } = await run(env, "budget_adapted", fakeRouterSequence(happyTurns()));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(plan?.initialEstimateUsd).toBeGreaterThan(1.8);
    // ── AND IT NO LONGER FITS, WHICH IS THE POINT RATHER THAN A REGRESSION. ──
    //
    // This used to assert the ladder brought a hot client back under $1.80.
    // Since `MIN_GENERATED_IMAGES_PER_RUN` moved 2 -> 3 it cannot: three
    // pictures cost more than the target leaves, on this shape, at this
    // ratio. That is `quality-before-cost` and `budgets-adapt-never-hold`
    // meeting, and what the rules actually promise is asserted here instead —
    // the run PROCEEDS, over target, having spent every optional rung first,
    // and says so.
    expect(plan?.estimate.estimatedUsd).toBeGreaterThan(1.8);
    expect(plan?.estimate.estimatedUsd).toBeLessThan(MAX_RUN_SPEND_USD);
    expect(plan?.note).toMatch(/running anyway/);
    expect(plan?.adaptations).toEqual([
      "optional rescue re-vets skipped",
      "trend evidence reduced to the one cached industry query",
      "duplicate vision passes skipped (candidates and slides are inspected once, not once per attempt)",
      "images capped at 4",
      "images capped at 3 — the floor no lever may cross",
    ]);
    // THE FLOOR, not zero. This is the single number the owner's "there are no
    // images although we said there would be" complaint reduces to.
    expect(plan?.plan.generatedImagesCap).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    // THE assertion of this test. Every optional rung is spent and the run
    // still gets three drafts. Swap the last two rungs back in `run-budget.ts`
    // and this reads 2 with `optionalRevets` still true — an attempt traded
    // for work nobody asked to keep.
    expect(plan?.plan.maxSelfCheckAttempts).toBe(3);
    expect(plan?.plan.optionalRevets).toBe(false);
    expect(plan?.adaptations).not.toContain("one return to step 05 instead of two");
    expect(plan?.adaptations.indexOf("optional rescue re-vets skipped")).toBeGreaterThan(-1);
    // Phase 4 re-priced the non-English path (`copyLanguageBrief` +
    // `nativeJudge` x2 on a revision), which moves the post-adaptation figure
    // to exactly $1.00. `\$0\.\d\d` was never the claim — it was an accident
    // of where the old arithmetic happened to land. The claim is that the
    // ladder stopped AT OR UNDER the $1.00 target (`fits()` is `<=`), so read
    // the figure out and assert that, rather than widening the pattern to
    // `[01]` — which would also accept "$1.99", i.e. a ladder that ran every
    // rung and still never adapted enough.
    //
    // THE NOTE'S SHAPE CHANGED WITH THE FLOOR, and both shapes are real. When
    // the ladder can reach the target the note ends "(now $X)"; when the
    // picture floor costs more than the target leaves, it ends "still $X on
    // the tightest plan — running anyway". Since the floor moved 2 -> 3 this
    // shape is the second one, and asserting only the first would have read
    // as a bug in the note rather than as the trade it records.
    const adaptedNote = plan?.note ?? "";
    const overrun = /^budget: estimate \$(\d+\.\d\d) > \$1\.80 → (?:.+); still \$(\d+\.\d\d) on the tightest plan — running anyway/.exec(adaptedNote);
    expect(overrun, `the note did not have the over-target shape: ${adaptedNote}`).not.toBeNull();
    expect(Number(overrun![1]), "the cold estimate must be over target, or there was nothing to adapt").toBeGreaterThan(1.8);
    // Over target and UNDER the hard max: the run is expensive, not runaway.
    expect(Number(overrun![2])).toBeGreaterThan(1.8);
    expect(Number(overrun![2])).toBeLessThan(MAX_RUN_SPEND_USD);
    // And the cold estimate is still the bigger number — the ladder did work.
    expect(Number(overrun![1])).toBeGreaterThan(Number(overrun![2]));
    expect(deliverable?.budget.plan.generatedImagesCap).toBe(MIN_GENERATED_IMAGES_PER_RUN);
  });

  it("actual over the hard max mid-run -> the run COMPLETES degraded with a full deliverable on the cheapest path, writes the ledger row, and the NEXT run starts tighter", async () => {
    // The copy turn reports 220k output tokens on Sonnet ($15/1M): $3.30
    // measured, straight through the $1.80 target and the $2.60 hard max.
    // (120k was the figure against the pre-Phase-5.5 $1.00/$1.60 pair; the
    // ceilings moved for the reason `concept-budget-and-art.test.ts` records,
    // so the fixture that has to cross them moved with them.)
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput(), { outputTokens: 220_000 }),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      // No visual-QA turn and no value-judge turn: over the hard max both
      // optional model judgements are skipped. The last turn is the PACKAGER's.
      //
      // Phase 5.5: it used to be a `VALUE_TURN_NO_FINDINGS` that `07j` never
      // consumed, so `08c-package-post` pulled a value verdict, failed its
      // schema, and the run shipped with no hashtags — the exact 2026-09-16
      // defect. That was invisible while a failed package had no re-ask; now
      // it buys one (spec §6 G2), so the queue says honestly which turn each
      // call consumes and the count below stays at seven.
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const { result, stepIds, steps, deliverable } = await run(env, "budget_overrun", router);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.renderedCount).toBe(6);
    expect(result.output.budget?.status).toBe("degraded");
    expect(result.output.budget?.reason).toMatch(/^budget: estimated \$1\.\d\d, actual \$3\.\d\d \(over the hard max\); budget: \$3\.\d\d spent at 05-write-copy-attempt-1, over the \$2\.60 hard max — finishing on the cheapest complete path/);
    // scout + research + angle + copy + vet + relevance + packager; no
    // visual-QA turn and no value-judge turn.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(8);
    // And the packaging re-ask was NOT bought, because the first call worked:
    // the unconditional retry (spec §6 G2) is a rescue, not a second call the
    // cheapest path pays for on every run.
    expect(stepIds).not.toContain("08c-package-post-retry");
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
    expect(deliverable?.budget.notes[1]).toMatch(/over the \$1\.80 target — optional work stopped/);
    expect(deliverable?.budget.notes[2]).toMatch(/over the \$2\.60 hard max — finishing on the cheapest complete path/);
    const copyLine = deliverable?.budget.lines.find((l) => l.label === "05-write-copy-attempt-1");
    expect(copyLine?.basis).toBe("measured");
    // $3.30 of output tokens plus the 100 input tokens the fixture reports.
    expect(copyLine?.measuredUsd).toBeGreaterThanOrEqual(3.3);
    const budgetEvent = await env.store.readJson<{ level: string; message: string }>("acme", ["ledger", "events", "budget_overrun", "budget_overrun__budget"]);
    expect(budgetEvent?.level).toBe("warn");
    expect(budgetEvent?.message).toMatch(/\(over the hard max\); adaptations: optional rescue re-vets skipped; delivered degraded on the cheapest complete path$/);

    // The next run reads the history and starts tight: images capped at 4 before any estimate, and the calibration ratio now reflects the overrun.
    // (A different post than run 1's, so 07d's dedupe check against the shipped-output window does not spend an attempt.)
    const secondPost: InstagramCopyOutput = {
      ...goodCopyOutput(),
      caption: "A completely separate story.\nThe design department reorganized their weekly critique sessions.",
      slides: goodCopyOutput().slides.map((s, i) => ({ ...s, headline: fixtureHeadline(i, "another take"), body: `Distinct sentence ${i + 1} exploring an unrelated dimension of the quarterly workflow experiments nobody wrote about yet.` })),
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
      finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      // attempt 1: copy, vet (4 gaps), generate re-vet, relevance, QA fails
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(revetRejects()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(failingQa),
      // attempt 2: same — the second four images spend the cap
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(revetRejects()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(failingQa),
      // attempt 3: no generate re-vet — the cap is spent, the gaps go text-only, QA passes
      finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
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
    // Phase 5 (RFC-18 §7.2) moved WHICH budget lever speaks first on this
    // shape, without moving what it does. Four gaps across three attempts with
    // the rescue re-vet is the most expensive run this suite builds, and the
    // extra ~$0.04 an attempt now takes the METER past target during attempt 3
    // — so the slide is downgraded by the target-crossed lever rather than by
    // the per-run generated-image cap. The claim under test is unchanged and
    // still asserted above: at most 8 images asked for, no generation on
    // attempt 3, and a COMPLETED run. What this line pins is that a reader is
    // told a BUDGET took the picture away, which is the difference between an
    // adaptation and a silent hole.
    expect(downgrade.reason).toMatch(/generation budget for this run spent \(8 images\)|run budget target crossed/);
    // Not a hold, and not a budget note either: the cap is the plan working as designed.
    // scout + research + angle, then attempts of 6 + 6 + 5 turns, then the
    // packager. Each attempt gained Phase 5's value judge (`07j`), and the
    // delivering round gained one `08c-package-post` call after the loop.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per
    // REVISION (outside the attempt loop, so a redraft never re-pays).
    // 2026-09-18: + one `05r-revise-copy` per RETRY. Attempts 2 and 3 edit the
    // previous draft instead of rewriting it, so each costs a revise turn on
    // top of whatever it then buys.
    expect(router.complete).toHaveBeenCalledTimes(3 + 1 + 6 + 6 + 5 + 1 + 2);
  });

  /**
   * ════════════════════════════════════════════════════════════════════════
   * THE IMAGE FLOOR, OBSERVED THROUGH THE REAL WORKFLOW
   * ════════════════════════════════════════════════════════════════════════
   *
   * `image-floor-never-cut.test.ts` unit-tests `partitionGaps` and simulates
   * the three generation gates with a private copy of their shape. It cannot
   * see the workflow, and for a while it read as though it could: change the
   * three `skipOptional(...)` calls in
   * `create-instagram-agent-workflow.ts` back to the bare `continue` they
   * replaced and every assertion in that file stays green — on the owner's
   * loudest complaint, *"אין תמונות למרות שאמרנו שיהיו"*.
   *
   * These two cases drive the real workflow. They share one fixture, because
   * the two defects they pin are two halves of one run: a plan that pulled the
   * optional rung must still buy the guaranteed images, and the floor step must
   * then judge what LANDED rather than what was attempted.
   *
   * The client is deliberately FRESH — no `RUN_BUDGET_BELIEF_KEY` seeded — so
   * the cold estimate is over the $1.80 target and `planRunBudget` pulls rung 1,
   * `optionalRevets: true → false`. That is the exact plan shape all six prep
   * runs of 2026-09-16 ran under, and the first gate in the loop reads it.
   */
  describe("the generation guarantee and the floor step, through the real workflow", () => {
    /** Four of the six slides lose their picture at `06`; the generated frames are then refused too. */
    function imageFixture() {
      const copy = goodCopyOutput();
      const pool = goodImageCandidatePool();
      const gaps = [1, 2, 3, 4];
      /** Every `image.generate` call's need count, in order. */
      const requested: number[][] = [];
      const generate: AgentTool = {
        name: "image.generate",
        version: "1.0.0",
        async execute(args: unknown) {
          const needs = (args as { needs: Array<{ n: number; prompt: string }> }).needs;
          requested.push(needs.map((need) => need.n));
          return {
            status: "success",
            result: {
              model: "gemini-2.5-flash-image",
              unmet: [],
              candidates: needs.map((g) => ({ path: pool[0]!.path, description: `generated for slide ${g.n}`, provider: "gemini", licenseConfidence: "generated" })),
            },
          };
        },
      } as unknown as AgentTool;
      const vetWithGaps = () => ({
        selections: copy.slides.map((s) =>
          gaps.includes(s.n)
            ? { n: s.n, imagePath: null, reason: "no candidate matched", license: "n/a", rightsUsable: false, watermarkFree: false, claimMatch: 1, claimMatchReason: "nothing shows the claim" }
            : { n: s.n, imagePath: pool[0]!.path, reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "shows the claimed subject" },
        ),
      });
      /** THE VET REFUSES EVERY GENERATED FRAME — the case `06h`'s own doc comment names and could not see. */
      const revetRejects = () => ({
        selections: gaps.map((n) => ({ n, imagePath: null, reason: "the generated picture does not show the claim", license: "n/a", rightsUsable: false, watermarkFree: false, claimMatch: 1, claimMatchReason: "generic illustration" })),
      });
      const failingQa = { pass: false, findings: [{ ruleId: "font-hierarchy", slide: 6, passed: false, note: "the closer's headline and body are the same size" }] };
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()),
        finalTurn(goodResearchOutput()),
        finalTurn(goodAngleProposal()),
        finalTurn(DEFAULT_ENTITIES_TURN),
        // attempt 1: copy, vet (4 gaps), generate re-vet (refuses all), relevance, value, QA fails
        finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(revetRejects()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(failingQa),
        // attempt 2: the run's whole generation guarantee is already spent, so no generate call and no re-vet turn
        finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(failingQa),
        // attempt 3: ships
        finalTurn(copy), finalTurn(vetWithGaps()), finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      return { copy, gaps, requested, generate, router };
    }

    it("a plan that turned optional rescue work off still generates the run's guaranteed images", async () => {
      const { requested, generate, router } = imageFixture();
      const { result, plan, stepIds } = await run(env, "floor_guarantee", router, { tools: testTools(env, { "image.generate": generate }) });
      expect(result.status).toBe("completed");

      // ── THE PREMISE, ASSERTED BEFORE THE CONCLUSION. ──
      // Without this the case would pass against a plan that never pulled the
      // rung, which is a test of nothing.
      expect(plan?.plan.optionalRevets).toBe(false);

      // THE CLAIM. The gate whose pre-phase form was a bare `continue` over the
      // whole tier now skips the OPTIONAL gaps and falls through with the
      // guarantee. Four gaps, two guaranteed.
      expect(stepIds).toContain("06d-generate-images-attempt-1");
      expect(requested).toHaveLength(1);
      expect(requested[0]).toHaveLength(MIN_GENERATED_IMAGES_PER_RUN);
      // Lowest-first within the tier — an early picture earns the swipe — and
      // this run carries no concept, which `04m` declines on the canonical story.
      expect(requested[0]).toEqual([1, 2, 3, 4].slice(0, MIN_GENERATED_IMAGES_PER_RUN));

      // ── THE TWO CONTROLS, both in-band. ──
      // A pre-phase `continue` produces ZERO generate calls; a partition that
      // returned everything as optional produces the same. Either would fail here.
      expect(requested[0]!.length).toBeGreaterThan(0);
      // And a gate that had simply stopped gating would have asked for all four.
      expect(requested[0]!.length).toBeLessThan(4);
      // The guarantee is per RUN, not per attempt: attempt 2 buys none.
      expect(stepIds).not.toContain("06d-generate-images-attempt-2");
    });

    it("`06h` reports the floor on pictures that LANDED, so a run whose generated frames were all refused is not `ok`", async () => {
      const { requested, generate, router } = imageFixture();
      const { result, steps } = await run(env, "floor_outcome", router, { tools: testTools(env, { "image.generate": generate }) });
      expect(result.status).toBe("completed");

      // THE PREMISE: generation ran and produced the guarantee's worth of
      // candidates, and the vet then refused every one of them.
      expect(requested[0]).toHaveLength(MIN_GENERATED_IMAGES_PER_RUN);
      const floor = steps.find((s) => s.stepId === "06h-imagery-floor-check-attempt-1")?.output as
        | { action: string; pictureSlides: number; generated: number; reason?: string }
        | undefined;
      expect(floor, "06h did not run").toBeDefined();
      expect(floor!.generated).toBe(MIN_GENERATED_IMAGES_PER_RUN);

      // THE CLAIM. `pictureSlides` is the OUTCOME and it is under the floor, so
      // the step must not say the floor is met. Before this fix the pass
      // condition was `withPicture >= MIN_PICTURE_SLIDES || generatedSoFar >=
      // MIN_GENERATED_IMAGES_PER_RUN`, and the right-hand disjunct — an INTENT
      // counter incremented from the tool's candidate count before anything vets
      // it — made this exact run report `{ action: "ok", pictureSlides: 2 }`.
      expect(floor!.pictureSlides).toBeLessThan(3);
      expect(floor!.action).not.toBe("ok");
      expect(floor!.action).toBe("unfilled");
      // And it says WHY, in the run's own numbers, rather than silently passing.
      expect(floor!.reason).toContain(`already generated ${MIN_GENERATED_IMAGES_PER_RUN} image(s)`);
      // It never holds: the run completed above, and the slides took the
      // text-only downgrade exactly as they did before.
      const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as { downgraded: number[] } | undefined;
      expect(downgrade?.downgraded).toEqual([1, 2, 3, 4]);
    });
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
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    // 2026-09-18: +1 per RETRY for `05r-revise-copy`, which every attempt after the first buys instead of a full redraft.
    expect(router.complete).toHaveBeenCalledTimes(15);
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

/**
 * ── A RUNG THAT LOWERS THE ESTIMATE AND CHANGES NO WORK IS A PHANTOM SAVING. ──
 *
 * `duplicateVisionPasses` is the one lever the owner's cost ruling names as
 * genuinely optional: *"duplicate vision passes, redundant re-vets"*. It was
 * implemented on the ESTIMATOR only — `estimateRunCost` multiplies the
 * pool-inspection term by the attempt count when the flag is set, and
 * `planRunBudget` pulls the rung AHEAD of the image cap — while
 * `05c-inspect-candidates-attempt-N` and `08a4-inspect-rendered-attempt-N`
 * re-inspected on every attempt regardless. So a plan was made to "fit" by a
 * saving of 2 x $0.018 the run never made, and the image cap then stayed high
 * on an estimate that was wrong, in a phase whose whole thesis is that the
 * meter was lying.
 *
 * This is a SOURCE scan and it is the cheap half on purpose: what went wrong
 * was not a subtle behaviour, it was that the name appeared in exactly one file
 * and its own tests (`grep -rn duplicateVisionPasses` over the repo). The
 * behaviour itself is asserted by the caches' own comments at the two step
 * sites, and by the fact that a plan that pulls this rung now skips a candidate
 * it has already described and a plate whose slides-data has not changed.
 */
describe("the budget's optional rungs are read by the run, not only by the estimate", () => {
  const WORKFLOW = nodePath.resolve(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts");

  it("the workflow reads every lever `planRunBudget` can pull", () => {
    const source = readFileSync(WORKFLOW, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const lever of ["duplicateVisionPasses", "optionalRevets", "generatedImagesCap", "evidencePulls"] as const) {
      expect(
        source.includes(`budgetPlan.${lever}`),
        `\`${lever}\` is a rung \`planRunBudget\` pulls to make a plan fit, and no step in the workflow reads it — ` +
          "so the estimate goes down and the work does not. Either the lever is implemented or the rung comes out of the plan.",
      ).toBe(true);
    }
  });
});
