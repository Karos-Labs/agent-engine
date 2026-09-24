import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { EXEMPLAR_LIBRARY_BELIEF_KEY, type ExemplarLibrary } from "../src/workflow/exemplar-library.js";
import { fakeRenderCarousel, fakeRouterSequence, goodImageCandidatePool, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * RFC-26 Phase 3 through the real workflow: setup harvests, judges and stores
 * the exemplar library automatically (no approval gate), the next run reuses
 * it, and a harvest that fails never costs the post.
 */

const DNA = { coverType: "typographic", picturePlacement: "inset", elementGroupsPerSlide: 3, textDensity: "low", emphasis: "highlight-block", device: "figure", groundStyle: "flat-light", palette: [], hookPattern: "number" };

function fakeTool(name: string, calls: Array<{ name: string; input: unknown }>, result: (input: unknown) => unknown) {
  return {
    name,
    description: name,
    version: "test",
    inputSchema: undefined as never,
    async execute(input: unknown) {
      calls.push({ name, input });
      return result(input);
    },
  };
}

function tools(env: TestEnvironment, calls: Array<{ name: string; input: unknown }>, harvestStatus: "success" | "tooling_error" = "success"): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    "research.harvestInstagramExemplars": fakeTool("research.harvestInstagramExemplars", calls, () =>
      harvestStatus === "success"
        ? {
            status: "success",
            result: {
              accounts: [{ handle: "reputeforge", role: "reference", posts: 100, medianCarouselFrames: 7 }],
              exemplars: [
                { url: "https://instagram.com/p/a", handle: "reputeforge", role: "reference", format: "carousel", frames: ["https://cdn/a1.jpg"], frameCount: 7, hook: "Marketing is not advertising", likes: 900, comments: 30, percentile: 1, liftOverBaseline: 4.1, outlier: true },
              ],
              problems: [],
              estimatedCostUsd: 0.09,
              postCount: 100,
            },
          }
        : { status: "tooling_error", reason: "scraper down" },
    ) as never,
    "media.judgeExemplars": fakeTool("media.judgeExemplars", calls, () => ({
      status: "success",
      result: {
        judged: [{ ref: "https://instagram.com/p/a", craft: 5, dna: DNA, standout: "one highlighted word per headline", storedFrames: ["gs://m/a1.jpg"], exemplar: true }],
        calibration: { anchors: 3, shift: 1, note: "moved up 1" },
        failures: [],
      },
    })) as never,
  };
}

async function run(env: TestEnvironment, runId: string, registry: AgentToolRegistry) {
  const durable = new MemoryDurableStepStore();
  const result = await new WorkflowEngine(durable).run(
    createInstagramAgentWorkflow({ tools: registry, promptStore: makePromptStore(), router: fakeRouterSequence(happyTurns()), repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true }),
    { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
  );
  return { result, stepIds: (await durable.listSteps(runId)).map((s) => s.stepId) };
}

async function storedLibrary(env: TestEnvironment): Promise<ExemplarLibrary | undefined> {
  const read = await env.tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx: { runId: "t", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as never });
  return read.status === "success" ? ((read.result as { beliefs?: Record<string, unknown> }).beliefs?.[EXEMPLAR_LIBRARY_BELIEF_KEY] as ExemplarLibrary | undefined) : undefined;
}

describe("the exemplar library in setup", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    // A reference account and a competitor site to harvest.
    const brief = await env.store.readJson<Record<string, unknown>>("acme", ["brief", "instagram-brief"]);
    if (brief !== undefined) await env.store.writeJson("acme", ["brief", "instagram-brief"], { ...brief, referenceAccounts: [{ platform: "instagram", handle: "reputeforge", why: "craft" }] });
    await env.store.writeJson("acme", ["client", "competitors"], [{ name: "Rival", website: "https://rival.example" }]);
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("harvests, judges and stores the library on its own, then the next run reuses it", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const first = await run(env, "exemplars_build", tools(env, calls));
    expect(first.result.status).toBe("completed");
    expect(first.stepIds).toEqual(expect.arrayContaining(["00h-check-exemplar-library", "00h1-harvest-exemplars", "00h2-judge-exemplars", "00h3-persist-exemplar-library"]));
    const harvestInput = calls.find((c) => c.name === "research.harvestInstagramExemplars")!.input as { competitorSites: Array<{ website: string }>; accounts: Array<{ handle: string }> };
    expect(harvestInput.competitorSites.map((s) => s.website)).toContain("https://rival.example");
    const judgeInput = calls.find((c) => c.name === "media.judgeExemplars")!.input as { posts: Array<{ outlier?: boolean }> };
    expect(judgeInput.posts[0]!.outlier).toBe(true);

    const library = await storedLibrary(env);
    expect(library?.status).toBe("built");
    expect(library?.entries[0]?.standout).toBe("one highlighted word per headline");

    const secondCalls: Array<{ name: string; input: unknown }> = [];
    const second = await run(env, "exemplars_reuse", tools(env, secondCalls));
    // (The second run writes the same fixture post, which the output dedupe
    // rightly holds; what this case is about is the setup steps it ran.)
    expect(second.stepIds).toContain("00h-check-exemplar-library");
    expect(second.stepIds).not.toContain("00h1-harvest-exemplars");
    expect(secondCalls.some((c) => c.name === "research.harvestInstagramExemplars")).toBe(false);
  });

  it("a failed harvest never costs the post, and is remembered so the next run does not re-pay", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const { result, stepIds } = await run(env, "exemplars_fail", tools(env, calls, "tooling_error"));
    expect(result.status).toBe("completed");
    expect(stepIds).not.toContain("00h2-judge-exemplars");
    expect((await storedLibrary(env))?.status).toBe("failed");
  });
});
