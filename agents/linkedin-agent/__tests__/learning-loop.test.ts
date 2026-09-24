import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * C7 on linkedin-agent — SCRUM-466 (A1/A2 after X). The same acceptance
 * criteria x-agent's `learning-loop.test.ts` pins, in LinkedIn's own
 * vocabulary: `type` is the archetype, the record's audience falls back to
 * the prompt's `targetAudience`, and the deliverable kind is `linkedin-post`.
 */

const params = { runId: "li_learning_1", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:test" };
const envelope = (kind: string, data: unknown) => ({ kind, platform: "linkedin", data, source: SOURCE });

function goodPost(overrides: Record<string, unknown> = {}) {
  const hook = "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.";
  const body = "Teams with a fixed two-day in-office schedule reported fewer scheduling conflicts than teams with fully flexible policies.";
  const takeaway = "Predictability, not enforcement, is what made the schedule stick.";
  const callToAction = "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.";
  return {
    headline: "Anchor days cut scheduling friction",
    hook,
    body,
    takeaway,
    hashtags: ["HybridWork"],
    callToAction,
    targetAudience: "People leaders evaluating hybrid work policies",
    text: `${hook}\n\n${body}\n\n${takeaway}\n\n${callToAction}\n\n#HybridWork`,
    archetype: "industry-reaction",
    ...overrides,
  };
}

function draftInputOf(router: ReturnType<typeof fakeRouterSequence>, callIndex = 0): Record<string, unknown> {
  const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex]!;
  return (JSON.parse(call[0] as string) as { input: Record<string, unknown> }).input;
}

async function projectAll(env: TestEnvironment): Promise<void> {
  await env.store.writeJson("acme", ["context", "learning", "linkedin", "platform-state"], envelope("platform-state", { postsByUs: 9, whatWorks: ["a first line that names the tension"], voiceNotes: ["no rhetorical openers"] }));
  await env.store.writeJson("acme", ["context", "learning", "linkedin", "subject-window"], envelope("subject-window", { windowDays: 30, rows: [{ subject: "async collaboration", stage: "attention", status: "posted", runId: "old-1" }] }));
  await env.store.writeJson("acme", ["context", "learning", "linkedin", "feedback"], envelope("feedback", { rows: [{ action: "change_requested", reason: "too long for a page post", at: "2026-09-11" }] }));
  await env.store.writeJson("acme", ["context", "learning", "linkedin", "strategy-map"], envelope("strategy-map", { rows: [{ id: "sm-li-003", problem: "managers cannot see burnout coming", stage: "expertise", idea: "The three signals of manager burnout a dashboard never shows", status: "open" }] }));
  await env.store.writeJson("acme", ["context", "learning", "linkedin", "craft"], envelope("craft", { rules: [{ id: "L1-li-001", layer: "L1", kind: "hard", rule: "No external link in the body" }] }));
  await env.store.writeJson("acme", ["context", "learning", "preferences"], { kind: "preferences", data: { neverTopics: ["four-day weeks"], standingInstructions: ["write as the company, never 'I'"] }, source: SOURCE });
}

describe("linkedin-agent and the learning loop (C7)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("with nothing projected, the run completes as before and its record says every file was absent", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      params,
    );
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    expect(input.slotStage).toBe("attention");
    for (const key of ["strategyRow", "platformState", "whatWorks", "craftRules", "clientFeedback", "clientPreferences"]) expect(input[key]).toBeUndefined();

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record).toBeDefined();
    expect(record!.readiness).toEqual({ present: [], absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"] });
    // D11: the goal line, and the audience the prompt already produced.
    expect(record!.deliverable).toMatchObject({ kind: "linkedin-post", goal: "attention", type: "industry-reaction", audience: "People leaders evaluating hybrid work policies" });
    expect(record!.subjectRow).toMatchObject({ subject: "hybrid work anchor days", status: "drafted", stage: "attention", goal: "earn attention", assetKind: "linkedin-post", strategyRowId: null });
    const state = await env.store.readJson<Record<string, unknown>>("acme", ["state", "linkedin", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 1, topics: ["hybrid work anchor days"], contributingRuns: [params.runId] });
  });

  it("with the files projected, every one reaches the drafting input; the record carries the model's goal line and rule ids", async () => {
    await projectAll(env);
    const router = fakeRouterSequence([finalTurn(goodPost({ goal: "expertise", audience: "ops leads whose hybrid policy changes weekly", whyNow: "the planned row", rulesApplied: ["L1-li-001"] }))]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, input: { slotStage: "expertise" } },
    );
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    expect(input.slotStage).toBe("expertise");
    expect(input.platformState).toEqual({ whatWorks: ["a first line that names the tension"], voiceNotes: ["no rhetorical openers"], postsByUs: 9 });
    expect(input.craftRules).toContain("- [L1-li-001] No external link in the body");
    expect(input.clientFeedback).toEqual(["Change requested (2026-09-11): too long for a page post"]);
    expect(input.clientPreferences).toEqual({ neverTopics: ["four-day weeks"], standingInstructions: ["write as the company, never 'I'"] });
    // The map's expertise row reaches the prompt — as the planned row the draft is written from, since the map now leads selection.
    expect(input.strategyRow).toEqual({ id: "sm-li-003", stage: "expertise", idea: "The three signals of manager burnout a dashboard never shows", problem: "managers cannot see burnout coming" });

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record!.readiness).toEqual({ present: ["platform-state", "subject-window", "feedback", "strategy-map", "craft", "preferences"], absent: ["what-works"] });
    expect(record!.deliverable).toMatchObject({ goal: "expertise", audience: "ops leads whose hybrid policy changes weekly", whyNow: "the planned row" });
    expect(record!.rulesApplied).toEqual(["L1-li-001"]);
  });

  it("the goal line reaches the card and the reviewer's formatting notes do not (C3 / SCRUM-457)", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodPost({ goal: "decide", audience: "ops leads picking a hybrid policy this quarter", whyNow: "the policy review lands in two weeks" })),
    ]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "li_goal_card" },
    );
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: Record<string, unknown> }>("acme", ["ledger", "deliverables", "li_goal_card", "_"]);
    const deliverable = deliverables[0]!.data.deliverable;
    const markdown = deliverable.draftsMarkdown as string;
    expect(markdown).toContain("- **Goal:** help them decide");
    expect(markdown).toContain("- **For:** ops leads picking a hybrid policy this quarter");
    expect(markdown).toContain("- **Why now:** the policy review lands in two weeks");

    // The shape check's notes are FOR THE REVIEWER; karosCMO renders every
    // `metaFields` name onto the client's asset, so they must not be here.
    expect(deliverable.formattingNotes).toBeUndefined();

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "li_goal_card"]);
    expect(record!.deliverable).toMatchObject({ goal: "decide", whyNow: "the policy review lands in two weeks" });
  });

  it("with the model silent, the card carries the run's stage and the prompt's own audience line", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "li_goal_fallback" },
    );
    expect(result.status).toBe("completed");
    const deliverables = await env.store.listJson<{ deliverable: { draftsMarkdown: string } }>("acme", ["ledger", "deliverables", "li_goal_fallback", "_"]);
    const markdown = deliverables[0]!.data.deliverable.draftsMarkdown;
    expect(markdown).toContain("- **Goal:** earn attention");
    expect(markdown).toContain("- **For:** People leaders evaluating hybrid work policies");
  });

  it("a never-topic REFUSES an explicit request and writes something else; the window and the never list skip catalog rows", async () => {
    await projectAll(env);
    // Two turns now, not one: refusing the request no longer ends the run
    // before drafting, so this run actually writes a post about something else
    // (and may spend a repair turn doing it).
    const refusedRouter = fakeRouterSequence([finalTurn(goodPost()), finalTurn(goodPost()), finalTurn(goodPost())]);
    const refusedStore = new MemoryDurableStepStore();
    const refused = await new WorkflowEngine(refusedStore).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: refusedRouter, autoApprove: true }),
      { ...params, runId: "li_learning_held", input: { requestedTopic: "four-day weeks for ops teams" } },
    );

    // The client's rule is absolute and unchanged: the requested subject is
    // NOT written about. What changed is that the run now writes about
    // something the account IS allowed to discuss, and tells whoever asked
    // that their request was declined — instead of ending with an error and
    // no post.
    expect(refused.status).toBe("completed");
    if (refused.status !== "completed") throw new Error("unreachable");
    expect(refused.output.topic).not.toMatch(/four-day weeks/i);

    const refusedSelection = (await refusedStore.listSteps("li_learning_held")).find((st) => st.stepId === "07-select-candidate")!.output as {
      refusedRequest?: string;
    };
    expect(refusedSelection.refusedRequest).toMatch(/never-topic/);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "li_learning_held", "_"]);
    const post = (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
    expect(post["contentRepairs"]).toContainEqual(
      expect.objectContaining({ check: "never-topic", action: "substituted", detail: expect.stringMatching(/four-day weeks/i) }),
    );

  });

  /**
   * THE ORDER (2026-09-24, owner's ruling): the strategy map leads — ahead of
   * an available catalog topic and the scout — and the catalog topic this run
   * reserved goes back to the floor unused.
   */
  it("takes the strategy-map row ahead of an available catalog topic, skips the scout, and releases the unused reservation", async () => {
    await projectAll(env);
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "li_map_first", input: { slotStage: "expertise" } },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const steps = await store.listSteps("li_map_first");
    const selected = steps.find((s) => s.stepId === "07-select-candidate")!.output as { source: string; strategyRowId?: string };
    expect(selected.source).toBe("strategy");
    expect(selected.strategyRowId).toBe("sm-li-003");
    expect(result.output.topic).toBe("The three signals of manager burnout a dashboard never shows");
    expect(steps.map((s) => s.stepId)).not.toContain("07a-trend-scout");

    const reserve = steps.find((s) => s.stepId === "06-reserve-topic")!.output as { topics: string[] };
    expect(reserve.topics.length).toBe(1);
    const listed = await env.tools["topics.list"]!.execute({}, { ctx: { runId: "check", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring", metadata: {} } });
    expect(listed.status).toBe("success");
    if (listed.status !== "success") throw new Error("unreachable");
    const row = (listed.result as { rows: Array<{ topic: string; status: string }> }).rows.find((r) => r.topic === reserve.topics[0]);
    expect(row?.status).toBe("available");
  });

  it("the subject window and the never list skip catalog rows, leaving the strategy map as the next honest candidate", async () => {
    await projectAll(env);
    // Reserve-and-commit the first catalog row, which the sibling test above
    // used to do as a side effect of its own run. Doing it explicitly keeps
    // the two tests independent: this one is about SELECTION PRECEDENCE, and
    // it should not depend on how another test happens to consume the catalog.
    const firstCtx = { runId: "seed-first", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const, metadata: {} };
    const first = await env.tools["topics.reserve"]!.execute({ reservationKey: "seed__first", count: 1 }, { ctx: firstCtx });
    expect(first.status).toBe("success");
    await env.tools["topics.commit"]!.execute({ reservationKey: "seed__first" }, { ctx: firstCtx });

    // Catalog: hybrid work anchor days → async collaboration → manager
    // burnout. The held run above already reserved the first at its step 06;
    // drain the third, so the one catalog row left IS in the subject window,
    // nothing in the catalog survives, and the map's row for this stage is
    // the next honest candidate.
    const seedCtx = { runId: "seed", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const, metadata: {} };
    const drained = await env.tools["topics.reserve"]!.execute({ reservationKey: "drain__topic", count: 1, excludeTopics: ["async collaboration"] }, { ctx: seedCtx });
    expect(drained.status).toBe("success");
    await env.tools["topics.commit"]!.execute({ reservationKey: "drain__topic" }, { ctx: seedCtx });

    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "li_learning_skip", input: { slotStage: "expertise" } },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBe("The three signals of manager burnout a dashboard never shows");
    const selected = (await store.listSteps("li_learning_skip")).find((s) => s.stepId === "07-select-candidate")!.output as { source: string; strategyRowId?: string };
    expect(selected.source).toBe("strategy");
    expect(selected.strategyRowId).toBe("sm-li-003");
    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "li_learning_skip"]);
    expect(record!.subjectRow).toMatchObject({ strategyRowId: "sm-li-003", stage: "expertise" });
    expect((record!.deliverable as { whyNow: string }).whyNow).toMatch(/strategy map/);
  });
});
