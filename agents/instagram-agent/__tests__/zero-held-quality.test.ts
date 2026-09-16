import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodBrandTokens,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodStyleConfig,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  hasBlockingFinding,
  selfCheckDegradeMarker,
  selfCheckDegradedReason,
  type SelfCheckFinding,
} from "../src/workflow/self-check-degrade.js";

/**
 * THE ZERO-HELD-QUALITY GUARANTEE (RFC-19, Phase 6).
 *
 * Sibling to `zero-held-guarantee.test.ts`, which proves a PICTURE problem never costs the post. This file
 * proves the same thing about a QUALITY VERDICT, which is the owner's requirement, translated from Hebrew:
 *
 * > "I want to make sure there are no runs that will fail. If the score is not good then it should repeat
 * > steps or do something else, but THE CLIENT CANNOT RECEIVE A FAILED RUN unless it is a real fault."
 *
 * Every case below is a run that HELD before this phase — three drafts paid for, three refused, and nothing
 * delivered. Each one now completes, with the refusal attached.
 *
 * ## What this file is NOT allowed to prove
 *
 * It must not prove that the gates stopped refusing. **No bar moved in RFC-19** — not
 * `MIN_RELEVANCE_SCORE`, not `checkExpectedScript`'s share, not a banned list, not a render rule. So every
 * case carries assertion 7, THE PREMISE: it reads the checkpointed step back out of the durable store and
 * asserts `output.ok === false`. Without it a case passes just as happily when the gate silently stopped
 * running, which is precisely how this codebase has produced six recorded guards that cannot fail. **The
 * fall-through must happen AFTER a refusal, never INSTEAD of one.**
 *
 * And assertion 8, THE NEGATIVE: the same fixture with the trigger removed must produce NO marker at all. A
 * `degraded` badge on every clean post is the "silently shipping a bad post" failure in reverse — shout
 * `degraded` at everything and nobody reads it.
 *
 * ## Turn counts are ENUMERATED, never observed
 *
 * RFC-19 §7's claim is "added planned cost: $0.000000", and RFC-19 §11 item 4 names the way that claim could
 * quietly become false: a fall-through reaches steps the old `continue` skipped, so every fixture here pulls
 * turns the held version never queued. Each case states its arithmetic in a comment and asserts the total. A
 * new model call anywhere on these paths exhausts the queue and fails loudly.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Chromium-free `publish.renderCarousel` — `fakeRenderCarousel`'s own doc comment has the rationale. */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** `goodCopyOutput()` with one slide's body replaced — everything else stays valid, so exactly one gate refuses. */
function copyWithBody(body: string, slideIndex = 0): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return { ...copy, slides: copy.slides.map((s, i) => (i === slideIndex ? { ...s, body } : s)) };
}

/**
 * A copy turn that will never clear `InstagramCopyOutputSchema`.
 *
 * MEASURED, not assumed: this resolves the step to `content_fail` on ONE turn ("failed its own output
 * validation"), not to `tooling_error` after a re-prompt. Both statuses reach the SAME merged branch — RFC-19
 * §4 items 12 and 13 — so this fixture exercises the branch either way, and the fixtures below count one turn.
 */
const MALFORMED_COPY = { format: "carousel" };

type Delivered = {
  deliverable: {
    selfCheck?: { status: string; reason: string; attempt: number; attemptsSpent: number; checks: SelfCheckFinding[] };
  };
};

describe("zero-held quality guarantee: a refusing gate never costs the post (RFC-19)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function run(turns: Array<() => ReturnType<ReturnType<typeof finalTurn>>>, runId: string) {
    const router = fakeRouterSequence(turns);
    const durableStore = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    return { router, durableStore, go: () => new WorkflowEngine(durableStore).run(workflowFn, { ...base, runId }) };
  }

  const PRE_LOOP = [finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN)];
  /** The turns an attempt pulls once it gets PAST `07`/`07b`: the relevance judge, the value judge, visual QA. */
  const paidTail = (qa: unknown = goodVisualQaOutput()) => [
    finalTurn(goodRelevanceVerdict()),
    finalTurn(VALUE_TURN_NO_FINDINGS),
    finalTurn(qa),
  ];

  /** Assertions 1-7, shared, so a new case cannot quietly assert less than the others. */
  async function expectDegradedDelivery(opts: {
    result: Awaited<ReturnType<WorkflowEngine["run"]>>;
    durableStore: MemoryDurableStepStore;
    runId: string;
    gate: SelfCheckFinding["gate"];
    detail: RegExp;
    premiseStepId: string;
    /**
     * Reads the checkpointed step's own output and says whether the gate REFUSED.
     *
     * Per-case rather than one generic shape, because a `step.code` gate checkpoints its verdict directly
     * (`{ ok: false }`) and a `step.agent` gate checkpoints the whole `AgentExecutionResult`, so the refusal
     * lives at `finalOutput`. A predicate that guessed at both would pass on a step that recorded neither,
     * which is the guard-that-cannot-fail shape this assertion exists to prevent.
     */
    premiseRefused: (output: Record<string, unknown>) => boolean;
  }): Promise<SelfCheckFinding> {
    // 1. DELIVERED. Never `held`, never the engine's own `degraded` (which hard-codes `output: null`).
    expect(opts.result.status).toBe("completed");
    if (opts.result.status !== "completed") throw new Error("unreachable");

    // 2. EXACTLY ONE deliverable row exists — the client can retrieve the carousel. These runs are a 404 today.
    const rows = await env.store.listJson("acme", ["ledger", "deliverables", opts.runId, "_"]);
    expect(rows.length).toBe(1);

    const record = await env.store.readJson<Delivered>("acme", ["ledger", "deliverables", opts.runId, "_", "instagram-carousel"]);
    const marker = record?.deliverable.selfCheck;
    expect(marker, "the deliverable must carry the degrade marker — a post that ships bad without the truth attached is WORSE than a hold").toBeDefined();
    expect(marker!.status).toBe("degraded");

    // 3. THE RIGHT GATE IS NAMED.
    const check = marker!.checks.find((c) => c.gate === opts.gate);
    expect(check, `expected a finding for gate "${opts.gate}", got ${JSON.stringify(marker!.checks.map((c) => c.gate))}`).toBeDefined();

    // 4. IN THE GATE'S OWN WORDS. `detail` is passed through verbatim, never re-worded — a paraphrase makes a
    //    wording change in the gate invisible to its own test.
    expect(check!.detail).toMatch(opts.detail);
    // The step id a reviewer opens to read the raw refusal.
    expect(check!.step).toBe(opts.premiseStepId);

    // 5. ONE SENTENCE. The gate payload, the deliverable, the ledger row and the typed return must not drift.
    const output = opts.result.output as { selfCheck?: { reason: string } };
    expect(output.selfCheck?.reason).toBe(marker!.reason);

    // 6. A LEDGER WARN, so this is visible without opening the deliverable.
    const events = await env.store.listJson("acme", ["ledger", "events", opts.runId]);
    const warns = events.filter((e) => (e.data as { level: string }).level === "warn");
    expect(warns.some((e) => String(e.id).includes("self-check-degraded"))).toBe(true);

    // 7. THE PREMISE. The gate ACTUALLY REFUSED. Without this the case passes when the gate stopped running.
    const step = (await opts.durableStore.getStep(opts.runId, opts.premiseStepId)) as { output: Record<string, unknown> } | undefined;
    expect(step, `${opts.premiseStepId} was never checkpointed — the gate did not run at all`).toBeDefined();
    expect(
      opts.premiseRefused(step!.output),
      `${opts.premiseStepId} must have REFUSED — the fall-through is after a refusal, never instead of one. Output: ${JSON.stringify(step!.output).slice(0, 400)}`,
    ).toBe(true);

    return check!;
  }

  /**
   * Assertion 8, THE NEGATIVE: the identical fixture with EVERY trigger removed ships NO marker.
   *
   * **In an `it` of its own, and that is a deliberate deviation from RFC-19 §8.2's "in the same `it`".** A
   * second run inside one `it` shares the client store with the first, and `09b` writes the delivered post's
   * text into the cross-run excerpt window on the way out — so the clean re-run's byte-identical draft is
   * then 100% similar to a post this client "already published" and `07d` sends it back to `05` on every
   * attempt. The negative would fail for a reason that has nothing to do with the marker. One case, in a
   * fresh environment, over the fixture with every trigger removed at once.
   */
  it("a clean run carries NO marker at all — absent, never empty", async () => {
    const runId = "zero_held_quality_clean";
    const { router, go } = run(
      [...PRE_LOOP, finalTurn(goodCopyOutput()), finalTurn(goodImageVettingOutput()), ...paidTail(), finalTurn(DEFAULT_PACKAGE_TURN)],
      runId,
    );
    const result = await go();
    expect(result.status).toBe("completed");
    const record = await env.store.readJson<Delivered>("acme", ["ledger", "deliverables", runId, "_", "instagram-carousel"]);
    expect(
      record?.deliverable.selfCheck,
      "a clean run must carry NO marker: absent, never empty. A degraded badge on every post is the same defect in reverse.",
    ).toBeUndefined();
    expect((result as { output: { selfCheck?: unknown } }).output.selfCheck).toBeUndefined();
    // 3 pre-loop + 1 entities + 2 (copy, vetting) + 3 (relevance, value, QA) + 1 packager = 10.
    // Phase 5.5 (spec §2 A2): `04b3-extract-entities` adds ONE turn per
    // REVISION, immediately after `04j-select-angle` — it reads this run's
    // fact cards and names the real-world things a picture could be OF. It is
    // outside the attempt loop, so a redraft never re-pays for it, which is
    // why every count below moves by exactly one however many attempts run.
    expect(router.complete).toHaveBeenCalledTimes(10);
  }, 90000);

  // ── RFC-19 §4 item 2: step 07's slide self-check ──
  it("delivers a draft whose banned word step 07 refused on every attempt, rather than holding", async () => {
    // "guaranteed" is banned by `goodStyleConfig()`, so `checkSlidesData` refuses this on all three attempts.
    const banned = copyWithBody("This is guaranteed to help your team every single week.");
    // 3 pre-loop + 1 entities + 2 refused attempts × (copy, vetting) + the delivering attempt's 5 (copy,
    // vetting, relevance, value, QA) + 1 packager = 14. `07` sits ABOVE every paid step, which is why the
    // two refused attempts cost two turns each and not five.
    // Phase 5.5 (spec §2 A2): `04b3-extract-entities` adds ONE turn per
    // REVISION, immediately after `04j-select-angle` — it reads this run's
    // fact cards and names the real-world things a picture could be OF. It is
    // outside the attempt loop, so a redraft never re-pays for it, which is
    // why every count below moves by exactly one however many attempts run.
    const EXPECTED_TURNS = 3 + 1 + 2 * 2 + 5 + 1;
    const runId = "zero_held_quality_slides";
    const { router, durableStore, go } = run(
      [
        ...PRE_LOOP,
        finalTurn(banned),
        finalTurn(goodImageVettingOutput()),
        finalTurn(banned),
        finalTurn(goodImageVettingOutput()),
        finalTurn(banned),
        finalTurn(goodImageVettingOutput()),
        ...paidTail(),
        finalTurn(DEFAULT_PACKAGE_TURN),
      ],
      runId,
    );
    const result = await go();

    const check = await expectDegradedDelivery({
      result,
      durableStore,
      runId,
      gate: "slides",
      detail: /guaranteed/,
      premiseStepId: "07-self-check-attempt-3",
      premiseRefused: (o) => o["ok"] === false,
    });
    // A mechanical refusal is NOT a compliance refusal, and must never be marked blocking.
    expect(check.severity).toBeUndefined();
    // 9. THE TURN COUNT, enumerated above rather than read off a failing run.
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 90000);

  // ── RFC-19 §4 item 3: 07b craft hygiene ──
  it("delivers a draft whose em dash the craft gate refused on every attempt, rather than holding", async () => {
    const emDash = copyWithBody("Teams saved time — every single week, without fail.");
    const EXPECTED_TURNS = 3 + 1 + 2 * 2 + 5 + 1;
    const runId = "zero_held_quality_craft";
    const { router, durableStore, go } = run(
      [
        ...PRE_LOOP,
        finalTurn(emDash),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDash),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDash),
        finalTurn(goodImageVettingOutput()),
        ...paidTail(),
        finalTurn(DEFAULT_PACKAGE_TURN),
      ],
      runId,
    );
    const result = await go();

    await expectDegradedDelivery({
      result,
      durableStore,
      runId,
      gate: "craft",
      detail: /em dash/i,
      premiseStepId: "07b-craft-hygiene-attempt-3",
      premiseRefused: (o) => o["ok"] === false,
    });
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 90000);

  // ── RFC-19 §4 item 6: 07g relevance, the only paid judge that lacked the guard ──
  it("delivers a post the relevance judge scored below its floor, carrying the SUB-FLOOR SCORE", async () => {
    const offBrief = () =>
      finalTurn(
        goodRelevanceVerdict({
          score: 1,
          reason: "nothing on these slides connects to what this business sells",
          missingBridge: "name the client's own onboarding data",
        }),
      );
    // 3 pre-loop + 2 refused attempts × (copy, vetting, relevance) + the delivering attempt's 5 + 1 packager
    // = 15. `07g` is the first PAID step an attempt reaches, so a relevance refusal costs three turns, not two.
    const EXPECTED_TURNS = 3 + 1 + 2 * 3 + 5 + 1;
    const runId = "zero_held_quality_relevance";
    const copy = goodCopyOutput();
    const { router, durableStore, go } = run(
      [
        ...PRE_LOOP,
        finalTurn(copy),
        finalTurn(goodImageVettingOutput()),
        offBrief(),
        finalTurn(copy),
        finalTurn(goodImageVettingOutput()),
        offBrief(),
        finalTurn(copy),
        finalTurn(goodImageVettingOutput()),
        offBrief(),
        finalTurn(VALUE_TURN_NO_FINDINGS),
        finalTurn(goodVisualQaOutput()),
        finalTurn(DEFAULT_PACKAGE_TURN),
      ],
      runId,
    );
    const result = await go();

    const check = await expectDegradedDelivery({
      result,
      durableStore,
      runId,
      gate: "relevance",
      detail: /off-brief|relevance/i,
      premiseStepId: "07g-relevance-attempt-3",
      // An AGENT step: the checkpoint is the whole `AgentExecutionResult`, so the judge's own score lives at
      // `finalOutput`. 1 is below `MIN_RELEVANCE_SCORE` (3) — the judge really did refuse, and the floor
      // really is still 3.
      premiseRefused: (o) => ((o["finalOutput"] as { score?: number } | undefined)?.score ?? 99) < 3,
    });
    // THE POINT OF THIS ROW. `DraftResult.relevance` could only ever carry a PASSING score before, so the
    // marker has to say the sub-floor number in so many words — "judged and found wanting", not "never judged".
    expect(check.score).toEqual({ value: 1, floor: 3 });
    expect(result.status === "completed" && (result.output as { selfCheck?: { reason: string } }).selfCheck?.reason).toMatch(
      /scored 1 against a floor of 3/,
    );
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 90000);

  // ── RFC-19 §4 item 9: 08b visual QA said no, and the PNGs are one assignment from shipping ──
  it("delivers a rendered carousel the visual-QA judge refused on every attempt, with the judge's own ruleId", async () => {
    const qaFail = {
      pass: false,
      findings: [
        { ruleId: "default:two-elements-per-slide", slide: 4, passed: false, note: "slide 4 carries a headline, a body and a stat" },
      ],
    };
    // 3 pre-loop + 3 full attempts × 5 + 1 packager = 19. Visual QA is the LAST step in the attempt, so a QA
    // refusal is the most expensive of all of them — and today it is also the one that threw the render away.
    const EXPECTED_TURNS = 3 + 1 + 3 * 5 + 1;
    const runId = "zero_held_quality_visual_qa";
    const copy = goodCopyOutput();
    const { router, durableStore, go } = run(
      [
        ...PRE_LOOP,
        ...[1, 2, 3].flatMap(() => [finalTurn(copy), finalTurn(goodImageVettingOutput()), ...paidTail(qaFail)]),
        finalTurn(DEFAULT_PACKAGE_TURN),
      ],
      runId,
    );
    const result = await go();

    const check = await expectDegradedDelivery({
      result,
      durableStore,
      runId,
      gate: "visual-qa",
      detail: /default:two-elements-per-slide/,
      premiseStepId: "08b-visual-qa-attempt-3",
      premiseRefused: (o) => (o["finalOutput"] as { pass?: boolean } | undefined)?.pass === false,
    });
    // The judge's own `ruleId`, `slide` and `note` — never a summary. A reviewer has to be able to act on it.
    expect(check.kind).toBe("default:two-elements-per-slide");
    expect(check.slide).toBe(4);
    // And the carousel really did render: the PNGs the old code binned.
    expect(result.status === "completed" && (result.output as { renderedCount: number }).renderedCount).toBe(6);
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 120000);

  // ── RFC-19 §4 items 12/13 + Mechanism B: the final attempt has no draft of its own ──
  it("ships an EARLIER attempt's draft when the final attempt's copy comes back malformed", async () => {
    const qaFail = { pass: false, findings: [{ ruleId: "default:cover-carries-device", slide: 1, passed: false, note: "the cover carries no device" }] };
    const copy = goodCopyOutput();
    // 3 pre-loop + attempts 1 and 2 at 5 turns each (both render, both refused by QA, so both reach salvage
    // depth 4) + attempt 3's ONE schema-failing copy turn + the 4 that attempt then spends on the salvaged
    // draft (vetting, relevance, value, QA) + 1 packager = 19.
    //
    // ONE turn, not two, and the distinction is the whole shape of the fixture: `MALFORMED_COPY` is
    // well-formed JSON that fails the Zod schema, so `BaseAgent` returns `content_fail` after a single turn.
    // The two-turn path is the OTHER one — `maxMalformedTurns: 1` retries an unreadable turn once and then
    // returns `tooling_error` — and this fixture does not buy it. Both statuses reach the same Mechanism B
    // branch (RFC-19 §4 items 12/13), which is why one fixture covers the behaviour; only the price differs,
    // and in production the `tooling_error` route costs one extra `copyAttempt` at $0.181.
    const EXPECTED_TURNS = 3 + 1 + 5 + 5 + 5 + 1;
    const runId = "zero_held_quality_salvage";
    const { router, durableStore, go } = run(
      [
        ...PRE_LOOP,
        finalTurn(copy),
        finalTurn(goodImageVettingOutput()),
        ...paidTail(qaFail),
        finalTurn(copy),
        finalTurn(goodImageVettingOutput()),
        ...paidTail(qaFail),
        finalTurn(MALFORMED_COPY),
        finalTurn(goodImageVettingOutput()),
        ...paidTail(),
        finalTurn(DEFAULT_PACKAGE_TURN),
      ],
      runId,
    );
    const result = await go();

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect((await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"])).length).toBe(1);

    const record = await env.store.readJson<Delivered>("acme", ["ledger", "deliverables", runId, "_", "instagram-carousel"]);
    const marker = record?.deliverable.selfCheck;
    expect(marker).toBeDefined();
    const draftCheck = marker!.checks.find((c) => c.gate === "draft");
    expect(draftCheck).toBeDefined();
    expect(draftCheck!.kind).toBe("final-attempt-malformed");
    // The reason names WHICH attempt actually shipped — "the best attempt you already paid for" has a
    // definition (greatest depth, then latest), not a vibe, and the reviewer gets to read it.
    expect(draftCheck!.detail).toMatch(/attempt 3's draft failed its own output validation/);
    expect(draftCheck!.detail).toMatch(/attempt 2's draft shipped instead/);
    expect(marker!.attempt).toBe(2);
    expect(marker!.attemptsSpent).toBe(3);
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 120000);

  // ── THE KEPT BOUNDARY (RFC-19 §6 item 5): no draft exists at all ──
  it("STILL HOLDS, with the narrowed reason, when no attempt ever produced schema-valid copy", async () => {
    // This is the owner's own carve-out — "a genuine tooling failure where no output exists at all" — and it
    // is the only thing left at the bottom of the attempt loop. The old generic wording is gone: nine
    // unrelated causes used to read as this one sentence, and `held-sites.test.ts` asserts it is deleted.
    const EXPECTED_TURNS = 3 + 1 + 3;
    const runId = "zero_held_quality_no_draft";
    const { router, go } = run([...PRE_LOOP, ...[1, 2, 3].map(() => finalTurn(MALFORMED_COPY))], runId);
    const result = await go();

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no drafting attempt produced copy that cleared its own schema/);
    expect(result.reason).toMatch(/no earlier attempt could be salvaged/);
    expect(result.reason).not.toMatch(/self-check never passed after/);
    expect((await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"])).length).toBe(0);
    expect(router.complete).toHaveBeenCalledTimes(EXPECTED_TURNS);
  }, 90000);

  // ── Mechanism C, the last place it had not been applied: an OUTAGE is not a verdict on any attempt ──
  it("does not redraft against a gate.brandCompliance OUTAGE: the finding lands on attempt 1 and no attempt is wasted", async () => {
    // A regulated client whose compliance gate is DOWN. `checkSlidesData` returns
    // `kind: "compliance-unverified"` with a reason that says, in its own words, "The gate formed no view —
    // this is not a finding about the copy". That sentence used to be handed to `returnToCopyWith`, which
    // assigns `selfCheckSteer` and feeds it straight into the next copy prompt — so the writer was asked
    // twice to fix a deployment, at $0.181 a redraft, and only the third attempt recorded the finding.
    //
    // It is the same guard-that-cannot-pass shape `08b`'s `unjudged` path and `checkCraftHygiene`'s own
    // outage branch were fixed for, in the twin gate's own words: "an outage is not more of a verdict on
    // attempt 1 than on attempt 3". Falling through immediately is CHEAPER, not more expensive.
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig({ compliance: { regulated: true, required_framing: [], never_say: ["guaranteed returns"] } }),
      instagramBrandTokens: goodBrandTokens(),
    });
    const realCompliance = env.tools["gate.brandCompliance"]!;
    const toolsWithOutage = {
      ...testTools(env),
      "gate.brandCompliance": {
        ...realCompliance,
        execute: (async () => ({ status: "tooling_error" as const, reason: "compliance provider unavailable" })) as typeof realCompliance.execute,
      },
    } as unknown as AgentToolRegistry;

    const runId = "zero_held_quality_compliance_outage";
    const router = fakeRouterSequence([...PRE_LOOP, finalTurn(goodCopyOutput()), finalTurn(goodImageVettingOutput()), ...paidTail(), finalTurn(DEFAULT_PACKAGE_TURN)]);
    const durableStore = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({
      tools: toolsWithOutage,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...base, runId });

    // 1. The client gets the post.
    expect(result.status).toBe("completed");
    const delivered = await env.store.listJson<Delivered>("acme", ["ledger", "deliverables", runId, "_"]);
    expect(delivered).toHaveLength(1);

    // 2. ON ATTEMPT 1 — the whole point. The queue above buys exactly ONE drafting attempt; a redraft would
    //    exhaust it and fail loudly, so this assertion is load-bearing twice over.
    const selfCheck = delivered[0]!.data.deliverable.selfCheck;
    expect(selfCheck?.status).toBe("degraded");
    expect(selfCheck?.attempt).toBe(1);
    expect(selfCheck?.attemptsSpent).toBe(1);

    // 3. The finding is still BLOCKING and still says the gate formed no view. The bar did not move: the
    //    gate refused exactly what it refuses today, and §5.5's 24h/hold routing is untouched.
    const finding = selfCheck?.checks.find((c) => c.kind === "compliance-unverified");
    expect(finding, `checks: ${JSON.stringify(selfCheck?.checks)}`).toBeDefined();
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toMatch(/The gate formed no view — this is not a finding about the copy/);

    // 4. Three pre-loop + one attempt's five + one packager = 9. Two `copyAttempt`s at $0.181 NOT spent.
    // Phase 5.5: + 1 for `04b3-extract-entities`, once per revision.
    expect(router.complete).toHaveBeenCalledTimes(3 + 1 + 5 + 1);
  }, 90000);
});

describe("the degraded contract itself (self-check-degrade.ts)", () => {
  const relevance: SelfCheckFinding = {
    gate: "relevance",
    step: "07g-relevance-attempt-3",
    kind: "off-brief",
    detail: "the relevance judge scored this draft off-brief",
    score: { value: 2, floor: 3 },
  };
  const compliance: SelfCheckFinding = {
    gate: "slides",
    step: "07-self-check-attempt-3",
    kind: "compliance",
    detail: 'slide 2 uses the phrase "guaranteed returns", which this client forbids in its compliance config',
    severity: "blocking",
  };

  it("returns NO marker for an empty check list — absent, never empty", () => {
    expect(selfCheckDegradeMarker([], { attempt: 3, attemptsSpent: 3 })).toBeUndefined();
  });

  it("names the gate AND the score, in the gate's own words, with the step that produced it", () => {
    const reason = selfCheckDegradedReason([relevance], { attempt: 3, attemptsSpent: 3 });
    expect(reason).toMatch(/^delivered degraded: 1 self-check did not pass on the final attempt \(3 of 3\)/);
    expect(reason).toContain("the relevance judge scored this draft off-brief");
    expect(reason).toContain("scored 2 against a floor of 3");
    expect(reason).toContain("(07g-relevance-attempt-3)");
    // The same "a person should look at this" clause Phase 4's language marker ends with.
    expect(reason).toMatch(/A human should read this post before it publishes\.$/);
  });

  it("says WHICH attempt shipped when it was not the last one — Mechanism B's salvage", () => {
    expect(selfCheckDegradedReason([relevance], { attempt: 2, attemptsSpent: 3 })).toContain("on the attempt that shipped (2 of 3 spent)");
  });

  it("records the cheapest-path posture rather than hiding it", () => {
    expect(selfCheckDegradedReason([relevance], { attempt: 3, attemptsSpent: 3, pastHardMax: true })).toContain(
      "past its hard max and finished on the cheapest complete path",
    );
  });

  it("sorts a BLOCKING regulated-compliance finding to the front of the one sentence a reviewer reads", () => {
    const reason = selfCheckDegradedReason([relevance, compliance], { attempt: 3, attemptsSpent: 3 });
    expect(reason.indexOf("BLOCKING:")).toBeLessThan(reason.indexOf("the relevance judge"));
    expect(reason).toContain("guaranteed returns");
  });

  it("sorts `checks` blocking-first TOO, so the list and the sentence name the same finding", () => {
    // RFC-19 §5.5 item 2 says the regulated finding rides the TOP of `selfCheck.checks`, and
    // `brand-compliance-gate.test.ts` reads `checks[0].severity` on both the deliverable and the `09a`
    // payload. Until this existed, only `selfCheckDegradedReason` sorted: the marker returned the gates'
    // execution order, and every run in the suite happened to carry exactly ONE finding, so the two could
    // not be told apart. A reviewer on a two-finding run would have read "BLOCKING: ..." first in the
    // sentence and something else first in the list.
    //
    // Order the arguments the WRONG way round on purpose — blocking second — because a sort that is never
    // asked to move anything is a sort nobody has tested.
    const marker = selfCheckDegradeMarker([relevance, compliance], { attempt: 3, attemptsSpent: 3 });
    expect(marker?.checks.map((c) => c.gate)).toEqual([compliance.gate, relevance.gate]);
    expect(marker?.checks[0]?.severity).toBe("blocking");
    // The two views agree, which is the actual requirement: same finding, same position.
    expect(marker!.reason.indexOf(marker!.checks[0]!.detail)).toBeLessThan(marker!.reason.indexOf(marker!.checks[1]!.detail));
    // And a non-blocking set keeps the gates' own execution order — the sort is stable, not a re-shuffle.
    expect(selfCheckDegradeMarker([relevance, { ...relevance, gate: "craft", step: "07b" }], { attempt: 3, attemptsSpent: 3 })?.checks.map((c) => c.gate)).toEqual([
      "relevance",
      "craft",
    ]);
  });

  it("routes 09a to 24h/hold ONLY for a blocking finding — every other degrade keeps 1h/auto_approve", () => {
    // RFC-19 §5.5. Nothing regulated may auto-approve into publication while nobody is looking; and adding a
    // hold to every OTHER degraded post would be the wrong shape for a phase whose content is "stop holding".
    expect(hasBlockingFinding([compliance])).toBe(true);
    expect(hasBlockingFinding([relevance])).toBe(false);
    expect(hasBlockingFinding([])).toBe(false);
  });
});
