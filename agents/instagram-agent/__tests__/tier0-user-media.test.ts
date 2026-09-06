import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { AgentTool } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodResearchOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * Tier 0 — media the client attached to this run.
 *
 * Above every sourcing tier, because a client who uploaded a photograph has
 * told us exactly what they want on the slide. The tiers below exist to fill
 * what they did not supply, never to compete with what they did.
 */

const params = { runId: "ig_tier0", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/**
 * A stand-in for `media.ingestAssets`, which the workflow now calls rather than
 * passing attachment URIs straight through. It returns repo-relative paths
 * because that is the contract the renderer enforces: `assertInside` refuses
 * URL-shaped strings, so a gs:// path in the pool would die at step 08.
 */
function stubIngestAssets(onCall?: (args: Record<string, unknown>) => void, failing = false): AgentTool {
  return {
    name: "media.ingestAssets",
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      onCall?.(args as Record<string, unknown>);
      if (failing) return { status: "content_fail", reason: "the object is empty" };
      const assets = (args as { assets: Array<{ uri: string; label?: string; slot: number }> }).assets;
      return {
        status: "success",
        result: {
          candidates: assets.map((a) => ({
            path: `.media-cache/run/n${a.slot}-client.png`,
            description: `slide ${a.slot} candidate -- CLIENT-SUPPLIED asset uploaded with this run${a.label ? ` ("${a.label}")` : ""}. rights-cleared. [licence: client-supplied]`,
            provider: "client-upload",
            licenseConfidence: "client-supplied",
          })),
          unmet: [],
        },
      };
    },
  } as unknown as AgentTool;
}

/** Records the needs each tier was asked to fill, so "did not waste a call" is provable. */
function recordingFindImages(seen: { needs?: Array<{ n: number }> }): AgentTool {
  return {
    name: "media.findImages",
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      seen.needs = (args as { needs: Array<{ n: number }> }).needs;
      return { status: "content_fail", reason: "nothing found" };
    },
  } as unknown as AgentTool;
}

describe("instagram Tier 0: client-supplied media", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  async function run(input: Record<string, unknown>, tools: Record<string, unknown>) {
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy)]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, ...tools } as never,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
    });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...params, input });
    const steps = await store.listSteps(params.runId);
    return { steps, copy, result };
  }

  it("turns each attachment into an ingested, repo-relative candidate marked client-supplied", async () => {
    let ingested: Record<string, unknown> | undefined;
    const { steps } = await run(
      {
        mediaAssets: [
          { uri: "gs://bucket/hero.jpg", role: "source", label: "hero shot" },
          { uri: "gs://bucket/second.jpg", role: "source" },
        ],
      },
      { "media.ingestAssets": stubIngestAssets((a) => { ingested = a; }) },
    );

    const tier0 = steps.find((s) => s.stepId === "05z-attach-user-media");
    const result = tier0?.output as { candidates: Array<{ path: string; licenseConfidence: string; description: string }>; slots: number[]; attached: number };

    expect(result.attached).toBe(2);
    // Deterministic slide assignment: first upload to slide 1, second to slide 2.
    // A rule someone can predict, rather than a model deciding which of their
    // photos "fits" where.
    expect((ingested?.["assets"] as Array<{ uri: string; slot: number }>).map((a) => [a.slot, a.uri])).toEqual([
      [1, "gs://bucket/hero.jpg"],
      [2, "gs://bucket/second.jpg"],
    ]);
    expect(result.slots).toEqual([1, 2]);
    // Repo-relative, because assertInside refuses URL-shaped strings and a
    // gs:// path would otherwise die at the render step.
    expect(result.candidates.every((c) => c.path.startsWith(".media-cache/"))).toBe(true);
    // Without a distinct licence tier the gate would treat an upload as
    // unknown provenance and refuse the one asset the client actually owns.
    expect(result.candidates[0]!.licenseConfidence).toBe("client-supplied");
    expect(result.candidates[0]!.description).toContain("CLIENT-SUPPLIED");
    expect(result.candidates[0]!.description).toContain("hero shot");
    expect(result.candidates[0]!.description).toContain("rights-cleared");
  });

  it("does not ask the harvesters for slides Tier 0 already filled", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    await run(
      { mediaAssets: [{ uri: "gs://bucket/a.jpg" }, { uri: "gs://bucket/b.jpg" }] },
      { "media.findImages": recordingFindImages(seen), "media.ingestAssets": stubIngestAssets() },
    );

    // Slides 1 and 2 are covered; paying a harvester for a candidate that must
    // lose to the client's own photo is pure waste.
    expect(seen.needs?.map((n) => n.n)).not.toContain(1);
    expect(seen.needs?.map((n) => n.n)).not.toContain(2);
    expect((seen.needs?.length ?? 0)).toBeGreaterThan(0);
  });

  it("asks for every slide when nothing was attached, exactly as before Tier 0 existed", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    const { copy } = await run({}, { "media.findImages": recordingFindImages(seen) });

    expect(seen.needs?.map((n) => n.n)).toEqual(copy.slides.map((s) => s.n));
  });

  it("ignores an attachment whose role is not a usable image slot", async () => {
    let ingested: Record<string, unknown> | undefined;
    await run(
      { mediaAssets: [{ uri: "gs://bucket/logo.png", role: "logo" }, { uri: "gs://bucket/ok.jpg", role: "source" }] },
      { "media.ingestAssets": stubIngestAssets((a) => { ingested = a; }) },
    );
    // A logo is brand furniture the template places, not a slide photograph, so
    // it never reaches the ingester at all.
    expect((ingested?.["assets"] as Array<{ uri: string }>).map((a) => a.uri)).toEqual(["gs://bucket/ok.jpg"]);
  });

  it("does not reserve slides when the ingest failed, so the harvesters still cover them", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    const { steps } = await run(
      { mediaAssets: [{ uri: "gs://bucket/broken.jpg" }] },
      { "media.findImages": recordingFindImages(seen), "media.ingestAssets": stubIngestAssets(undefined, true) },
    );

    const result = steps.find((s) => s.stepId === "05z-attach-user-media")?.output as { slots: number[]; note?: string };
    // An attachment that failed to ingest must not hold a slide the harvesters
    // would then skip, which would leave it empty for the rest of the run.
    expect(result.slots).toEqual([]);
    expect(String(result.note)).toContain("could not be ingested");
    expect(seen.needs?.map((n) => n.n)).toContain(1);
  });

  it("records zero attachments rather than skipping the step, so a run says it looked", async () => {
    const { steps } = await run({}, {});
    const tier0 = steps.find((s) => s.stepId === "05z-attach-user-media");
    expect(tier0).toBeDefined();
    expect((tier0?.output as { attached: number }).attached).toBe(0);
  });

  // ── "Only media I upload for this job" (mediaSource: "client", 2026-09-06) ──

  it("client media only, nothing attached: refuses intake before copy is paid for, naming both ways out", async () => {
    const calls: string[] = [];
    const { result, steps } = await run(
      { mediaSource: "client" },
      { "media.findImages": recordingFindImages({}), "media.ingestAssets": stubIngestAssets(() => { calls.push("ingest"); }) },
    );
    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/client-provided media only, but no images were attached/);
    expect(result.reason).toMatch(/let the agent source them/);
    expect(calls).toEqual([]);
    // The refusal is the FIRST step: no auto-setup, no topic claim, no research
    // pull, no copy — nothing was spent on a carousel that could not be made.
    expect(steps.map((s) => s.stepId)).toEqual(["00a-check-media-source"]);
  });

  it("client media only, two images attached: places them and asks NO harvester, scraper or generator for the rest", async () => {
    const calls: string[] = [];
    const never = (name: string): AgentTool =>
      ({
        name,
        version: "1.0.0",
        inputSchema: { parse: (v: unknown) => v } as never,
        async execute() {
          calls.push(name);
          return { status: "content_fail", reason: "must not be asked" };
        },
      }) as unknown as AgentTool;
    const { steps } = await run(
      { mediaSource: "client", mediaAssets: [{ uri: "gs://bucket/a.jpg" }, { uri: "gs://bucket/b.jpg" }] },
      {
        "media.ingestAssets": stubIngestAssets(),
        "media.findImages": never("media.findImages"),
        "media.scrapeImages": never("media.scrapeImages"),
        "image.generate": never("image.generate"),
      },
    );
    const tier0 = steps.find((s) => s.stepId === "05z-attach-user-media")?.output as { slots: number[] };
    expect(tier0.slots).toEqual([1, 2]);
    expect(calls).toEqual([]);
    expect(steps.some((s) => /05b-source-images|06[bd]-(scrape|generate)-images/.test(s.stepId))).toBe(false);
  });

  it("system-managed media (the default) still sources for the slides the client did not cover — nothing changed for the untouched dialog", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    await run(
      { mediaSource: "system", mediaAssets: [{ uri: "gs://bucket/a.jpg" }] },
      { "media.findImages": recordingFindImages(seen), "media.ingestAssets": stubIngestAssets() },
    );
    expect((seen.needs?.length ?? 0)).toBeGreaterThan(0);
    expect(seen.needs?.map((n) => n.n)).not.toContain(1);
  });
});
