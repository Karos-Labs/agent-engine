import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry, CompletionResult } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { DEFAULT_RUN_SHAPE, planRunBudget } from "../src/workflow/run-budget.js";
import { VALUE_MAX_RETURNS } from "../src/workflow/value-gate.js";
import { checkValueSignals } from "../src/workflow/value-signals.js";
import { factCardsForPrompt } from "../src/workflow/fact-cards.js";
import { DEFAULT_ENTITIES_TURN, standardTurns } from "./turns.js";
import {
  SIX_RESEARCH_FACTS,
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
  setupTestEnvironment,
  type TestEnvironment,
  weakCopyOutput,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * RFC-18 §5.7 — **TERMINATION BY DELIVERY.**
 *
 * The value gate is the one Phase 5 step that can send a draft back to `05`,
 * and that single fact is what makes this file necessary rather than tidy.
 * `create-instagram-agent-workflow.ts`'s attempt loop ends in
 * `throw new WorkflowHeld(...)` whenever it exits without `finalOutcomeOk`, so
 * **every `continue` on the last attempt is a hold** — and the owner's standing
 * amendment forbids a judgment gate producing one outright. A gate that refuses
 * a post and then holds the run has delivered nothing, and a person cannot
 * reject what they never received.
 *
 * So the termination table has nine rows and not one of them is `held` or
 * `failed`. This file pins the four that could plausibly regress into one:
 *
 * 1. below the bar on the FINAL attempt -> `completed`, `value.status:
 *    "below-bar"`, exactly one ledger warn (row 6);
 * 2. a judge that did not complete -> `completed`, `value.status: "unjudged"`,
 *    and **no redraft burned** — it fails OPEN, the relevance judge's posture
 *    (row 3);
 * 3. below the bar with no axis improved -> the next attempt is NOT bought
 *    (row 5);
 * 4. below the bar with an attempt left -> the draft really does go back, which
 *    is the OTHER side of (1) and the reason (1) is not vacuous.
 *
 * ## How (1) is known to be able to fail
 *
 * Two ways, and the second is the one that survives a parallel edit.
 *
 * - Remove the `isFinalAttempt` guard at `07j` and the workflow throws
 *   `WorkflowHeld`: the `continue` runs on the last attempt, the loop exits
 *   with `finalOutcomeOk` still false, and `result.status` is `"held"`.
 * - Without touching a line of the workflow: case (4) in this file queues the
 *   SAME below-bar verdict against a plan with an attempt left and asserts the
 *   draft goes back to `05`. If the return path were dead, (4) fails; if the
 *   guard were absent, (1) fails. The pair brackets the guard from both sides,
 *   and neither side can pass by accident.
 */

/** Malformed against the value judge's own flat output schema -> `content_fail` -> `runValueJudge`'s `error`. */
const JUDGE_ERROR_TURN = { nonsense: true };

/**
 * The draft every case here queues.
 *
 * It is `goodCopyOutput()` — but only because the shared fixture was FIXED
 * during this cycle, and that is worth a sentence because it is the reason this
 * file is short. As written before Phase 5, `goodCopyOutput()` set every
 * slide's `body` to `fact.claim` (the research card's own sentence, character
 * for character) and gave all six slides the headline `Finding #N`. `07i`
 * refuses that twice over: `checkSourceProse` reports *"slide 1's body
 * reproduces 8 consecutive words of a fact card"*, and six identical headline
 * openers are exactly what `checkRhythm` was written to catch.
 *
 * **The floor was right and the fixture was what had to move.** A test fixture
 * that models the source's prose with a picture behind it was always modelling
 * the defect this phase exists to refuse. That old fixture survives as
 * `weakCopyOutput()`, which is the deliberate other side of it — a draft that
 * passes every pre-Phase-5 gate and that `07i` still says no to.
 */
const valueSafeCopy = goodCopyOutput;

/**
 * A verdict below the bar on every reading of it: three fails and a weak, each
 * carrying a fix so `normaliseValueVerdict`'s rule 2 cannot revert it to
 * `pass`, and each target matching `^(cover|caption|slide:[1-8])$` so the
 * misalignment rule cannot discard it either.
 *
 * Deliberately not a single-axis refusal. `newFact` is demoted to ADVISORY for
 * a thinly-grounded brief or a fact set with fewer than two specific-carrying
 * cards (§5.4 rule 3), so a fixture that refused on `newFact` alone would be a
 * fixture whose verdict depends on the research fixture's arithmetic. `position:
 * "fail"` refuses under clause (1) of `decideValue` whatever the relaxation
 * does.
 */
function belowBarTurn(): Record<string, unknown> {
  return {
    newFact: "fail",
    position: "fail",
    payload: "weak",
    action: "fail",
    fixAxes: ["newFact", "position", "payload", "action"],
    fixTargets: ["slide:3", "cover", "slide:2", "caption"],
    fixInstructions: [
      "Fact card 4 carries the figure; put that number and its period on slide 3 and drop the general claim.",
      "Assert the cause: name the single failure this client sees most often and say plainly that age is not it.",
      "Slide 2 states a benefit with no consequence; say what the downtime costs on a Friday, in money or in covers.",
      "Ask for one thing the reader can do in a minute and say what they get back for doing it.",
    ],
    keepLine: "Nothing here is wrong and nothing here is worth saving: every sentence would be true for any vendor in this trade.",
  };
}

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/**
 * Force the run's attempt ceiling by CHECKPOINTING `02j-plan-run-budget`
 * before the engine ever runs it.
 *
 * `planRunBudget`'s ladder floors `maxSelfCheckAttempts` at 2 and there is no
 * input, option or environment variable that takes it lower — deliberately, and
 * RFC-18 §7.3 makes that floor load-bearing. But "the final attempt never
 * returns" is a claim about the LAST attempt whatever its number is, and
 * proving it at 1 costs one copy call instead of three.
 *
 * A pre-seeded checkpoint is the honest lever for that: it is the same
 * mechanism a RESUME uses, the step's own body never runs, and the plan the
 * loop reads is a real `RunBudgetDecision` with one field replaced rather than
 * a hand-built object that could drift from the type.
 */
async function seedAttemptCeiling(store: MemoryDurableStepStore, runId: string, maxSelfCheckAttempts: number): Promise<void> {
  const decision = planRunBudget({ ...DEFAULT_RUN_SHAPE });
  await store.saveStep(runId, {
    stepId: "02j-plan-run-budget",
    kind: "code",
    status: "completed",
    output: { ...decision, plan: { ...decision.plan, maxSelfCheckAttempts } },
    startedAt: Date.now(),
    completedAt: Date.now(),
  });
}

describe("07j — the value gate terminates by DELIVERING, never by holding (RFC-18 §5.7)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
  }

  /** The run-level turns every case here shares: they are bought once per run (or, for the angle, once per revision), never per attempt. */
  function runPrefix(): Array<() => CompletionResult<unknown>> {
    return [finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN)];
  }

  it("ROW 6 — below the bar on the FINAL attempt SHIPS: status completed, value below-bar, ONE ledger warn, and no WorkflowHeld", async () => {
    const params = { runId: "instagram_run_value_final", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    // ONE attempt: every `continue` from here on is the loop exiting without
    // `finalOutcomeOk`, which is the `WorkflowHeld` this row exists to refuse.
    await seedAttemptCeiling(durableStore, params.runId, 1);

    const router = fakeRouterSequence([
      ...runPrefix(),
      ...standardTurns({
        copy: valueSafeCopy(),
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        valueJudge: belowBarTurn(),
        qa: goodVisualQaOutput(),
      }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(result.status, JSON.stringify(result)).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07j-value-judge-attempt-1");
    // The judge refused and the draft still rendered and still delivered. A
    // second copy call would mean the ceiling was not applied and this case is
    // not testing what it says it is.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("09b-deliver-and-log");

    // The verdict reaches the reviewer through the one shared `groundingFor`,
    // so the PERSISTED record carries exactly what the gate payload showed.
    // `value` rides `grounding` (§5.8) and `post` rides the TOP LEVEL (§6.6,
    // §12). The shape of this annotation is itself part of the assertion.
    const deliverables = await env.store.listJson<{
      deliverable?: {
        grounding?: {
          value?: { status: string; stage: string; axes?: Record<string, string>; fixes?: unknown[]; reason?: string };
          post?: unknown;
        };
        post?: { status: string; hashtags?: string[]; altText?: unknown[] };
      };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const value = deliverables[0]!.data.deliverable?.grounding?.value;
    expect(value?.status).toBe("below-bar");
    expect(value?.stage).toBe("judge");
    expect(value?.axes).toEqual({ newFact: "fail", position: "fail", payload: "weak", action: "fail" });
    // The four named remedies travel with it: the difference between telling a
    // reviewer a post is weak and showing them the sentences that would fix it.
    expect(value?.fixes).toHaveLength(4);

    // ── The other half of this package: the turn fixtures and the packager agree ──
    //
    // Nothing in this block queued a `postPackager` fixture. `standardTurns`
    // emitted `DEFAULT_PACKAGE_TURN` for it, because a delivering run ALWAYS
    // buys `08c-package-post` and an absent key here means "the packager wrote
    // a clean package", not "no turn" (RFC-18 §12). If the default's shape and
    // `PostPackageSchema` ever disagreed, the packager would `content_fail`,
    // `08c-package-post-retry` would consume a turn nobody queued, and every
    // positional fixture downstream would slide by one. That is the coupling
    // this assertion pins, and it is why the default and the wiring had to land
    // in the same change.
    expect(stepIds).toContain("08c-package-post");
    expect(stepIds).not.toContain("08c-package-post-retry");
    // TOP LEVEL, not under `grounding`. RFC-18 §12 makes `deliverable.post` a
    // cross-repo contract: the portal PR is written from the RFC in another
    // repo and reads exactly this path. Pinned here so a refactor that tucks
    // the post back inside `grounding` fails in this repo rather than silently
    // showing no hashtags in that one.
    expect(deliverables[0]!.data.deliverable?.grounding?.post).toBeUndefined();
    const post = deliverables[0]!.data.deliverable?.post;
    expect(post?.status).toBe("complete");
    expect(post?.hashtags).toHaveLength(5);
    // Stored BARE. The portal prepends its own `#`, and LinkedIn's fixture
    // storing them pre-hashed is what double-hashes them in the UI today.
    for (const tag of post?.hashtags ?? []) expect(tag.startsWith("#")).toBe(false);
    expect(post?.altText).toHaveLength(valueSafeCopy().slides.length);

    // EXACTLY ONE warn, keyed so a resume writes one row rather than a second.
    const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", ["ledger", "events", params.runId]);
    const valueWarns = events.filter((e) => e.data.eventId.includes("__value-"));
    expect(valueWarns).toHaveLength(1);
    expect(valueWarns[0]!.data.eventId).toBe(`${params.runId}__value-below-bar-r0`);
    expect(valueWarns[0]!.data.level).toBe("warn");
  }, 60000);

  it("THE OTHER SIDE of row 6 — the same verdict WITH an attempt left really does go back to 05, so the guard above is what stops it", async () => {
    const params = { runId: "instagram_run_value_returns", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    await seedAttemptCeiling(durableStore, params.runId, 2);

    const router = fakeRouterSequence([
      ...runPrefix(),
      // Attempt 1 — refused at `07j`, so it never reaches the visual QA and
      // never buys a packager turn. Omitting `qa` here is not tidiness: queue
      // one and it would be consumed by attempt 2's copy call.
      ...standardTurns({ copy: valueSafeCopy(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), valueJudge: belowBarTurn() }),
      // Attempt 2 — the writer answered, and the run delivers.
      ...standardTurns({ copy: valueSafeCopy(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // The return path is LIVE. Without this assertion the row-6 case above
    // could pass with the value gate wired to nothing at all.
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("07j-value-judge-attempt-2");

    // The attempt that WON is the one whose verdict ships: the marker is
    // attempt-scoped, exactly as `languageDegraded` is, so attempt 1's refusal
    // must not ride along with attempt 2's clean verdict.
    const deliverables = await env.store.listJson<{ deliverable?: { grounding?: { value?: { status: string; returns: number } } } }>("acme", [
      "ledger",
      "deliverables",
      params.runId,
      "_",
    ]);
    expect(deliverables[0]!.data.deliverable?.grounding?.value?.status).toBe("keepable");
    // One of this run's attempts was caused by a value refusal, and the record says so.
    expect(deliverables[0]!.data.deliverable?.grounding?.value?.returns).toBe(1);
    expect(VALUE_MAX_RETURNS).toBeGreaterThanOrEqual(1);
  }, 60000);

  it("ROW 3 — a judge that does not complete ships UNJUDGED, fails OPEN, and burns no redraft", async () => {
    const params = { runId: "instagram_run_value_unjudged", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    // THREE attempts available on purpose. "Burns no redraft" is only a claim
    // worth making when a redraft was actually affordable.
    await seedAttemptCeiling(durableStore, params.runId, 3);

    const router = fakeRouterSequence([
      ...runPrefix(),
      ...standardTurns({
        copy: valueSafeCopy(),
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        valueJudge: JUDGE_ERROR_TURN,
        qa: goodVisualQaOutput(),
      }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // NOT ONE extra attempt. Spending a $0.166 draft on a judge outage is
    // paying for the outage twice, and the subject of this verdict is visible
    // to the human at `09a` anyway — which is the whole argument for failing
    // open here and failing closed at `07f`.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    const deliverables = await env.store.listJson<{ deliverable?: { grounding?: { value?: { status: string; stage: string; axes?: unknown; reason?: string } } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    const value = deliverables[0]!.data.deliverable?.grounding?.value;
    expect(value?.status).toBe("unjudged");
    expect(value?.stage).toBe("judge");
    // ABSENT, not faked. A reviewer has to be able to tell "judged and found
    // wanting" from "never judged", and inventing four axes here would destroy
    // exactly that distinction.
    expect(value?.axes).toBeUndefined();

    const events = await env.store.listJson<{ eventId: string; level: string }>("acme", ["ledger", "events", params.runId]);
    const valueWarns = events.filter((e) => e.data.eventId.includes("__value-"));
    expect(valueWarns).toHaveLength(1);
    expect(valueWarns[0]!.data.eventId).toBe(`${params.runId}__value-unjudged-r0`);
  }, 60000);

  it("ROW 5 — two identical verdicts stop the loop: attempt 1 fail/fail/weak/fail then the SAME again consumes exactly two copy turns, not three", async () => {
    const params = { runId: "instagram_run_value_stall", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    // Three attempts are AVAILABLE and `VALUE_MAX_RETURNS` is 2, so neither
    // bound is what stops this run. Only `axesMovement` returning "flat" is.
    await seedAttemptCeiling(durableStore, params.runId, 3);

    const router = fakeRouterSequence([
      ...runPrefix(),
      ...standardTurns({ copy: valueSafeCopy(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), valueJudge: belowBarTurn() }),
      ...standardTurns({
        copy: valueSafeCopy(),
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        // Byte-identical to attempt 1's: no axis moved up, so the writer has
        // nothing more to give on this rubric and a third $0.166 draft would
        // buy a fourth identical verdict.
        valueJudge: belowBarTurn(),
        qa: goodVisualQaOutput(),
      }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-2");
    // THE ASSERTION. Make `axesMovement` return anything but `"flat"` for the
    // identical-axes case and a third copy turn is demanded here, the router
    // runs dry, and this fails.
    expect(stepIds).not.toContain("05-write-copy-attempt-3");
    expect(stepIds).not.toContain("07j-value-judge-attempt-3");

    const deliverables = await env.store.listJson<{ deliverable?: { grounding?: { value?: { status: string; reason?: string } } } }>("acme", [
      "ledger",
      "deliverables",
      params.runId,
      "_",
    ]);
    const value = deliverables[0]!.data.deliverable?.grounding?.value;
    expect(value?.status).toBe("below-bar");
    // The reason NAMES the stall rather than reporting a bare score: "no axis
    // improved" is a different note for a human than "the final attempt was
    // still below the bar", and a reviewer acts on them differently.
    expect(value?.reason).toMatch(/no axis improved/i);
  }, 60000);
});
/**
 * The FREE half of the gate, end to end — and the reason a second shared copy
 * fixture exists at all.
 *
 * `goodCopyOutput()` was rewritten in this phase so the canonical happy path
 * actually clears `07i`. That fix was necessary and it is also a hazard: if
 * every shared fixture is value-clean, nothing in the suite makes the free
 * floor say NO, and a gate that never refuses in tests is a guard that cannot
 * fail. `weakCopyOutput()` is the deliberate other side — the OLD fixture,
 * kept verbatim: six headlines opening with the same word and every body its
 * fact card's sentence, copied character for character.
 *
 * It is worth being exact about what that draft is. It passes `07-self-check`
 * (every `sourceRef` traces), it passes `07b-craft-hygiene` (no em dash, no
 * exclamation, sentence case), it would pass the relevance judge and the
 * language gate. It is grounded, on-brief, fluent, correctly sourced and
 * worthless: a press release with a filter on it. That is precisely the post
 * the 2026-09-08 audit charged that nothing in this workflow was catching, and
 * `07i` catches it for $0, before a single paid turn is bought.
 */
describe("07i — the free value floor refuses a draft every other gate passes, and still DELIVERS (RFC-18 §4.1, §5.7 rows 1 and 2)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns the draft to 05 for free, then SHIPS it marked on the final attempt rather than holding", async () => {
    const params = { runId: "instagram_run_value_floor", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    // TWO attempts: one that is allowed to return, and one that is not.
    await seedAttemptCeiling(durableStore, params.runId, 2);

    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      // Attempt 1 — refused at `07i`, which sits ABOVE every paid step. No
      // relevance turn, no value turn, no QA turn: queue any of them here and
      // attempt 2's copy call would eat it. That omission IS the cost claim.
      ...standardTurns({ copy: weakCopyOutput(), vet: goodImageVettingOutput() }),
      // Attempt 2 — the writer sent the identical draft back, `07i` refuses
      // again, and because this is the final attempt the run FALLS THROUGH and
      // delivers. Everything downstream of `07i` therefore runs exactly once.
      ...standardTurns({
        copy: weakCopyOutput(),
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      params,
    );

    expect(result.status, JSON.stringify(result)).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // ROW 1: the refusal really did cost a redraft, so the floor is wired to
    // the loop and not merely recorded.
    expect(stepIds).toContain("07i-value-signals-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    // And it cost NOTHING else on attempt 1: the relevance judge and the value
    // judge are both below `07i`, and neither was reached.
    expect(stepIds).not.toContain("07g-relevance-attempt-1");
    expect(stepIds).not.toContain("07j-value-judge-attempt-1");
    // ROW 2: the final attempt does not return. It renders, packages and
    // delivers.
    expect(stepIds).toContain("07j-value-judge-attempt-2");
    expect(stepIds).toContain("08c-package-post");
    expect(stepIds).toContain("09b-deliver-and-log");

    const deliverables = await env.store.listJson<{
      deliverable?: { grounding?: { value?: { status: string; stage: string; reason?: string } } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const value = deliverables[0]!.data.deliverable?.grounding?.value;
    expect(value?.status).toBe("below-bar");
    // `signals`, not `judge`: "below the bar because a regex found lifted
    // prose" and "below the bar because a judge could not find a position" are
    // two different notes for a human, and the stage is what tells them apart.
    expect(value?.stage).toBe("signals");
    expect(value?.reason).toMatch(/reproduces 8 consecutive words of a fact card/i);

    const events = await env.store.listJson<{ eventId: string; level: string }>("acme", ["ledger", "events", params.runId]);
    const valueWarns = events.filter((e) => e.data.eventId.includes("__value-"));
    expect(valueWarns).toHaveLength(1);
    expect(valueWarns[0]!.data.level).toBe("warn");
  }, 60000);

  it("ROW 2 SURVIVES A JUDGE OUTAGE — a free-floor refusal on the final attempt is NOT overwritten by `unjudged` when `07j` errors", async () => {
    const params = { runId: "instagram_run_value_floor_outage", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    await seedAttemptCeiling(durableStore, params.runId, 2);

    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      // Attempt 1 — refused at `07i` above every paid step, exactly as in the
      // test above.
      ...standardTurns({ copy: weakCopyOutput(), vet: goodImageVettingOutput() }),
      // Attempt 2 — the SAME weak draft, so `07i` refuses again and names the
      // lifted span; and this time the judge below it is down. The two
      // findings collide, and the mechanical one is the one that is still
      // true: a regex found eight lifted words whether or not a Flash model
      // answered.
      ...standardTurns({
        copy: weakCopyOutput(),
        vet: goodImageVettingOutput(),
        relevance: goodRelevanceVerdict(),
        valueJudge: JUDGE_ERROR_TURN,
        qa: goodVisualQaOutput(),
      }),
    ]);

    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      params,
    );
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const deliverables = await env.store.listJson<{
      deliverable?: { grounding?: { value?: { status: string; stage: string; reason?: string; notes?: string[]; axes?: unknown } } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const value = deliverables[0]!.data.deliverable?.grounding?.value;
    // NOT `unjudged`. Reporting "nobody looked" when the free floor looked,
    // refused and named the slide is the failure this pins: the reviewer would
    // be handed a post with a known mechanical defect and told the gate had no
    // opinion about it.
    expect(value?.status).toBe("below-bar");
    expect(value?.stage).toBe("signals");
    expect(value?.reason).toMatch(/reproduces 8 consecutive words of a fact card/i);
    // The outage is still recorded, as a note rather than as the verdict, so
    // nothing about the judge being down is hidden either.
    expect((value?.notes ?? []).join(" ")).toMatch(/value judge/i);
    // Still ABSENT — the judge produced no axes, and faking them here would
    // destroy the "judged vs never judged" distinction ROW 3 pins.
    expect(value?.axes).toBeUndefined();
  }, 60000);

  it("and the fixture pair is real: the same checks that refuse the weak draft pass the shared one", () => {
    const cards = factCardsForPrompt(SIX_RESEARCH_FACTS);
    // If this ever goes green on both, the floor has been loosened or the weak
    // fixture has been tidied up, and the case above is testing nothing.
    expect(checkValueSignals({ copy: weakCopyOutput(), factCards: cards }).ok).toBe(false);
    expect(checkValueSignals({ copy: goodCopyOutput(), factCards: cards }).ok).toBe(true);
  });
});
