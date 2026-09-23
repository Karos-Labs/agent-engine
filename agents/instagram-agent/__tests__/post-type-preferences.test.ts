import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { copyTurnInputs, fakeRenderCarousel, fakeRouterSequence, goodImageCandidatePool, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";
import { happyTurns } from "./turns.js";

// 2026-09-23, the owner: a client's post-type preferences (Geektime posts news
// flashes, Deel's feed is photo-led) live with what the feedback loop knows
// about the client, the portal can ask for a type for the next run, and every
// capability stays open to every client.

const SOURCE = { projectedAt: "2026-09-23T20:00:00.000Z", projectedBy: "middleware-feedback", contentHash: "sha256:test" };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

async function run(env: TestEnvironment, runId: string, input?: Record<string, unknown>) {
  const router = fakeRouterSequence(happyTurns());
  const durable = new MemoryDurableStepStore();
  const result = await new WorkflowEngine(durable).run(
    createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true }),
    { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", ...(input !== undefined ? { input } : {}) },
  );
  const claim = (await durable.listSteps(runId)).find((s) => s.stepId === "01-open-run")?.output as Record<string, unknown> | undefined;
  return { result, claim, copyInput: copyTurnInputs(router)[0]! };
}

describe("post-type preferences", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a client with no preference runs exactly as before (the premise)", async () => {
    const { result, claim, copyInput } = await run(env, "prefs_none");
    expect(result.status).toBe("completed");
    expect(claim?.["pictureDensity"]).toBeUndefined();
    expect(claim?.["postTypeSource"]).toBeUndefined();
    expect(copyInput["pictureDensity"]).toBeUndefined();
  });

  it("reads the client's learned preference from the projected preferences doc", async () => {
    await env.store.writeJson("acme", ["context", "learning", "preferences"], {
      kind: "preferences",
      data: { formats: { instagram: { pictureDensity: "photo-first", series: "the_list" } } },
      source: SOURCE,
    });
    const { result, claim, copyInput } = await run(env, "prefs_learned");
    expect(result.status).toBe("completed");
    expect(claim).toMatchObject({ pictureDensity: "photo-first", requestedSeries: "the_list", postTypeSource: "client-preference" });
    expect(copyInput["pictureDensity"]).toBe("photo-first");
  });

  it("a run input overrides the learned preference", async () => {
    await env.store.writeJson("acme", ["context", "learning", "preferences"], {
      kind: "preferences",
      data: { formats: { instagram: { pictureDensity: "photo-first" } } },
      source: SOURCE,
    });
    const { claim, copyInput } = await run(env, "prefs_override", { pictureDensity: "standard" });
    expect(claim).toMatchObject({ pictureDensity: "standard", postTypeSource: "run-input" });
    expect(copyInput["pictureDensity"]).toBeUndefined();
  });

  it("ignores a value it does not know, rather than guessing", async () => {
    await env.store.writeJson("acme", ["context", "learning", "preferences"], {
      kind: "preferences",
      data: { formats: { instagram: { pictureDensity: "all-photos-please", format: "reel" } } },
      source: SOURCE,
    });
    const { result, claim } = await run(env, "prefs_unknown");
    expect(result.status).toBe("completed");
    expect(claim?.["pictureDensity"]).toBeUndefined();
    expect(claim?.["requestedFormat"]).toBeUndefined();
  });

  it("tells the writer a hot-news single is a news flash, for ANY client, with no news config", async () => {
    // The owner: every capability is for every client. Geektime's
    // `instagramPostModes` was how the news flash started, not who it is for.
    const { goodBrandTokens, goodStyleConfig } = await import("./test-helpers.js");
    await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens(), requestedMode: "hot-news", instagramFormat: "single" });
    const { claim, copyInput } = await run(env, "prefs_hot_news_single");
    expect(claim?.["newsFlash"]).toBeUndefined();
    expect(copyInput["format"]).toBe("single");
    expect(copyInput["newsFlash"]).toBe(true);
  });

  it("does not call a hot-news CAROUSEL a news flash (the premise)", async () => {
    const { goodBrandTokens, goodStyleConfig } = await import("./test-helpers.js");
    await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens(), requestedMode: "hot-news", instagramFormat: "carousel" });
    const { copyInput } = await run(env, "prefs_hot_news_carousel");
    expect(copyInput["newsFlash"]).toBeUndefined();
  });
});
