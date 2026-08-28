import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createCampaignWorkflow } from "../src/workflow/create-campaign-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCampaignPlan,
  goodChannelDraft,
  makeCampaignPromptStore,
  makeChannelPromptStores,
  makeChannelRouters,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "campaign_run_gate_payload", clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };

/**
 * SCRUM-302 / AU18.
 *
 * campaign-orchestrator forces `autoApprove: true` on every channel in its
 * fan-out, so `13-campaign-review` was the ONLY human surface for the whole
 * bundle — and until this fix, that gate's own payload was
 * `{campaignName, theme, channelResults}` where every `channelResults[i]` was
 * `{slotId, channel, status, deliverableId}`. A reviewer approving a campaign
 * saw five opaque ids and never the drafted copy any of the five bypassed
 * per-channel gates would have shown them.
 */
describe("SCRUM-302/AU18: the campaign gate reviews real per-channel content, and a plan-level guardrail exists", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("acme");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("13-campaign-review's own gate payload carries each channel's actual drafted text, not just a deliverableId", async () => {
    const campaignRouter = fakeRouterSequence([finalTurn(goodCampaignPlan())]);
    const channelRouters = makeChannelRouters();

    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: campaignRouter,
      channelPromptStores: makeChannelPromptStores(),
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");

    // Read the gate record directly -- this is exactly what a reviewer's own
    // approval screen would be built from, BEFORE anyone approves anything.
    const gate = await durableStore.getGate(`${params.runId}__13-campaign-review`);
    expect(gate).toBeDefined();
    const payload = gate!.payload as {
      channelResults: Array<{ channel: string; status: string; deliverableId?: string; preview?: string }>;
    };

    expect(payload.channelResults).toHaveLength(5);
    for (const channel of ["x", "linkedin", "reddit", "blog", "newsletter"] as const) {
      const result = payload.channelResults.find((r) => r.channel === channel);
      expect(result?.status).toBe("completed");
      // The exact text the standalone channel's own (bypassed) gate would
      // have carried as `preview` -- see goodChannelDraft()'s `text` field.
      const expectedText = (goodChannelDraft(channel) as { text: string }).text;
      expect(result?.preview).toBe(expectedText);
    }
  });

  it("a campaign plan that engages a forbidden topic is blocked by the campaign-level guardrail before any channel drafts", async () => {
    // Distinct from every per-channel guardrail (which only ever sees ITS OWN
    // channel's later draft): this is the plan itself -- campaignName, theme,
    // targetPillars and each slot's targetAudience/angle/keyMessage -- which
    // previously had no guardrail at all and was never checked against this
    // client's forbidden topics before five channels drafted against it.
    await env.store.writeJson("acme", ["client", "config"], {
      xHandle: "@acmecorp",
      targetSubreddits: ["smallbusiness", "startups"],
      requestedThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/our_team_switched_to_a_4day_week/",
      requestedThreadTitle: "Our team switched to a 4-day week 3 months ago: sharing what actually changed",
      targetKeywords: ["engineering onboarding", "developer ramp-up time"],
      contentPillars: ["engineering culture", "team operations"],
      targetAudience: "engineering leaders at mid-size B2B SaaS companies",
      frequency: "weekly",
      campaignGoals: "Launch awareness for the new structured-onboarding product feature across every channel this quarter.",
      forbiddenTopics: ["cryptocurrency"],
    });

    const plan = goodCampaignPlan();
    plan.theme = "Why every engineering team should hold cryptocurrency on its balance sheet";

    const campaignRouter = fakeRouterSequence([
      finalTurn(plan),
      // The guardrail verifier's own turn, run against the plan text above.
      finalTurn({ violatedTopics: ["cryptocurrency"] }),
    ]);
    const channelRouters = makeChannelRouters();

    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: campaignRouter,
      channelPromptStores: makeChannelPromptStores(),
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...params, runId: "campaign_run_guardrail" });
    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toMatch(/topic guardrail/i);

    // Blocked before the fan-out ever spent a single channel draft.
    for (const channel of ["x", "linkedin", "reddit", "blog", "newsletter"] as const) {
      expect(channelRouters[channel].complete).not.toHaveBeenCalled();
    }
  });

  it("costs nothing extra for a client that forbids no topics (existing behaviour, unchanged)", async () => {
    const campaignRouter = fakeRouterSequence([finalTurn(goodCampaignPlan())]);
    const channelRouters = makeChannelRouters();

    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: campaignRouter,
      channelPromptStores: makeChannelPromptStores(),
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    await engine.run(workflowFn, { ...params, runId: "campaign_run_no_forbidden_topics" });

    // Only the strategy-plan turn -- no guardrail-verifier turn was spent.
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);
    const stepIds = (await durableStore.listSteps("campaign_run_no_forbidden_topics")).map((s) => s.stepId);
    expect(stepIds).not.toContain("guardrail-verify");
  });
});
