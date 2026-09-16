import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * C7 (`docs/contracts/C7-run-context.md`) on x-agent — SCRUM-459 (A1: the
 * run reads the live learning context) and SCRUM-460 (A2: the run writes its
 * state back). The acceptance criteria on both tickets, as tests:
 *
 *  - with nothing projected the run behaves as before and its record says
 *    every file was absent;
 *  - with the files projected, every one reaches the drafting input;
 *  - a never-topic holds an explicit request and skips a catalog row;
 *  - a subject already in the window is not proposed again;
 *  - the state record and the platform state exist after the run, with the
 *    D11 goal line and the rule ids the draft applied.
 */

const params = { runId: "x_learning_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:test" };
const envelope = (kind: string, data: unknown) => ({ kind, platform: "x", data, source: SOURCE });

function goodPost(overrides: Record<string, unknown> = {}) {
  return {
    text: "Remote work is where mid-sized teams are quietly winning this quarter.",
    mainPostText: "Remote work is where mid-sized teams are quietly winning this quarter.",
    hook: "Remote work is where mid-sized teams are quietly winning this quarter.",
    angle: "trend-observation",
    lane: "knowledge",
    targetHandle: "@acmehq",
    ...overrides,
  };
}

/** The `input` the fake router saw on its Nth call, parsed out of BaseAgent's turn prompt. */
function draftInputOf(router: ReturnType<typeof fakeRouterSequence>, callIndex = 0): Record<string, unknown> {
  const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex]!;
  const prompt = JSON.parse(call[0] as string) as { input: Record<string, unknown> };
  return prompt.input;
}

async function projectAll(env: TestEnvironment): Promise<void> {
  await env.store.writeJson("acme", ["context", "learning", "x", "platform-state"], envelope("platform-state", { postsByUs: 14, whatWorks: ["a number in the first line"], voiceNotes: ["short declaratives"], topPosts: [{ url: "https://x.com/acmehq/status/1", why: "a benchmark first", metric: "4.1% replies/impression" }] }));
  await env.store.writeJson("acme", ["context", "learning", "x", "subject-window"], envelope("subject-window", { windowDays: 30, rows: [{ subject: "hybrid teams", stage: "attention", status: "posted", runId: "old-1" }] }));
  await env.store.writeJson("acme", ["context", "learning", "x", "feedback"], envelope("feedback", { rows: [{ action: "skipped", reason: "too salesy", at: "2026-09-10" }] }));
  await env.store.writeJson("acme", ["context", "learning", "x", "what-works"], envelope("what-works", { rules: [{ id: "L3-acme-x-001", rule: "Open with a number", sampleSize: 12 }] }));
  await env.store.writeJson("acme", ["context", "learning", "x", "strategy-map"], envelope("strategy-map", { rows: [{ id: "sm-x-007", problem: "intake breaks in month two", stage: "attention", idea: "Why intake queues break in month two", status: "open" }] }));
  await env.store.writeJson("acme", ["context", "learning", "x", "craft"], envelope("craft", { rules: [{ id: "L1-x-003", layer: "L1", kind: "hard", rule: "No link in the post body" }, { id: "L2-saas-x-002", layer: "L2", kind: "default", rule: "Lead with a benchmark", metric: "replies" }] }));
  await env.store.writeJson("acme", ["context", "learning", "preferences"], { kind: "preferences", data: { neverTopics: ["four-day weeks"], standingInstructions: ["never mention competitors by name"], voiceNotes: [{ lesson: "cut the second adjective" }] }, source: SOURCE });
}

describe("x-agent and the learning loop (C7)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("with nothing projected, the run completes as before and its record says every file was absent", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }), params);
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    // The stage is always present (D32 default: a fresh funnel starts at attention); nothing else from the loop is.
    expect(input.slotStage).toBe("attention");
    for (const key of ["strategyRow", "platformState", "whatWorks", "craftRules", "clientFeedback", "clientPreferences"]) expect(input[key]).toBeUndefined();

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record).toBeDefined();
    expect(record!.readiness).toEqual({ present: [], absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"] });
    // D11: a goal line even when the model stated none — the stage the run was written for.
    expect(record!.deliverable).toMatchObject({ kind: "x-post", goal: "attention", type: "knowledge" });
    expect(record!.subjectRow).toMatchObject({ subject: "remote work", status: "drafted", stage: "attention", goal: "earn attention", strategyRowId: null });
    const state = await env.store.readJson<Record<string, unknown>>("acme", ["state", "x", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 1, topics: ["remote work"], account: { handle: "@acmehq" }, contributingRuns: [params.runId] });
  });

  it("with the files projected, every one reaches the drafting input in the shape the prompt reads", async () => {
    await projectAll(env);
    const router = fakeRouterSequence([finalTurn(goodPost({ goal: "attention", audience: "ops leads whose intake breaks in month two", whyNow: "the planned row for this stage", rulesApplied: ["L1-x-003", "L2-saas-x-002"] }))]);
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }), { ...params, input: { slotStage: "attention" } });
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    expect(input.slotStage).toBe("attention");
    expect(input.platformState).toEqual({ whatWorks: ["a number in the first line"], voiceNotes: ["short declaratives"], topPosts: [{ why: "a benchmark first", metric: "4.1% replies/impression", url: "https://x.com/acmehq/status/1" }], postsByUs: 14 });
    expect(input.whatWorks).toEqual({ rules: [{ id: "L3-acme-x-001", rule: "Open with a number", sampleSize: 12 }] });
    expect(input.craftRules).toContain("- [L1-x-003] No link in the post body");
    expect(input.craftRules).toContain("- [L2-saas-x-002] (L2) Lead with a benchmark (moves: replies)");
    expect(input.clientFeedback).toEqual(["Skipped (2026-09-10): too salesy"]);
    expect(input.clientPreferences).toEqual({ neverTopics: ["four-day weeks"], standingInstructions: ["never mention competitors by name"], voiceLessons: ["cut the second adjective"] });
    // The seeded catalog ("remote work", "hybrid teams", "four-day weeks") still
    // outranks the strategy map, so the row is handed to the prompt as context
    // and not taken as the topic.
    expect(input.strategyRow).toEqual({ id: "sm-x-007", stage: "attention", idea: "Why intake queues break in month two", problem: "intake breaks in month two" });

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record!.readiness).toEqual({ present: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"], absent: [] });
    expect(record!.deliverable).toMatchObject({ goal: "attention", audience: "ops leads whose intake breaks in month two", whyNow: "the planned row for this stage" });
    expect(record!.rulesApplied).toEqual(["L1-x-003", "L2-saas-x-002"]);
  });

  it("a never-topic HOLDS an explicit request, and a subject in the window or a never-topic skips a catalog row", async () => {
    await projectAll(env);
    // Requested topic touches the never-topic → held, no model call spent.
    const heldRouter = fakeRouterSequence([finalTurn(goodPost())]);
    const held = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: heldRouter, autoApprove: true }),
      { ...params, runId: "x_learning_held", input: { requestedTopic: "four-day weeks for ops teams" } },
    );
    expect(held.status).toBe("held");
    if (held.status !== "held") throw new Error("unreachable");
    expect(held.reason).toMatch(/never-topic/);
    expect((heldRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);

    // Catalog order is remote work → hybrid teams → four-day weeks. Drain
    // "remote work" so the first candidate is the one in the window.
    const seedCtx = { runId: "seed", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const, metadata: {} };
    const drained = await env.tools["topics.reserve"]!.execute({ reservationKey: "drain__topic", count: 1, excludeTopics: [] }, { ctx: seedCtx });
    expect(drained.status).toBe("success");
    await env.tools["topics.commit"]!.execute({ reservationKey: "drain__topic" }, { ctx: seedCtx });

    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }), { ...params, runId: "x_learning_skip" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // "hybrid teams" is in the subject window and "four-day weeks" is a
    // never-topic, so neither catalog row survives; the strategy map's open
    // row is the next honest candidate, above the research fallback.
    expect(result.output.topic).toBe("Why intake queues break in month two");
    const selected = (await store.listSteps("x_learning_skip")).find((s) => s.stepId === "07-select-candidate")!.output as { source: string; strategyRowId?: string };
    expect(selected.source).toBe("strategy");
    expect(selected.strategyRowId).toBe("sm-x-007");
    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "x_learning_skip"]);
    expect(record!.subjectRow).toMatchObject({ subject: "Why intake queues break in month two", strategyRowId: "sm-x-007" });
    expect((record!.deliverable as { whyNow: string }).whyNow).toMatch(/strategy map/);
  });
});
