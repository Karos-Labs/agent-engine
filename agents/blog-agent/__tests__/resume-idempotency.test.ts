import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "blog_run_resume", clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step. */
function spyOnAllTools(tools: AgentToolRegistry): { spied: AgentToolRegistry; callCounts: () => Record<string, number> } {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const spied: AgentToolRegistry = {};
  for (const [name, tool] of Object.entries(tools)) {
    const spy = vi.fn(tool.execute.bind(tool));
    spies[name] = spy;
    spied[name] = { ...tool, execute: spy } as AgentToolRegistry[string];
  }
  return {
    spied,
    callCounts: () => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length])),
  };
}

function goodDraft() {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  const bodyMarkdown =
    "## The problem with our old onboarding\n\n" +
    "New engineers took nearly a month before they shipped anything meaningful, and that gap was not caused by a lack of ability. " +
    "Most new hires spent the bulk of their first three weeks trying to figure out who to ask about a given system, which service " +
    "actually owned a piece of logic, and where the current version of a runbook lived. The technical material itself was rarely the " +
    "blocker. A new engineer could read the codebase just fine; what slowed everyone down was the absence of a predictable path through " +
    "that first week. Every cohort effectively reinvented onboarding from scratch, asking the same scattered questions in Slack channels " +
    "that had already answered them for someone else three months earlier. Managers noticed the pattern in retrospectives long before " +
    "anyone treated it as a process problem worth fixing directly, and for a while the informal fix was simply to assign a buddy and hope " +
    "the pairing worked out. Some pairings worked well. Many did not, and there was no consistent floor under the experience regardless " +
    "of which engineer happened to be free that week.\n\n" +
    "## What we actually changed\n\n" +
    "We restructured the first week into four fixed days, each with a specific and narrow goal instead of a loose list of things a new " +
    "hire should eventually get around to. Day one was environment setup end to end: local build, test suite, and a single deploy to a " +
    "sandbox environment, so that by the end of day one every new engineer had proof their machine actually worked. Day two paired the " +
    "new hire with an engineer who walked through the two or three systems most relevant to their team, focusing on how pieces connect " +
    "rather than reading every file line by line. Day three handed the new hire a small, genuinely scoped ticket, chosen in advance by " +
    "their manager so nobody spent the morning hunting for something appropriate to work on. Day four closed the week with a short " +
    "review session involving the whole team, where the new hire walked through what they built and asked the questions that had piled " +
    "up over the previous three days. Nothing about the underlying technical content changed; the structure around it was the entire " +
    "intervention, and that distinction mattered enormously once we started measuring results.\n\n" +
    "## The results after one quarter\n\n" +
    "Across the twelve engineers who went through the new process, median time to first merged pull request dropped sharply [1], falling " +
    "from nineteen days down to about ten. Just as important, the variance between individual engineers narrowed sharply: under the old " +
    "approach some new hires needed six weeks before their first real contribution while others needed nine days, and that spread alone " +
    "made it hard to plan work around new team members with any confidence. Retention at the ninety-day mark also held steady across the " +
    "cohort, which mattered to us as much as raw speed did, since a faster ramp that came at the cost of early attrition would not have " +
    "been a real win. Manager-reported confidence in new hires by the end of week one rose noticeably too, even though that metric is " +
    "harder to quantify cleanly than a pull request timestamp.\n\n" +
    "## What we would do differently\n\n" +
    "The biggest gap in our first run was documentation for the paired-engineer session on day two: two different pairs ran that session " +
    "in noticeably different ways, and new hires noticed the inconsistency immediately when they compared notes with each other. If your " +
    "team decides to try something similar, write the walkthrough script down before your first cohort goes through it, not after you " +
    "have already seen where it went sideways. We also underestimated how much day three depended on managers actually preparing a " +
    "ticket in advance; the one cohort where a manager scrambled to find a ticket the morning of day three was the one week where the " +
    "whole schedule slipped.\n\n" +
    "If your team is rethinking its own onboarding process, a structured first week is worth testing before you assume the underlying " +
    "problem is your documentation, your codebase, or your new hires themselves. The structure was the fix in our case, and it is worth " +
    "ruling out before reaching for a heavier one.";
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle.",
    bodyMarkdown,
    headersList: [
      "The problem with our old onboarding",
      "What we actually changed",
      "The results after one quarter",
      "What we would do differently",
    ],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 5,
    text: `${title}\n\n${bodyMarkdown}`,
    faqItems: [],
  };
}

describe("checkpoint resume idempotency (RFC-01 §8.1)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("re-running engine.run() with the same runId does not re-execute any already-completed step", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);
    const workflowFn = createBlogAgentWorkflow({ tools: spied, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("completed");
    const countsAfterFirst = callCounts();
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(Object.values(countsAfterFirst).some((n) => n > 0)).toBe(true);

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // Nothing ran again: the router turn, and every tool call, stayed at their first-run counts.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()).toEqual(countsAfterFirst);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords).toHaveLength(19);
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resumes correctly after a mid-run crash: earlier steps aren't redone, the run still reaches completed", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);

    // A wrapper that throws once persistence starts (after step 14), simulating a crash
    // partway through, then behaves normally afterwards.
    let deliverablePersisted = false;
    const crashOnceTools: AgentToolRegistry = {
      ...spied,
      "ledger.writeDeliverable": {
        ...spied["ledger.writeDeliverable"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          const result = await spied["ledger.writeDeliverable"]!.execute(input as never, opts as never);
          deliverablePersisted = true;
          return result;
        }),
      },
      "ledger.dashboardSnapshot": {
        ...spied["ledger.dashboardSnapshot"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          if (deliverablePersisted) {
            deliverablePersisted = false; // only crash the first time we get here
            throw new Error("simulated crash right after persisting the deliverable");
          }
          return spied["ledger.dashboardSnapshot"]!.execute(input as never, opts as never);
        }),
      },
    };
    const workflowFn = createBlogAgentWorkflow({ tools: crashOnceTools, promptStore, router, autoApprove: true });

    const runId = "blog_run_resume_crash";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("degraded");

    const stepsAfterCrash = await durableStore.listSteps(runId);
    const step16 = stepsAfterCrash.find((s) => s.stepId === "16-persist-deliverable");
    const step17 = stepsAfterCrash.find((s) => s.stepId === "17-persist-manifest");
    expect(step16?.status).toBe("completed");
    // step 17's own tool call threw, so its checkpoint is recorded but as "failed" — not
    // "completed" — which is exactly what makes step-code re-run it (not skip it) on resume.
    expect(step17?.status).toBe("failed");

    const draftCallCountAfterCrash = callCounts()["ledger.writeDeliverable"];
    expect(router.complete).toHaveBeenCalledTimes(1);

    const second = await engine.run(workflowFn, { ...params, runId });
    expect(second.status).toBe("completed");

    // The draft/persist step from before the crash was NOT redone; only the steps
    // after the crash point ran on resume.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()["ledger.writeDeliverable"]).toBe(draftCallCountAfterCrash);

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps).toHaveLength(19);
    expect(finalSteps.every((s) => s.status === "completed")).toBe(true);
  });
});
