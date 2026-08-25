import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
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

/** The brand.json shape agent-middleware's seed script writes for a real client. */
const GEEKTIME_BRAND = {
  name: "Geektime",
  accent: "#A5E82B",
  colors: { primaryAccent: "#A5E82B", neutralDark: "#272A35", neutralLight: "#F4F2EC" },
  dominantColors: [{ hex: "#272A35", dominanceRank: 1 }],
  fonts: { heading: "Space Grotesk" },
  visualStyle: "Dark Mode",
  handle: "geektimecoil",
};

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodResearchOutput()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodVisualQaOutput()),
  ]);
}

describe("brand kit: the client's brand reaches the rendered templates", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof happyRouter>) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
      // Deliberately NO templateStore: this is the no-store path, which used
      // to point the renderer straight at the client's (read-only in prod)
      // templateDir with no way to inject anything.
    });
  }

  it("brands the no-store path: templates are copied into the run dir with the client's tokens spliced in", async () => {
    await env.store.writeJson("acme", ["client", "brand"], GEEKTIME_BRAND);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(happyRouter()), { runId: "branded_run", ...base });
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps("branded_run");
    const resolved = steps.find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; files: string[]; brandTokenDrift?: { present: string[]; missing: string[] } }
      | undefined;
    // The renderer was pointed at the branded run dir, not the client's own.
    expect(resolved?.templateDir).toBe(".template-cache/branded_run");
    // `files` keeps its "archetype files present" meaning.
    expect(resolved?.files).toContain("stat-callout.html");

    const base_ = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "branded_run", "slide.html"), "utf8");
    expect(base_).toContain("--bg: #272A35;");
    expect(base_).toContain("--fg: #F4F2EC;");
    expect(base_).toContain("family=Space+Grotesk");

    // The drift note names every token as present — the trace can answer
    // "did the client's colors reach the pixels" without re-derivation.
    expect(resolved?.brandTokenDrift?.missing).toEqual([]);
    expect(resolved?.brandTokenDrift?.present.join(",")).toContain("--bg=#272A35");
  }, 30000);

  it("a client with no brand.json renders exactly as before brand kits existed", async () => {
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(happyRouter()), { runId: "brandless_run", ...base });
    expect(result.status).toBe("completed");

    const resolved = (await durableStore.listSteps("brandless_run")).find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; brandTokenDrift?: unknown }
      | undefined;
    // Untouched original path: the client's own templateDir, no run-dir copy.
    expect(resolved?.templateDir).toBe("fixtures/templates");
    expect(resolved?.brandTokenDrift).toBeUndefined();
  }, 30000);

  it("re-writes the branded run dir before a revision render after the instance's disk was wiped", async () => {
    // The 9qkTWlg7e9ZLiVIZUok4 bug class on the NEW path: 04c is
    // checkpointed, the branded dir is per-instance disk, and a resume on a
    // recycled instance must re-create it or the render is a tooling
    // failure.
    await env.store.writeJson("acme", ["client", "brand"], GEEKTIME_BRAND);

    const first = goodCopyOutput();
    const draftTurns = () => [finalTurn(first), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(), ...draftTurns()]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "branded_recycle";

    const r0 = await engine.run(workflowFn, { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    // Simulates the resume landing on a fresh Cloud Run instance.
    await fsp.rm(pathMod.join(env.repoRoot, ".template-cache", runId), { recursive: true, force: true });

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Tighten the hooks.",
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn, { runId, ...base });
    expect(r1.status).toBe("awaiting_gate");

    const rewritten = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(rewritten).toContain("--bg: #272A35;");
  }, 60000);
});
