import { rm, mkdir, copyFile, access } from "node:fs/promises";
import * as pathMod from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createKarosMediaTools } from "@agent-engine/tool-karos-media";
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
 * ── THE POST THAT SHIPPED WITH NO PICTURES BECAUSE THE CONTAINER MOVED. ──
 *
 * prep run `pubsub-21904879061334183` (karoslabs, 2026-09-20). The run found
 * four pictures — including a geo-verified photograph of ChatGPT that the
 * entity route went and fetched, which is the exact thing the owner had asked
 * for three times — and generated three more with Gemini. Then:
 *
 *     14:14:00  SIGTERM received - stopping the pull subscription
 *     14:21:22  workflow-engine: reclaimed abandoned run
 *               "pubsub-21904879061334183" (no heartbeat for at least 300s)
 *
 * `.media-cache/` is an `emptyDir` with `medium: Memory`: a tmpfs in the
 * instance's own RAM, mounted per instance, on a service that scales to five.
 * Every one of those seven files was in the RAM of a container that no longer
 * existed, and no other instance could ever have seen them anyway.
 *
 * What made it a silent disaster rather than a retry was that every guard
 * which could have noticed was a CHECKPOINTED `step.code`. On the resume they
 * all replayed their stored verdicts from Firestore in the same millisecond:
 *
 *     06f-verify-images-on-disk  ->  []                             (nothing missing)
 *     06h-imagery-floor-check    ->  {action:"ok", pictureSlides:4} (floor met)
 *
 * Both were false, and both were the recordings of a machine that had since
 * been destroyed. `08-render-carousel` was the first step to actually open a
 * file; it returned `content_fail`, and the post fell through to the
 * typographic fallback and shipped with zero pictures.
 *
 * This test is that run. It stages the images, destroys the media cache the
 * way an instance recycle does, resumes, and demands the pictures come back.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** An in-memory stand-in for the GCS media store — the upload half and the read-back half, which in production are the same object. */
function fakeMediaStore() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    bucketName: "test-media",
    async exists(objectPath: string) {
      return objects.has(objectPath);
    },
    async upload(objectPath: string, bytes: Buffer, _opts?: { contentType?: string }) {
      objects.set(objectPath, Buffer.from(bytes));
      // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not the
      // same as an absent key, and `signedUrl` is optional. Omit it — the
      // production store omits it too when signing is unavailable.
      return { objectPath, gcsUri: `gs://test-media/${objectPath}` };
    },
    async download(objectPath: string): Promise<Buffer> {
      const found = objects.get(objectPath);
      if (found === undefined) throw new Error(`fakeMediaStore: no object at ${objectPath}`);
      return found;
    },
  };
}

describe("images survive an instance recycle (prep pubsub-21904879061334183)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-fetches the chosen pictures from the media bucket when the local cache is gone, instead of shipping a text-only post", async () => {
    const media = fakeMediaStore();

    const durableStore = new MemoryDurableStepStore();
    const runId = "instance_recycle_keeps_pictures";
    const copy = goodCopyOutput();

    // ── The pool has to live where a real pool lives. ──
    //
    // `goodImageCandidatePool()` points at `fixtures/images/`, and
    // `media.stageAsset` refuses — correctly — anything outside
    // `.media-cache/`. In production every tier writes into
    // `.media-cache/<runId>/` and there is nothing to arrange; here the
    // fixture frames are copied in so the paths under test are the paths the
    // engine actually handles.
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
    // `goodImageVettingOutput()` names the fixture paths literally, so the
    // vet's own verdict has to be re-pointed at the relocated pool too —
    // otherwise the selections reference `fixtures/` and nothing is stageable.
    const vettingOutput = JSON.parse(
      [...remap.entries()].reduce((json, [from, to]) => json.split(from).join(to), JSON.stringify(goodImageVettingOutput())),
    ) as ReturnType<typeof goodImageVettingOutput>;

    // ── The instance recycle, modelled at the exact moment it happened. ──
    //
    // `media.stageAsset` is wrapped so that each file, once its bytes are
    // safely in the bucket, is DELETED from the local cache. By the time
    // `06e2-stage-images-durably` returns, every picture is exactly where the
    // real run's pictures were at 14:21:22: present in the media bucket,
    // absent from this machine.
    //
    // Deleting the real files rather than mocking a check is the point. The
    // defect was that nothing looked at the disk; a test that mocks the
    // looking cannot fail for the original reason.
    const realMediaTools = createKarosMediaTools({ objectReader: media, mediaStore: media });
    const stageAsset = realMediaTools["media.stageAsset"]!;
    const recyclingStageAsset = {
      ...stageAsset,
      async execute(input: unknown, opts: unknown) {
        const outcome = await (stageAsset as { execute: (i: unknown, o: unknown) => Promise<{ status: string }> }).execute(input, opts);
        if (outcome.status === "success") {
          await rm(pathMod.resolve(env.repoRoot, (input as { path: string }).path), { force: true });
        }
        return outcome;
      },
    } as AgentToolRegistry[string];

    const tools = {
      ...env.tools,
      ...realMediaTools,
      "media.stageAsset": recyclingStageAsset,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    } as AgentToolRegistry;

    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()),
      finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(copy),
      finalTurn(vettingOutput),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(goodVisualQaOutput()),
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);

    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: pool,
      }),
      { ...base, runId },
    );
    expect(result.status).toBe("awaiting_gate");

    // The bytes reached the bucket. Without this the rest proves nothing,
    // because there would have been nothing to recover from.
    expect(media.objects.size, "no image was staged, so the recovery below is not what is being tested").toBeGreaterThan(0);

    // ── THE ASSERTION THE OWNER CARES ABOUT: the post has pictures. ──
    //
    // Before the fix this list is empty: the local files are gone, the
    // checkpointed disk check answers from its recording, and
    // `08-render-carousel` content_fails into the typographic fallback.
    const slidesStep = (await durableStore.listSteps(runId)).find((s) => s.stepId.startsWith("07c-emit-slides-data"));
    const slidesData = slidesStep?.output as { slides: Array<{ n: number; images?: Record<string, string> }> };
    const withPictures = slidesData.slides.filter((s) => Object.keys(s.images ?? {}).length > 0);
    expect(withPictures.length, "the carousel shipped with no pictures after the recycle — this is the 2026-09-20 defect").toBeGreaterThan(0);

    // And every path it names is really there. A slide pointing at a file
    // that is not on disk is exactly what the renderer refuses, so a
    // recovered path that is merely recorded is not a recovery.
    for (const slide of withPictures) {
      for (const rel of Object.values(slide.images ?? {})) {
        await expect(access(pathMod.resolve(env.repoRoot, rel)), `slide ${slide.n} points at ${rel}, which is not on disk`).resolves.toBeUndefined();
      }
    }
  }, 120_000);
});
