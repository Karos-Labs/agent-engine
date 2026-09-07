import { describe, expect, it } from "vitest";
import { recordToolUsage, type ToolUnitUsage } from "@agent-engine/core";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";

/**
 * A step is billed for every per-unit tool call made while it ran, whatever
 * its body returns (2026-09-08).
 *
 * The run this was written against: a TikTok original short whose five
 * `04p-plate-N` steps each generated an 8-second Veo plate ($0.40/s) and
 * returned a FILE PATH, whose `05-voiceover` returned `{path, words}` and
 * whose `10b-visual-qa` returned a verdict. Every one of them recorded
 * `costUsd: 0`, and the run reported $0.13 for ~$13 of media.
 */

const VEO_8S: ToolUnitUsage = { model: "veo-3.1-generate-001", unit: "second", quantity: 8 };

/** Stands in for a `defineTool`-built tool: it does its work and records what it consumed against the active scope. */
async function fakeGeneratePlate(): Promise<{ status: "success"; result: { path: string }; usage: ToolUnitUsage[] }> {
  const usage = [{ ...VEO_8S }];
  recordToolUsage(usage);
  return { status: "success", result: { path: "plates/plate-1.mp4" }, usage };
}

const params = { runId: "run_usage", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

describe("tool usage attribution to the running step", () => {
  it("bills a step.code whose body calls a unit-priced tool and returns something else entirely", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const result = await engine.run(async (wf: WorkflowContext) => {
      const plate = await wf.step.code("04p-plate-1", async () => {
        const outcome = await fakeGeneratePlate();
        return outcome.result.path; // the shape every media step actually has
      });
      return { plate };
    }, params);

    expect(result.status).toBe("completed");
    const step = await store.getStep(params.runId, "04p-plate-1");
    expect(step?.costUsd).toBeCloseTo(3.2, 6); // 8 s x $0.40
    expect(step?.unitUsage).toEqual([VEO_8S]);
    expect(result.status === "completed" && result.totalCostUsd).toBeCloseTo(3.2, 6);
  });

  it("does not double-bill a body that returns the tool's own outcome (both roads carry the same entry)", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    await engine.run(async (wf: WorkflowContext) => {
      await wf.step.code("06d-generate-images", () => fakeGeneratePlate());
      return {};
    }, params);

    const step = await store.getStep(params.runId, "06d-generate-images");
    expect(step?.costUsd).toBeCloseTo(3.2, 6);
    expect(step?.unitUsage).toHaveLength(1);
  });

  it("keeps the usage of a step that throws AFTER the tool was paid for", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const result = await engine.run(async (wf: WorkflowContext) => {
      await wf.step.code("04p-plate-2", async () => {
        await fakeGeneratePlate();
        throw new Error("the second plate was declined");
      });
      return {};
    }, params);

    // An unclassified throw is a `degraded` run in this engine; the STEP is what failed.
    expect(result.status).toBe("degraded");
    const step = await store.getStep(params.runId, "04p-plate-2");
    expect(step?.status).toBe("failed");
    expect(step?.costUsd).toBeCloseTo(3.2, 6);
    expect(step?.unitUsage).toEqual([VEO_8S]);
  });

  it("keeps nested steps' usage with the step that made the call, never the enclosing one as well", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    await engine.run(async (wf: WorkflowContext) => {
      await wf.step.code("outer", async () => {
        await wf.step.code("inner", () => fakeGeneratePlate());
        return "done";
      });
      return {};
    }, params);

    expect((await store.getStep(params.runId, "inner"))?.costUsd).toBeCloseTo(3.2, 6);
    expect((await store.getStep(params.runId, "outer"))?.costUsd).toBe(0);
  });

  it("records nothing when no scope is active — a tool called from a script has nobody to bill", () => {
    expect(() => recordToolUsage([VEO_8S])).not.toThrow();
  });
});
