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
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodResearchOutput()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodVisualQaOutput()),
  ]);
}

describe("in-place review edits (Phase 2)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(renderTool?: AgentToolRegistry[string]) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": renderTool ?? fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router: happyRouter(),
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
  }

  async function deliverableFor(runId: string) {
    const rows = await env.store.listJson<{ deliverable: { caption: string; slides: Array<{ n: number; fields: Record<string, string> }> } }>(
      "acme",
      ["ledger", "deliverables", runId, "_"],
    );
    return rows[0]!.data.deliverable;
  }

  it("applies text and typography edits verbatim on approve, re-renders, and records the deltas as feedback", async () => {
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "edits_happy";
    const workflowFn = workflowFor();

    const r0 = await engine.run(workflowFn, { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      edits: {
        caption: "A tighter caption the reviewer preferred, written by hand.",
        slides: [{ n: 2, fields: { headline: "Reviewer's own headline" }, fontScale: "s", textAlign: "center" }],
      },
    });
    const done = await engine.run(workflowFn, { runId, ...base });
    expect(done.status).toBe("completed");

    // The delivered post carries the edits — pixels AND text, because 09d
    // re-rendered from the patched slides-data.
    const deliverable = await deliverableFor(runId);
    expect(deliverable.caption).toBe("A tighter caption the reviewer preferred, written by hand.");
    const slide2 = deliverable.slides.find((s) => s.n === 2)!;
    expect(slide2.fields["headline"]).toBe("Reviewer's own headline");
    expect(slide2.fields["fontScale"]).toBe("s");
    expect(slide2.fields["textAlign"]).toBe("center");

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).toContain("09c-apply-review-edits");
    expect(stepIds).toContain("09d-render-edited-carousel");

    // The dedup window recorded what ACTUALLY shipped.
    const window = await env.store.readJson<Array<{ excerpt: string }>>("acme", ["ledger", "output-history", "instagram-agent"]);
    expect(window?.[0]?.excerpt).toContain("Reviewer's own headline");

    // And the deltas became durable feedback for future drafts.
    const feedback = await env.store.listJson<{ note: string }>("acme", ["memory", "feedback"]);
    const editNote = feedback.map((f) => f.data.note).find((n) => n.includes("Reviewer edited before approving"));
    expect(editNote).toContain(`headline: "Finding #2" -> "Reviewer's own headline"`);
    expect(editNote).toContain("font size -> s");
  }, 60000);

  it("drops layout-metadata and unknown keys instead of applying or failing", async () => {
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "edits_dropped";
    const workflowFn = workflowFor();

    await engine.run(workflowFn, { runId, ...base });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      edits: { slides: [{ n: 1, fields: { accentColor: "#000000", notARealField: "x", headline: "Kept edit" } }] },
    });
    expect((await engine.run(workflowFn, { runId, ...base })).status).toBe("completed");

    const deliverable = await deliverableFor(runId);
    const slide1 = deliverable.slides.find((s) => s.n === 1)!;
    expect(slide1.fields["accentColor"]).not.toBe("#000000");
    expect(slide1.fields["notARealField"]).toBeUndefined();
    expect(slide1.fields["headline"]).toBe("Kept edit");

    const applied = (await durableStore.listSteps(runId)).find((s) => s.stepId === "09c-apply-review-edits")?.output as
      | { summary: string[] }
      | undefined;
    expect(applied?.summary.some((line) => line.includes("accentColor: ignored"))).toBe(true);
  }, 60000);

  it("falls back to the original render (pixels and text consistent) when the edited re-render fails, keeping only the caption edit", async () => {
    // The real render succeeds once (pre-gate); the 09d re-render fails.
    const realFake = fakeRenderCarousel(env.tools["publish.renderCarousel"]!);
    let calls = 0;
    const flakyRender = {
      ...realFake,
      async execute(args: unknown, opts: unknown) {
        calls += 1;
        if (calls > 1) return { status: "tooling_error", reason: "chromium crashed on the edited render" };
        return (realFake as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, opts);
      },
    } as AgentToolRegistry[string];

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "edits_fallback";
    const workflowFn = workflowFor(flakyRender);

    await engine.run(workflowFn, { runId, ...base });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      edits: { caption: "Edited caption survives", slides: [{ n: 1, fields: { headline: "Should NOT ship" } }] },
    });
    expect((await engine.run(workflowFn, { runId, ...base })).status).toBe("completed");

    const deliverable = await deliverableFor(runId);
    // Caption is post text, not pixels — it applies. Slide text stays the
    // ORIGINAL so text never disagrees with the delivered PNGs.
    expect(deliverable.caption).toBe("Edited caption survives");
    expect(deliverable.slides.find((s) => s.n === 1)!.fields["headline"]).toBe("Finding #1");

    const feedback = await env.store.listJson<{ note: string }>("acme", ["memory", "feedback"]);
    const editNote = feedback.map((f) => f.data.note).find((n) => n.includes("Reviewer edited before approving"));
    expect(editNote).toContain("could not be applied");
  }, 60000);

  it("a plain approve with no edits leaves the trace byte-identical — no 09c/09d steps exist", async () => {
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "edits_none";
    const workflowFn = workflowFor();

    await engine.run(workflowFn, { runId, ...base });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    expect((await engine.run(workflowFn, { runId, ...base })).status).toBe("completed");

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("09c-apply-review-edits");
    expect(stepIds).not.toContain("09d-render-edited-carousel");
  }, 60000);
});
