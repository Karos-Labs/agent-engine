import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodBrandTokens, goodStyleConfig, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "instagram_run_blocked", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("02-freeze-style-config: parse-check-or-HALT (RFC-03 §3 step 02)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("blocks intake when the client has no config set up at all", async () => {
    env = await setupTestEnvironment({ withConfig: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/client config has not been set up/i);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId)).toEqual(["01-open-run", "02-freeze-style-config"]);
  });

  it("blocks intake when instagramStyleConfig fails to parse (missing required field) -- never guesses a default", async () => {
    env = await setupTestEnvironment({ withConfig: false });
    await env.store.writeJson("acme", ["client", "config"], {
      // `canvas` is entirely missing -- StyleConfigSchema must reject this outright.
      instagramStyleConfig: { style_config_version: 1, compliance: { regulated: false } },
      instagramBrandTokens: goodBrandTokens(),
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/instagramStyleConfig failed to parse/i);
    expect(router.complete).not.toHaveBeenCalled();
  });

  it("blocks intake when the frozen canvas.scale is not exactly 2, even though it parses as a valid number", async () => {
    env = await setupTestEnvironment({ withConfig: false });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig({ canvas: { w: 1080, h: 1440, scale: 1, slides_min: 6, slides_max: 8 } }),
      instagramBrandTokens: goodBrandTokens(),
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_blocked_3" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/canvas\.scale must be exactly 2/i);
  });

  it("blocks intake when instagramBrandTokens fails to parse (missing templateDir)", async () => {
    env = await setupTestEnvironment({ withConfig: false });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig(),
      instagramBrandTokens: { accentColor: "#123456" },
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_blocked_4" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/instagramBrandTokens failed to parse/i);
  });
});
