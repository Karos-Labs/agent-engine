import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodResearchOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * Step 05b — the real image-search backend.
 *
 * The defect these cover: `imageCandidatePool` was a workflow option that
 * `apps/agent-server` never passed, so it was always `[]`, so step 06 held
 * every production Instagram run on "no viable image." That reads as an
 * editorial verdict, which is why it went unnoticed as a wiring gap.
 */

const params = {
  runId: "instagram_run_sourcing",
  clientSlug: "acme",
  productId: "instagram-agent",
  runKind: "recurring" as const,
};

/** A stand-in for the registered `media.findImages`, returning whatever outcome a test needs. */
function stubFindImages(outcome: unknown, onCall?: (args: Record<string, unknown>) => void): AgentTool {
  return {
    name: "media.findImages",
    version: "1.0.0",
    async execute(args: unknown) {
      onCall?.(args as Record<string, unknown>);
      return outcome;
    },
  } as unknown as AgentTool;
}

function selectionsFor(copy: ReturnType<typeof goodCopyOutput>, imagePath: string) {
  return {
    selections: copy.slides.map((s) => ({
      n: s.n,
      imagePath,
      reason: "candidate matches closely enough",
      license: "Unsplash License — free for commercial use, no attribution required",
      rightsUsable: true,
      watermarkFree: true,
    })),
  };
}

describe("05b-source-images", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("searches on each slide's own visualNeed and feeds the results to step 06", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    let seen: Record<string, unknown> | undefined;

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages(
        { status: "success", result: { provider: "fake", candidates: pool, unmet: [] } },
        (args) => {
          seen = args;
        },
      ),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(selectionsFor(copy, pool[0]!.path)),
    ]);

    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      params,
    );

    // The queries have to come from the copy this attempt actually produced,
    // not from the topic — that is the whole reason the step sits inside the
    // retry loop rather than before it.
    const needs = seen?.["needs"] as { n: number; query: string }[];
    expect(needs.map((n) => n.n)).toEqual(copy.slides.map((s) => s.n));
    expect(needs.map((n) => n.query)).toEqual(copy.slides.map((s) => s.visualNeed));
    expect(seen?.["repoRoot"]).toBe(env.repoRoot);
    // Run-scoped, so two concurrent runs cannot overwrite each other's files.
    expect(seen?.["runId"]).toBe(params.runId);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05b-source-images-attempt-1");
  });

  it("does not search when the caller supplied a pool, so evals and client-owned assets still win", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    let called = false;

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "success", result: { provider: "fake", candidates: [], unmet: [] } }, () => {
        called = true;
      }),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(selectionsFor(copy, pool[0]!.path)),
    ]);

    await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({
        tools,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: pool,
        autoApprove: true,
      }),
      { ...params, runId: "instagram_run_sourcing_explicit" },
    );

    expect(called).toBe(false);
  });

  it("holds the post — not crashes — when no image backend is configured", async () => {
    // `not_available` is what an unconfigured deployment gets. The run should
    // reach the same honest hold as before step 05b existed.
    const copy = goodCopyOutput();
    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "not_available", reason: "no image-search backend configured" }),
    };

    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: null,
        reason: "no candidates were sourced for this run",
        license: "n/a — no candidate qualified",
        rightsUsable: false,
        watermarkFree: false,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_unconfigured" },
    );

    expect(result.status).toBe("held");
  });

  it("names the real sourcing cause in the hold reason, not just 'no candidate qualified'", async () => {
    // prep run pubsub-21528976110173438 held all six slides reporting only
    // "no candidate qualified" six times, which reads as an editorial verdict
    // on the images. The actual cause was an unset key, and it was recorded
    // one step upstream where nobody debugging the hold would look.
    const copy = goodCopyOutput();
    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({
        status: "not_available",
        reason: "media.findImages: no image-search backend configured — set UNSPLASH_ACCESS_KEY",
      }),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_reason" },
    );

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("expected a held run");
    expect(result.reason).toContain("UNSPLASH_ACCESS_KEY");
    expect(result.reason).toContain("nothing could be vetted");
  });

  it("carries a content_fail chain report into the hold reason", async () => {
    const copy = goodCopyOutput();
    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({
        status: "content_fail",
        reason: "media.findImages: no candidate images could be sourced. Chain tried: openverse, wikimedia. slide 1 (openverse: no results; wikimedia: no results)",
      }),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_chain_reason" },
    );

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("expected a held run");
    expect(result.reason).toContain("openverse: no results");
  });

  it("does not spend a model call vetting an empty pool", async () => {
    // The run above paid $0.02 and 16s for Sonnet to write six paragraphs
    // each concluding that an empty list is empty. There is only one possible
    // verdict on nothing.
    const copy = goodCopyOutput();
    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "content_fail", reason: "nothing found" }),
    };
    // Only two turns are supplied. A third call — the vetting agent — would
    // exhaust the sequence and throw, so this passing proves it never ran.
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_no_vet_call" },
    );

    expect(result.status).toBe("held");
  });

  // ── generative rescue (steps 06b/06c) ──
  //
  // prep run pubsub-21535110633863323: four providers, 36 candidates, and
  // slides 2 and 5 still unfillable because they needed pictures no library
  // holds ("a timeline or roadmap with a clearly labeled 'research' first
  // phase, shot from above"). Retrieval cannot fix that; generation can.

  /** Vetting output where every slide but `gaps` is filled from the pool. */
  function selectionsWithGaps(copy: ReturnType<typeof goodCopyOutput>, filledPath: string, gaps: number[]) {
    return {
      selections: copy.slides.map((s) =>
        gaps.includes(s.n)
          ? {
              n: s.n,
              imagePath: null,
              reason: "no candidate matched this visual need",
              license: "n/a — no candidate qualified",
              rightsUsable: false,
              watermarkFree: false,
            }
          : {
              n: s.n,
              imagePath: filledPath,
              reason: "matches",
              license: "Unsplash License",
              rightsUsable: true,
              watermarkFree: true,
            },
      ),
    };
  }

  function stubGenerateImage(outcome: unknown, onCall?: (args: Record<string, unknown>) => void): AgentTool {
    return {
      name: "image.generate",
      version: "1.0.0",
      async execute(args: unknown) {
        onCall?.(args as Record<string, unknown>);
        return outcome;
      },
      inputSchema: { parse: (v: unknown) => v } as never,
    } as unknown as AgentTool;
  }

  it("generates only the unfilled slides, and completes a post that would otherwise have held", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    const filled = pool[0]!.path;
    let generatedFor: unknown;

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "success", result: { provider: "unsplash", providersUsed: ["unsplash"], candidates: pool, unmet: [] } }),
      "image.generate": stubGenerateImage(
        { status: "success", result: { model: "imagen-4.0-generate-001", unmet: [], candidates: [{ path: pool[0]!.path, description: "AI-generated for slide 2", provider: "imagen", licenseConfidence: "generated" }] } },
        (args) => {
          generatedFor = args["needs"];
        },
      ),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      // First vetting pass: slide 2 has no match.
      finalTurn(selectionsWithGaps(copy, filled, [2])),
      // Rescue vetting pass: the generated image clears the gate.
      finalTurn({
        selections: [
          { n: 2, imagePath: filled, reason: "the generated illustration matches the brief", license: "Generated image", rightsUsable: true, watermarkFree: true },
        ],
      }),
    ]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_rescue_ok" },
    );

    // Only the gap was generated — not the whole carousel.
    expect(generatedFor).toEqual([{ n: 2, prompt: copy.slides.find((s) => s.n === 2)!.visualNeed }]);
    expect(result.status).not.toBe("held");
  });

  it("still holds when generation cannot fill the gap either, and says so", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "success", result: { provider: "unsplash", providersUsed: ["unsplash"], candidates: pool, unmet: [] } }),
      "image.generate": stubGenerateImage({ status: "content_fail", reason: "filtered by the model's safety policy" }),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(selectionsWithGaps(copy, pool[0]!.path, [5])),
    ]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_rescue_exhausted" },
    );

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("expected a held run");
    // The never-a-placeholder rule is untouched; the reason now records that
    // generation was tried too.
    // The message now names both rescue tiers, because both were tried.
    expect(result.reason).toContain("neither the social-scrape tier nor generation could fill the gap");
    expect(result.reason).toContain("5");
  });

  it("does not let a rescue image that fails its own gate overwrite the original verdict", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "success", result: { provider: "unsplash", providersUsed: ["unsplash"], candidates: pool, unmet: [] } }),
      "image.generate": stubGenerateImage({ status: "success", result: { model: "m", unmet: [], candidates: [{ path: pool[0]!.path, description: "gen", provider: "imagen", licenseConfidence: "generated" }] } }),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(selectionsWithGaps(copy, pool[0]!.path, [3])),
      // The rescue produced something, but the gate refused it too.
      finalTurn({
        selections: [
          { n: 3, imagePath: null, reason: "the generated image still does not match", license: "n/a", rightsUsable: false, watermarkFree: false },
        ],
      }),
    ]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_rescue_rejected" },
    );

    expect(result.status).toBe("held");
  });

  it("skips the rescue entirely when generation is not registered, holding exactly as before", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "success", result: { provider: "unsplash", providersUsed: ["unsplash"], candidates: pool, unmet: [] } }),
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(selectionsWithGaps(copy, pool[0]!.path, [4])),
    ]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_rescue_absent" },
    );

    expect(result.status).toBe("held");
  });

  it("holds the post when the tool is not registered at all", async () => {
    // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
    // reports `not_available` without a real scraper rather than returning a
    // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
    // placeholder is what let every content agent draft from nothing for months.
    // Tests still need deterministic offline data, so they opt in here; nothing in
    // `apps/` does.
    // createAllKarosTools(undefined, undefined, { scraper: createOfflineScraper() }) deliberately excludes media.*, so a registry
    // without it is a supported configuration, not a misconfiguration.
    const copy = goodCopyOutput();
    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: null,
        reason: "no candidates available",
        license: "n/a — no candidate qualified",
        rightsUsable: false,
        watermarkFree: false,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({
        tools: env.tools,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...params, runId: "instagram_run_sourcing_absent" },
    );

    expect(result.status).toBe("held");
  });

  it("fails loudly on a provider outage instead of reporting it as 'no viable image'", async () => {
    // The distinction is the point. A hold tells a human the topic had no good
    // picture and invites an editorial decision; an outage needs an operator.
    const copy = goodCopyOutput();
    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages({ status: "tooling_error", reason: "unsplash search returned 503" }),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy)]);

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_outage" },
    );

    expect(result.status).not.toBe("held");
    expect(JSON.stringify(result)).toContain("503");
  });

  it("re-searches on a retry, because the rewritten copy has different visual needs", async () => {
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    const queries: string[][] = [];

    const tools = {
      ...env.tools,
      "media.findImages": stubFindImages(
        { status: "success", result: { provider: "fake", candidates: pool, unmet: [] } },
        (args) => {
          queries.push((args["needs"] as { query: string }[]).map((n) => n.query));
        },
      ),
    };

    // Attempt 1's vetting output is malformed, which sends the loop back to
    // step 05 for a fresh draft; attempt 2 succeeds.
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn({ selections: [] }),
      finalTurn(copy),
      finalTurn(selectionsFor(copy, pool[0]!.path)),
    ]);

    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, runId: "instagram_run_sourcing_retry" },
    );

    const stepIds = (await durableStore.listSteps("instagram_run_sourcing_retry")).map((s) => s.stepId);
    expect(stepIds).toContain("05b-source-images-attempt-1");
    expect(queries.length).toBeGreaterThanOrEqual(1);
  });
});
