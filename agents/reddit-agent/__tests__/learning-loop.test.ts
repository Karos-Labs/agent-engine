import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
  DEFAULT_TARGET_THREAD_TITLE,
  DEFAULT_TARGET_THREAD_URL,
  fakeRouterSequence,
  finalTurn,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * C7 on reddit-agent — SCRUM-466. A reply's subject is the thread's, so the
 * loop attaches where Reddit decides things: the requested thread is refused
 * when its title touches a never-topic; the craft, feedback, preferences and
 * platform state reach the reply prompt; and the run writes one subject row
 * per reply, `type: "reddit-reply"`, with no strategy row.
 */

const params = { runId: "reddit_learning_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:test" };
const envelope = (kind: string, data: unknown) => ({ kind, platform: "reddit", data, source: SOURCE });

function goodDraft(overrides: Record<string, unknown> = {}) {
  const replyBody =
    "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
    "Sick days dropped noticeably across the team, and shipped feature count stayed roughly flat.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
    ...overrides,
  };
}

function draftInputOf(router: ReturnType<typeof fakeRouterSequence>): Record<string, unknown> {
  const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
  return (JSON.parse(call[0] as string) as { input: Record<string, unknown> }).input;
}

describe("reddit-agent and the learning loop (C7)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("with nothing projected, the run completes as before and writes one reply row with every file absent", async () => {
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      params,
    );
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    expect(input.slotStage).toBe("attention");
    for (const key of ["platformState", "whatWorks", "craftRules", "clientFeedback", "clientPreferences"]) expect(input[key]).toBeUndefined();

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record).toBeDefined();
    expect(record!.readiness).toEqual({ present: [], absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"] });
    expect(record!.deliverable).toMatchObject({ kind: "reddit-reply", goal: "attention", type: "reddit-reply" });
    expect((record!.deliverable as { whyNow: string }).whyNow).toContain("r/smallbusiness");
    expect(record!.subjectRow).toMatchObject({ subject: DEFAULT_TARGET_THREAD_TITLE, type: "reddit-reply", status: "drafted", stage: "attention", goal: "earn attention", assetKind: "reddit-reply", strategyRowId: null });
    const state = await env.store.readJson<Record<string, unknown>>("acme", ["state", "reddit", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 1, topics: [DEFAULT_TARGET_THREAD_TITLE], contributingRuns: [params.runId] });
  });

  it("with the files projected, the reply prompt reads them, the never-topics join the off-limits list, and the record carries the goal line", async () => {
    await env.store.writeJson("acme", ["context", "learning", "reddit", "platform-state"], envelope("platform-state", { postsByUs: 3, whatWorks: ["answer the constraint in the body first"] }));
    await env.store.writeJson("acme", ["context", "learning", "reddit", "feedback"], envelope("feedback", { rows: [{ action: "skipped", reason: "reads like an ad", at: "2026-09-12" }] }));
    await env.store.writeJson("acme", ["context", "learning", "reddit", "craft"], envelope("craft", { rules: [{ id: "L1-reddit-002", layer: "L1", kind: "hard", rule: "Never link to the client's site in a reply" }] }));
    await env.store.writeJson("acme", ["context", "learning", "preferences"], { kind: "preferences", data: { neverTopics: ["crypto payroll"], voiceNotes: [{ lesson: "shorter first paragraph" }] }, source: SOURCE });

    const router = fakeRouterSequence([finalTurn(goodDraft({ goal: "expertise", audience: "a founder trialling a shorter week", whyNow: "a live trial report", rulesApplied: ["L1-reddit-002"] }))]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, input: { slotStage: "expertise" } },
    );
    expect(result.status).toBe("completed");

    const input = draftInputOf(router);
    expect(input.slotStage).toBe("expertise");
    expect(input.platformState).toEqual({ whatWorks: ["answer the constraint in the body first"], postsByUs: 3 });
    expect(input.craftRules).toContain("- [L1-reddit-002] Never link to the client's site in a reply");
    expect(input.clientFeedback).toEqual(["Skipped (2026-09-12): reads like an ad"]);
    expect(input.clientPreferences).toEqual({ neverTopics: ["crypto payroll"], voiceLessons: ["shorter first paragraph"] });
    expect((input.charter as { offLimitsTopics: string[] }).offLimitsTopics).toContain("crypto payroll");

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record!.readiness).toEqual({ present: ["platform-state", "feedback", "craft", "preferences"], absent: ["subject-window", "what-works", "strategy-map"] });
    expect(record!.deliverable).toMatchObject({ goal: "expertise", audience: "a founder trialling a shorter week", whyNow: "a live trial report" });
    expect(record!.rulesApplied).toEqual(["L1-reddit-002"]);
  });

  it("a requested thread whose title touches a never-topic HOLDS before any model call", async () => {
    await env.store.writeJson("acme", ["context", "learning", "preferences"], { kind: "preferences", data: { neverTopics: ["4-day week"] }, source: SOURCE });
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      params,
    );
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/never-topic/);
    expect((router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });
});
