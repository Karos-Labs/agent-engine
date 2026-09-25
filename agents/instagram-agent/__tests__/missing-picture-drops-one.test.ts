import { rm, mkdir, copyFile } from "node:fs/promises";
import * as pathMod from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * ONE MISSING FILE COSTS ONE PICTURE, NOT THE POST.
 *
 * prep `pubsub-21255146309711587` (Sitti, 2026-09-25): a worker restart lost
 * the cover's generated frame, `08-render-carousel` refused on that one path,
 * and the fallback stripped every picture, so a post holding three shipped
 * with none. The test deletes ONE picture's file right before the first
 * render, the way the restart did, and demands the others survive.
 */
describe("a render refused on one missing picture keeps the rest", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("drops only the missing picture and never falls to the fully typographic plate", async () => {
    const durableStore = new MemoryDurableStepStore();
    const runId = "missing_picture_drops_one";
    const cacheDir = pathMod.join(env.repoRoot, ".media-cache", runId);
    await mkdir(cacheDir, { recursive: true });
    const remap = new Map<string, string>();
    const pool = await Promise.all(
      goodImageCandidatePool().map(async (candidate, index) => {
        const rel = `.media-cache/${runId}/n${index + 1}-pool.png`;
        await copyFile(pathMod.resolve(env.repoRoot, candidate.path), pathMod.resolve(env.repoRoot, rel));
        remap.set(candidate.path, rel);
        return { ...candidate, path: rel };
      }),
    );
    const vettingOutput = JSON.parse(
      [...remap.entries()].reduce((json, [from, to]) => json.split(from).join(to), JSON.stringify(goodImageVettingOutput())),
    ) as ReturnType<typeof goodImageVettingOutput>;

    let deleted: { n: number; path: string } | undefined;
    const fake = fakeRenderCarousel(env.tools["publish.renderCarousel"]!);
    const render = {
      ...fake,
      async execute(args: unknown, opts: unknown) {
        if (deleted === undefined) {
          const slides = (args as { slides: Array<{ n: number; images?: Record<string, string> }> }).slides;
          const uses = new Map<string, number[]>();
          for (const s of slides) for (const rel of Object.values(s.images ?? {})) uses.set(rel, [...(uses.get(rel) ?? []), s.n]);
          const only = [...uses.entries()].find(([, ns]) => ns.length === 1);
          if (only !== undefined) {
            deleted = { n: only[1][0]!, path: only[0] };
            await rm(pathMod.resolve(env.repoRoot, only[0]), { force: true });
          }
        }
        return (fake as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, opts);
      },
    } as AgentToolRegistry[string];

    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()),
      finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(vettingOutput),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(goodVisualQaOutput()),
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": render } as AgentToolRegistry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: pool,
      }),
      { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", runId },
    );
    expect(result.status).toBe("awaiting_gate");
    // The premise: a picture used by exactly one slide was really deleted.
    expect(deleted, "no single-use picture to delete, so the case proves nothing").toBeDefined();

    const steps = await durableStore.listSteps(runId);
    const ids = steps.map((s) => s.stepId);
    expect(ids).toContain("08a-find-missing-pictures-attempt-1");
    expect(ids).toContain("08-render-carousel-partial-attempt-1");
    expect(ids, "fell to the fully typographic plate").not.toContain("08-render-carousel-typographic-attempt-1");
    const partial = steps.find((s) => s.stepId === "08a-render-fallback-partial-attempt-1")?.output as { slides: Array<{ n: number; images?: Record<string, string> }> };
    const pictured = partial.slides.filter((s) => Object.keys(s.images ?? {}).length > 0);
    expect(pictured.length, "the other pictures were lost too").toBeGreaterThan(0);
    expect(pictured.some((s) => s.n === deleted!.n)).toBe(false);
  }, 120_000);
});
