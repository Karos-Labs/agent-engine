import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  goodImageCandidatePool,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * C7 on instagram-agent (SCRUM-459/460/464, D11, D17).
 *
 * The four assertions `docs/AGENT-ARCHITECTURE.md` §5 requires of every agent,
 * plus the one this platform has that the others do not: D17 says the format is
 * chosen by what performs on this account, never by a rotation, and the rotation
 * is what was there before.
 *
 * What is deliberately NOT asserted here is a rendered pixel. Every expectation
 * reads the drafting input, the persisted deliverable or the run record — the
 * renderer is swapped for the Chromium-free stand-in the rest of the suite uses.
 */

const params = { runId: "instagram_learning_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:test" };
const envelope = (kind: string, data: unknown) => ({ kind, platform: "instagram", data, source: SOURCE });

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** The whole C7 §2 set, so one call covers "the loop is live for this client". */
async function projectAll(env: TestEnvironment): Promise<void> {
  await env.store.writeJson("acme", ["context", "learning", "instagram", "platform-state"], envelope("platform-state", {
    account: { handle: "@acmehq" },
    postsByUs: 9,
    whatWorks: ["a number in the first slide"],
    voiceNotes: ["short declaratives; never a rhetorical question opener"],
  }));
  await env.store.writeJson("acme", ["context", "learning", "instagram", "subject-window"], envelope("subject-window", {
    windowDays: 30,
    rows: [{ id: "r1", runId: "earlier", subject: "onboarding handover checklists", stage: "expertise", status: "posted" }],
  }));
  await env.store.writeJson("acme", ["context", "learning", "instagram", "feedback"], envelope("feedback", {
    rows: [{ action: "skipped", reason: "reads like a brochure", at: "2026-09-12" }],
  }));
  await env.store.writeJson("acme", ["context", "learning", "instagram", "what-works"], envelope("what-works", {
    outliers: [{ postRef: "p1", trait: "carousel", lift: 2.4 }, { postRef: "p2", trait: "single", lift: 1.2 }],
  }));
  await env.store.writeJson("acme", ["context", "learning", "instagram", "craft"], envelope("craft", {
    rules: [{ id: "L1-instagram-004", layer: "L1", kind: "hard", rule: "Body copy never smaller than 32 canvas px" }],
  }));
  await env.store.writeJson("acme", ["context", "learning", "preferences"], {
    kind: "preferences",
    data: { neverTopics: ["redundancies"], voiceNotes: [{ lesson: "no exclamation marks" }] },
    source: SOURCE,
  });
}

describe("instagram-agent and the learning loop (C7)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("with nothing projected, the run completes as before and the record says all seven are absent", async () => {
    const router = fakeRouterSequence(happyTurns());
    const durableStore = new MemoryDurableStepStore();
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
    expect(result.status).toBe("completed");

    // The drafting prompt is byte-identical to what it was before the loop
    // landed for a client nobody has projected anything for — which is the
    // invariant that let this land without waiting for the middleware.
    const input = copyTurnInputs(router)[0]!;
    for (const key of ["craftRules", "clientFeedback", "clientPreferences", "platformState", "strategyRow"]) {
      expect(input[key], `${key} must be absent when nothing is projected`).toBeUndefined();
    }
    expect(input.slotStage).toBe("attention");

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record).toBeDefined();
    expect(record!.readiness).toEqual({
      present: [],
      absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"],
    });
  });

  it("with the files projected, every one of them reaches the copy prompt", async () => {
    await projectAll(env);
    const router = fakeRouterSequence(happyTurns());
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { ...params, runId: "instagram_learning_2" },
    );
    expect(result.status).toBe("completed");

    const input = copyTurnInputs(router)[0]!;
    expect(input.craftRules).toContain("[L1-instagram-004]");
    expect(input.clientFeedback).toEqual(["Skipped (2026-09-12): reads like a brochure"]);
    expect(input.clientPreferences).toEqual({ neverTopics: ["redundancies"], voiceLessons: ["no exclamation marks"] });
    expect(input.platformState).toMatchObject({ whatWorks: ["a number in the first slide"], postsByUs: 9 });
    // D32: one row in the window and it was `expertise`, so the stage most
    // behind its 3/2/1 share is `attention`.
    expect(input.slotStage).toBe("attention");

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "instagram_learning_2"]);
    expect((record!.readiness as { present: string[] }).present).toEqual(
      expect.arrayContaining(["platform-state", "subject-window", "feedback", "what-works", "craft", "preferences"]),
    );
  });

  it("the goal line reaches the client's card as a field, because there is no markdown to put a bullet in (C3 / D11)", async () => {
    const router = fakeRouterSequence(happyTurns());
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { ...params, runId: "instagram_learning_3" },
    );
    expect(result.status).toBe("completed");

    const carousel = await env.store.readJson<Record<string, unknown>>("acme", [
      "ledger",
      "deliverables",
      "instagram_learning_3",
      "_",
      "instagram-carousel",
    ]);
    expect(carousel, "the run must have written an instagram-carousel deliverable").toBeDefined();
    const goalLine = (carousel!.deliverable as Record<string, unknown>).goalLine as Record<string, unknown> | undefined;
    // The copy model states no goal today, so this is entirely the fallback
    // path — which is the point: D11 holds for a silent model, and the card
    // and the record are resolved from the same object so they cannot drift.
    expect(goalLine).toBeDefined();
    expect(goalLine!.goal).toBe("attention");
    expect(goalLine!.goalText).toBe("earn attention");
    expect(typeof goalLine!.whyNow).toBe("string");
    expect((goalLine!.whyNow as string).length).toBeGreaterThan(0);

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "instagram_learning_3"]);
    expect(record!.deliverable).toMatchObject({ kind: "instagram-carousel", goal: goalLine!.goal, whyNow: goalLine!.whyNow });
    expect(record!.subjectRow).toMatchObject({ status: "drafted", assetKind: "instagram-carousel", stage: "attention" });
  });

  it("a typed request for a never-topic HOLDS, before any model call", async () => {
    await env.store.writeJson("acme", ["context", "learning", "preferences"], {
      kind: "preferences",
      data: { neverTopics: ["redundancies"] },
      source: SOURCE,
    });
    const router = fakeRouterSequence(happyTurns());
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { ...params, runId: "instagram_learning_4", input: { requestedTopic: "how we handled redundancies last quarter" } },
    );

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/never-topic/);
    expect(result.reason).toMatch(/redundancies/);
    // A refusal that costs a model call is a refusal that arrived too late.
    expect(router.complete).not.toHaveBeenCalled();
  });

  it("the format follows what performs on this account, not the rotation (D17)", async () => {
    // Two outliers, and `single` is the one this account's numbers favour. The
    // rotation would have said `carousel` here, which is exactly the decision
    // D17 removed: "never by a fixed ratio or rotation".
    await env.store.writeJson("acme", ["context", "learning", "instagram", "what-works"], envelope("what-works", {
      outliers: [{ postRef: "p1", trait: "single", lift: 3.0 }, { postRef: "p2", trait: "carousel", lift: 1.05 }],
    }));
    // The loop has to be live for the read to report anything at all, and one
    // projected file is what "live" means (C7 §4.1).
    const router = fakeRouterSequence(happyTurns());
    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { ...params, runId: "instagram_learning_5" },
    );

    const steps = await durableStore.listSteps("instagram_learning_5");
    const formatStep = steps.find((s) => s.stepId === "04h-select-format");
    expect(formatStep, "04h must have run").toBeDefined();
    const output = formatStep!.output as { format: string; source: string };
    expect(output.format).toBe("single");
    expect(output.source).toMatch(/^performance:/);
    // And the sentence a reviewer reads names the number, so they can disagree
    // with the lift rather than with the verdict.
    expect(output.source).toMatch(/3\.0×/);
  });
});
