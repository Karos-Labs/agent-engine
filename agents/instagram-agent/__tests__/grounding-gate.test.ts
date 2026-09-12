import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { ClientBriefSchema, type ClientBrief } from "@agent-engine/tools";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { MIN_RELEVANCE_SCORE, THIN_GROUNDING_MIN_RELEVANCE_SCORE, relevanceFloor } from "../src/workflow/relevance-gate.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodStyleConfig,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns, standardTurns } from "./turns.js";

/**
 * The audit client has NO persisted brief, which is this whole suite's
 * subject: `02i-resolve-client-brief` falls back to the DETERMINISTIC brief
 * derived from onboarding data alone, and the relevance judge is what stops a
 * run grounded that thinly from shipping a real-estate carousel.
 *
 * Since the Phase 1 lifecycle landed (`00b*`), a client with no brief on disk
 * spends one `instagram-brief` turn before every other model call. These
 * fixtures queue a turn the brief agent's own output schema refuses
 * (`coreTerms` may not be empty), so nothing is written, `00b3` records its
 * warn, and `02i` reports `derived` - exactly the state a client is in until
 * their first brief succeeds. That fail-open path is asserted directly in
 * `client-brief-setup.test.ts`; here it is only the starting condition.
 */
const NO_BRIEF_WRITTEN_YET = { coreTerms: [] };

/** `happyTurns`, preceded by the refused brief turn every run without a persisted brief now consumes. */
const auditTurns = (overrides: Parameters<typeof happyTurns>[0] = {}) => happyTurns({ brief: NO_BRIEF_WRITTEN_YET, ...overrides });

/**
 * Instagram Phase 0 grounding gate (spec §C), through the real workflow.
 *
 * Step ids under test are the spec's: `02i-resolve-client-brief` (the brief,
 * `derived` here because no persisted brief exists),
 * `04a2-research-pull-deep` (whose news lane leads with the GROUNDED query,
 * never the verbatim request),
 * `07g-relevance-attempt-N` (the Flash judge inside the self-check loop),
 * and the `grounding` block on the gate payload and the deliverable.
 *
 * The client is modelled on the one the gate exists for: Karos Labs, an AI
 * marketing agency whose run request "Create content that introduces the
 * new offer to first-time buyers" was searched verbatim and came back as a
 * real-estate carousel about first-time HOME buyers (prep audit 2026-09-08).
 *
 * Model turns are queued by name through `standardTurns()` so the order
 * survives the other Phase 0 additions (scout on every run, relevance judge
 * per attempt). Only the judge's verdicts vary between tests here.
 */

/** The request that produced the MassHousing carousel — a DIRECTION, not a subject. */
const AUDIT_REQUEST = "Create content that introduces the new offer to first-time buyers";

const KAROSLABS_PROFILE = {
  name: "Karos Labs",
  industry: "AI marketing",
  description: "Karos Labs is an AI marketing agency for B2B founders. We run research, drafting and publishing across every channel with agents a human editor reviews.",
};

/**
 * The audit's own defect, scored the way the rubric scores it: a real-estate
 * carousel for an AI marketing agency is a 1 ("a different industry, a
 * different customer, a subject the brief never touches"), not a 2.
 *
 * The score matters here because this client is THINLY GROUNDED — profile
 * only, no product-information and no target-audience document — so the gate
 * floor is `THIN_GROUNDING_MIN_RELEVANCE_SCORE` (2): a 2 is the ceiling of
 * what any draft could earn from "What we sell: AI marketing / Audience:
 * practitioners in AI marketing", and failing every attempt on it would hold
 * the run on a verdict no redraft can answer. A 1 is off-brief at either
 * floor, which is why the defect this gate exists for is still caught.
 */
const OFF_BRIEF_VERDICT = {
  score: 1,
  reason: "every slide is about mortgage lenders and housing programs; nothing names an agency, a founder or a marketing offer",
  missingBridge: "open slide 1 with the client's own first-month offer for founders buying marketing help for the first time",
};

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** Every copy-agent prompt the fake router saw, parsed back to the `input` object the workflow assembled. */
function copyTurnInputs(router: ReturnType<typeof fakeRouterSequence>): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input && typeof parsed.input === "object" && "facts" in parsed.input && "styleConfig" in parsed.input) inputs.push(parsed.input);
    } catch {
      // not a JSON prompt (never the case for BaseAgent calls, but be safe)
    }
  }
  return inputs;
}

describe("02i / 04a / 07g — the grounding gate in the instagram workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    // An empty catalog so the client's own `requestedSubject` (the audit's
    // verbatim request) is the claimed topic — the exact shape of the run
    // that shipped off-brief.
    // `seedBrief: false` because this suite is about the DERIVED brief — the
    // Phase 0 stand-in every client's first run drafts from. Since the Phase 1
    // 00b* wiring landed, omitting the option seeds a fresh agent brief
    // instead, and `02i` would report `persisted`.
    env = await setupTestEnvironment({ seedTopics: [], seedBrief: false });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig(),
      instagramBrandTokens: goodBrandTokens(),
      requestedSubject: AUDIT_REQUEST,
    });
    await env.store.writeJson("acme", ["client", "profile"], KAROSLABS_PROFILE);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof fakeRouterSequence>, opts: { autoApprove?: boolean } = {}) {
    return createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      ...(opts.autoApprove === false ? {} : { autoApprove: true }),
    });
  }

  it("an off-brief verdict returns the draft to 05 with the judge's bridge as relevanceSteer; the second draft passes and the gate payload carries the grounding", async () => {
    const router = fakeRouterSequence([
      // Attempt 1 stops at the judge (no QA turn is ever reached).
      ...auditTurns({ relevance: OFF_BRIEF_VERDICT, qa: undefined }),
      // Attempt 2: scout and research ran once per run, so only the per-attempt turns.
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const params = { runId: "instagram_run_grounding_redraft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFor(router, { autoApprove: false }), params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02i-resolve-client-brief");
    expect(stepIds).toContain("07g-relevance-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("07g-relevance-attempt-2");
    expect(stepIds).not.toContain("05-write-copy-attempt-3");
    // The off-brief draft never reached the renderer.
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).toContain("08-render-carousel-attempt-2");

    // Attempt 2's copy input carries the steer; attempt 1's did not. Both carry the brief.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(2);
    expect(copyInputs[0]!["relevanceSteer"]).toBeUndefined();
    expect(copyInputs[1]!["relevanceSteer"]).toBe(OFF_BRIEF_VERDICT.missingBridge);
    // A relevance failure carries ITS steer only: no `selfCheckSteer` is manufactured for it.
    expect(copyInputs[1]!["selfCheckSteer"]).toBeUndefined();
    for (const input of copyInputs) {
      expect(typeof input["clientBrief"]).toBe("string");
      expect(input["clientBrief"] as string).toContain("Client brief (confidence low");
      expect(input["clientBrief"] as string).toContain("Karos Labs is an AI marketing agency for B2B founders.");
    }

    // The gate payload shows the reviewer what grounded this post.
    const pendingGate = await durableStore.getGate(first.pendingGateId);
    const payload = pendingGate?.payload as { grounding?: { briefSource: string; briefConfidence: string; relevance?: { score: number; reason: string } } } | undefined;
    expect(payload?.grounding).toBeDefined();
    expect(payload!.grounding!.briefSource).toBe("derived");
    expect(payload!.grounding!.briefConfidence).toBe("low");
    expect(payload!.grounding!.relevance?.score).toBe(5);
    expect(typeof payload!.grounding!.relevance?.reason).toBe("string");

    // Approve -> delivered, and the deliverable carries the same grounding block.
    await engine.resolveGate(params.runId, "09a-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
    const second = await engine.run(workflowFor(router, { autoApprove: false }), params);
    expect(second.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { relevance?: { score: number } } } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);
    expect(deliverables[0]!.data.deliverable.grounding?.relevance?.score).toBe(5);
  }, 60000);

  it("off-brief verdicts exhaust the self-check budget the PLAN allowed and HOLD, naming relevance — never a render, never a delivery", async () => {
    // TWO rounds, not three, and the reason is the budget rather than this
    // gate: a first run for a new client writes its Client Brief (00b1 +
    // 00b2, $0.155 of the $1.00 target before a single slide is drafted), so
    // `02j` pulls every lever it has and the last one it needs is "one return
    // to step 05 instead of two". That is the owner's amendment working as
    // written — the plan adapts, the run still delivers or holds on its own
    // merits — and it is why the third round would never be reached. The
    // assertions below are the ones that matter and none of them is relaxed:
    // the run HOLDS naming relevance, nothing renders, nothing is delivered,
    // and every queued turn was consumed.
    const router = fakeRouterSequence([
      ...auditTurns({ relevance: OFF_BRIEF_VERDICT, qa: undefined }),
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: OFF_BRIEF_VERDICT }),
    ]);
    const params = { runId: "instagram_run_grounding_hold", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/relevance 1\/5/);
    expect(result.reason).toMatch(/does not read as this client's/);
    expect(result.reason).toContain(OFF_BRIEF_VERDICT.reason);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07g-relevance-attempt-1");
    expect(stepIds).toContain("07g-relevance-attempt-2");
    // The plan is what decided there were two rounds and not three, and the
            // reason is on the record: a budget adaptation, never a hold cause.
    const plan = (await durableStore.listSteps(params.runId)).find((s) => s.stepId === "02j-plan-run-budget")?.output as
      | { plan: { maxSelfCheckAttempts: number }; adaptations: string[] }
      | undefined;
    expect(plan?.plan.maxSelfCheckAttempts).toBe(2);
    expect(plan?.adaptations).toContain("one return to step 05 instead of two");
    expect(stepIds).not.toContain("07g-relevance-attempt-3");
    expect(stepIds.some((id) => id.startsWith("08-render-carousel"))).toBe(false);
    // Every queued turn was consumed: nothing skipped the judge.
    await expect(router.complete({} as never, {} as never, [] as never, {} as never)).rejects.toThrow(/exhausted/);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  it("THIN GROUNDING: a 2/5 on an industry-only brief ships with the reason on the gate payload instead of holding the run", async () => {
    // This client has a profile and nothing else: no product-information and
    // no target-audience document, so the brief reads "What we sell: AI
    // marketing / Audience (ICP): practitioners in AI marketing". The judge's
    // own rubric defines 2 as "a different business in the same field could
    // have posted this word for word", which is the CEILING of what a writer
    // given that grounding can produce — so at the normal floor of 3 every
    // attempt failed and the run held, for exactly the thin-onboarding client
    // the 2026-09-08 audit was about.
    const GENERIC_BUT_ON_FIELD = {
      score: 2,
      reason: "the post is about marketing automation for founders, which is this field, but nothing on the page is only this business",
      missingBridge: "name the client's own offer in the caption",
    };
    const router = fakeRouterSequence(auditTurns({ relevance: GENERIC_BUT_ON_FIELD }));
    const params = { runId: "instagram_run_grounding_thin", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07g-relevance-attempt-1");
    // No redraft, no second judge call, no hold.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("08-render-carousel-attempt-1");

    // The relaxed floor is never silent: the score, the judge's reason and
    // WHY the usual floor could not be applied all reach the reviewer.
    const brief = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief } };
    expect(brief.output.brief.icp.summary).toBe("practitioners in AI marketing");
    expect(brief.output.brief.sources.some((s) => s.kind === "context-doc")).toBe(false);

    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { relevance?: { score: number; reason: string; note?: string } } } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const relevance = deliverables[0]!.data.deliverable.grounding?.relevance;
    expect(relevance?.score).toBe(2);
    expect(relevance?.reason).toBe(GENERIC_BUT_ON_FIELD.reason);
    expect(relevance?.note).toMatch(/no product-information document, no target-audience document and no page of the client's own site/);
    expect(relevance?.note).toMatch(/floor returns to 3\/5/);

    const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", ["ledger", "events", params.runId]);
    const warn = events.find((e) => e.data.eventId === `${params.runId}__relevance-thin-grounding-a1`);
    expect(warn).toBeDefined();
    expect(warn!.data.level).toBe("warn");
    expect(warn!.data.message).toMatch(/scored this post 2\/5 and it was accepted/);

    // A 1 on the same client is still off-brief: the relaxed floor moved the
    // line by one point, it did not remove it.
    expect(relevanceFloor(true)).toMatchObject({ minScore: THIN_GROUNDING_MIN_RELEVANCE_SCORE });
    expect(THIN_GROUNDING_MIN_RELEVANCE_SCORE).toBeLessThan(MIN_RELEVANCE_SCORE);
  }, 60000);

  it("a FULLY grounded brief keeps the normal floor: a 2/5 returns the draft to 05", async () => {
    // The same client with the two onboarding documents filled in. The brief
    // now describes a business, so a 2 ("a different business in the same
    // field could have posted this") is a real finding and the gate acts on
    // it exactly as before.
    await env.store.writeJson("acme", ["context", "product-information"], {
      markdown: "# Product information\n\nKaros Labs sells a managed AI content engine: weekly Instagram, X and LinkedIn posts drafted by agents and approved by the client's editor.",
    });
    await env.store.writeJson("acme", ["context", "target-audience"], {
      markdown: "# Target audience\n\nFounders and heads of marketing at seed to series B B2B software companies, usually a team of one to three doing marketing part time.",
    });
    const router = fakeRouterSequence([
      ...auditTurns({ relevance: { score: 2, reason: "any agency in this field could have posted it", missingBridge: "name the managed content engine" }, qa: undefined }),
      ...standardTurns({ copy: goodCopyOutput(), vet: goodImageVettingOutput(), relevance: goodRelevanceVerdict(), qa: goodVisualQaOutput() }),
    ]);
    const params = { runId: "instagram_run_grounding_full_brief", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status).toBe("completed");

    const brief = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief } };
    expect(brief.output.brief.sources.filter((s) => s.kind === "context-doc").map((s) => s.ref)).toEqual(
      expect.arrayContaining(["product-information", "target-audience"]),
    );
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { relevance?: { score: number; note?: string } } } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables[0]!.data.deliverable.grounding?.relevance?.score).toBe(5);
    expect(deliverables[0]!.data.deliverable.grounding?.relevance?.note).toBeUndefined();
  }, 60000);

  it("a judge that cannot answer fails OPEN: the run delivers on attempt 1 and the ledger carries the unavailable warn", async () => {
    // `score: "high"` fails the judge's own output schema inside BaseAgent -> content_fail -> verdict `error`.
    const router = fakeRouterSequence(auditTurns({ relevance: { score: "high", reason: "reads fine" } }));
    const params = { runId: "instagram_run_grounding_judge_down", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07g-relevance-attempt-1");
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", ["ledger", "events", params.runId]);
    const warn = events.find((e) => e.data.eventId === `${params.runId}__relevance-judge-unavailable-a1`);
    expect(warn).toBeDefined();
    expect(warn!.data.level).toBe("warn");
    expect(warn!.data.message).toMatch(/could not run/);

    // The gate/deliverable still says the brief was used, and that no relevance verdict exists.
    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { briefSource: string; relevance?: unknown } } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.grounding?.briefSource).toBe("derived");
    expect(deliverables[0]!.data.deliverable.grounding?.relevance).toBeUndefined();
  }, 60000);

  it("04a2-research-pull-deep searches the GROUNDED query, not the verbatim request, and 02i's derived brief is schema-valid", async () => {
    const router = fakeRouterSequence(auditTurns());
    const params = { runId: "instagram_run_grounding_query", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status).toBe("completed");

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief; source: string } };
    expect(briefStep.output.source).toBe("derived");
    expect(ClientBriefSchema.safeParse(briefStep.output.brief).success).toBe(true);
    expect(briefStep.output.brief.generatedBy).toBe("deterministic");
    expect(briefStep.output.brief.coreTerms).toContain("marketing");
    expect(briefStep.output.brief.forbidden.topics).toEqual([]);

    // Phase 1 (item J) retired `04a-research-pull` for the three-lane
    // `04a2-research-pull-deep`. The grounded query is unchanged — it is now
    // the NEWS lane's first and best question, and the lane record is what
    // makes every billed question auditable from the trace alone (Phase 0's
    // `groundedQuery`/`rewrittenFrom`/`fallbackUsed` fields were only ever
    // that same audit trail for a single-question step).
    const deep = (await durableStore.getStep(params.runId, "04a2-research-pull-deep")) as {
      output: { lanes: Array<{ lane: string; queries: Array<{ query: string; status: string }> }>; documentCount: number };
    };
    const news = deep.output.lanes.find((l) => l.lane === "news")!;
    const groundedQuery = news.queries[0]!.query;
    expect(groundedQuery).toContain(" in the context of ");
    expect(groundedQuery).toMatch(/^the new offer to first-time buyers in the context of /);
    expect(groundedQuery).not.toBe(AUDIT_REQUEST);
    expect(groundedQuery.length).toBeLessThanOrEqual(200);
    // The fallback Phase 0 only asked after an empty answer is now the news
    // lane's second question, asked every time.
    expect(news.queries.length).toBeGreaterThan(1);
    expect(deep.output.documentCount).toBeGreaterThan(0);
  }, 60000);
});
