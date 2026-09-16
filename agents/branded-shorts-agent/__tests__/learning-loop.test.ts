import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBrandedShortsAgentWorkflow } from "../src/workflow/create-branded-shorts-agent-workflow.js";
import { goodGraphicsPlan, goodHighlights, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * C7 on the EDITING agent — D08's third TikTok product (SCRUM-455/459/460).
 *
 * This is the one of the three that chooses nothing: the client hands over a
 * finished video and says what it should leave the viewer with (D19 — on
 * demand, outside sequencing). So the loop attaches at the two ends that still
 * apply — the client's standing preferences at intake, and the asset handed
 * back at the end — and there is deliberately no strategy map, because there
 * is no subject to pick.
 *
 * Until D08's product table landed this agent mapped to no platform, so every
 * run of it was dispatched with no learning context and collected nothing. It
 * drafted, it delivered, and it learned nothing, and from the outside it
 * looked completely healthy. These tests are the guard on that.
 */

const params = { runId: "branded_shorts_learning_1", clientSlug: "acme", productId: "tiktok-editing-agent", runKind: "setup" as const };
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:test" };

describe("branded-shorts (TikTok editing) and the learning loop (C7)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("with nothing projected, the run completes as before and hands back a record listing all seven absent", async () => {
    env = await setupTestEnvironment();
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createBrandedShortsAgentWorkflow({
        tools: env.tools,
        promptStore: makePromptStore(),
        router: smartFakeRouter([goodHighlights(), goodGraphicsPlan()]),
        autoApprove: true,
      }),
      params,
    );
    expect(result.status).toBe("completed");

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", params.runId]);
    expect(record, "the editing agent must write a run record like every other agent").toBeDefined();
    expect(record!.platform).toBe("tiktok");
    expect(record!.readiness).toEqual({
      present: [],
      absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"],
    });
  });

  it("writes under the same platform key as clipping and content design, and never claims a strategy row", async () => {
    // One TikTok account, one subject history. If editing wrote under its own
    // key the anti-repetition window would not see across the three products,
    // and two of them could ship the same takeaway in the same week.
    //
    // `strategyRowId: null` is the honest answer rather than an omission: this
    // agent picks no subject, so it can never be spending a planned row, and a
    // made-up id would make the map look spent.
    env = await setupTestEnvironment();
    await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createBrandedShortsAgentWorkflow({
        tools: env.tools,
        promptStore: makePromptStore(),
        router: smartFakeRouter([goodHighlights(), goodGraphicsPlan()]),
        autoApprove: true,
      }),
      { ...params, runId: "branded_shorts_learning_2" },
    );

    const record = await env.store.readJson<Record<string, unknown>>("acme", ["state", "runs", "branded_shorts_learning_2"]);
    expect(record!.platform).toBe("tiktok");
    expect(record!.subjectRow).toMatchObject({
      subject: "Founders should ship faster.",
      type: "edited-short",
      status: "drafted",
      assetKind: "branded-shorts-video",
      strategyRowId: null,
    });
    // D11 on the thing the client opens, in the structured shape every
    // rendered-asset agent uses — there is no drafts markdown here either.
    const deliverable = record!.deliverable as Record<string, unknown>;
    expect(deliverable).toMatchObject({ kind: "branded-shorts-video", type: "edited-short" });
    expect(deliverable.whyNow).toBe("the client handed over this video and asked for a short from it");
  });

  it("HOLDS when the takeaway touches a never-topic, rather than editing the video to say something else", async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["context", "learning", "preferences"], {
      kind: "preferences",
      data: { neverTopics: ["ship faster"] },
      source: SOURCE,
    });

    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "branded_shorts_learning_3" },
    );

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/never-topic/);
    expect(result.reason).toMatch(/ship faster/);
    expect(result.reason).toMatch(/nothing was edited in its place/);
  });
});
