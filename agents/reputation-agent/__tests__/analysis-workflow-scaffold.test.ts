import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationAnalysisWorkflow } from "../src/workflow/create-reputation-analysis-workflow.js";
import { makeReview, manualExportLeg, setupTestEnvironment, writeClientConfig, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "analysis_run_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

/**
 * RFC-08 §4: the "slow analysis brain" scaffold — a separate, slower-cadence
 * workflow from the pulse runner. Only Layer 0 (capture) does real work
 * today; Layers 1-5 are honest, structural placeholders (see that file's own
 * header comment for exactly why porting them further is out of scope for
 * this scaffold). This suite runs all 6 phases and asserts each one's shape.
 */
describe("createReputationAnalysisWorkflow: the 6-phase scaffold runs end to end (RFC-08 §4)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("captures real reviews at Layer 0 and returns an honest not-yet-ported/not-yet-implemented marker for every later layer", async () => {
    await writeClientConfig(env.store, env.clientSlug, {
      reputationRoster: [
        manualExportLeg([
          makeReview({ review_id: "manual:loc-1:rev-a", rating: 4, text: "Solid, would come back." }),
          makeReview({ review_id: "manual:loc-1:rev-b", rating: 2, text: "Not great this time." }),
        ]),
      ],
    });

    const workflowFn = createReputationAnalysisWorkflow({ tools: env.tools });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.output.layer0Capture).toEqual({ legCount: 1, reviewCount: 2 });
    expect(result.output.layer1ResponseBehavior.status).toBe("not_yet_ported");
    expect(result.output.layer2ReputationState.status).toBe("not_yet_ported");
    expect(result.output.layer3ThemeMining.status).toBe("not_yet_implemented");
    expect(result.output.layer4Benchmark.status).toBe("not_yet_implemented");
    expect(result.output.layer4Benchmark.competitorTrackingRead).toBe(false);
    expect(result.output.layer5Synthesis.status).toBe("not_yet_implemented");

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual(
      [
        "layer0-capture",
        "layer1-response-behavior-mining",
        "layer2-reputation-state",
        "layer3-theme-mining",
        "layer4-competitor-benchmark",
        "layer5-synthesis",
      ].sort(),
    );
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resolves to blocked_intake when the client's roster has no capture legs configured, same as the pulse workflow", async () => {
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [] });

    const workflowFn = createReputationAnalysisWorkflow({ tools: env.tools });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "analysis_run_blocked" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/no reputation capture legs are configured/i);
  });
});
