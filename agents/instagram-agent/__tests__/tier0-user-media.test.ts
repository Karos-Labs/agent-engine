import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MEDIA_LIBRARY_SEGMENTS, createMediaLibraryTools, type MediaLibraryDocument } from "@agent-engine/tool-karos-media";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { fakeRouterSequence, goodCopyOutput, goodResearchOutput, goodTrendScoutOutput, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";
import { standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

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
    // Through the scout, research and copy; the tests below stop at Tier 0 /
    // 05b and never need a vetting turn.
    const router = fakeRouterSequence(standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy }));
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
    // `instagram-image-vet@3` (RFC-13 §F) tells uploads apart from harvested
    // candidates by this prefix — `ImageCandidate` has no source field — so
    // the vet may re-offer an upload to the slide it honestly fits.
    expect(result.candidates[0]!.description.startsWith("[client upload, slot 1] ")).toBe(true);
    expect(result.candidates[1]!.description.startsWith("[client upload, slot 2] ")).toBe(true);
  });

  it("asks the harvesters for the Tier 0 slots as well, so an upload the vet moves elsewhere leaves alternatives behind", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    const { copy } = await run(
      { mediaAssets: [{ uri: "gs://bucket/a.jpg" }, { uri: "gs://bucket/b.jpg" }] },
      { "media.findImages": recordingFindImages(seen), "media.ingestAssets": stubIngestAssets() },
    );

    // Until 2026-09 slots 1 and 2 were skipped as "already filled". The
    // semantic vet (`instagram-image-vet@3`) may now place the client's
    // upload on whichever photo slide it fits — a photo of one team's fans
    // does not belong under a headline about another — and a slot it moved
    // off would then be forced text-only without a harvested alternative.
    // One retrieval call for two more needs is the price of not shipping a
    // typographic slide where a picture was available. Client-only runs
    // (`mediaSource: "client"`) still harvest nothing — see below.
    expect(seen.needs?.map((n) => n.n)).toEqual(copy.slides.map((s) => s.n));
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

  it("system-managed media (the default) still sources for every photo slide, the client-covered one included — nothing changed for the untouched dialog", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    const { copy } = await run(
      { mediaSource: "system", mediaAssets: [{ uri: "gs://bucket/a.jpg" }] },
      { "media.findImages": recordingFindImages(seen), "media.ingestAssets": stubIngestAssets() },
    );
    expect((seen.needs?.length ?? 0)).toBeGreaterThan(0);
    // Slot 1 is included since `instagram-image-vet@3` (see the Tier 0 test above).
    expect(seen.needs?.map((n) => n.n)).toEqual(copy.slides.map((s) => s.n));
  });

  // ── RFC-14 item T: the upload also joins the client's media library ──
  //
  // These two go green when the integrator extends `05z-attach-user-media`
  // (step 4 of the Phase 3 wiring order) to file each upload through
  // `media.libraryAdd` after the existing `media.inspectImages` pass. The step
  // id does not change; the write is BEST-EFFORT, which is what the second
  // test is actually about.

  /** A 1x1 PNG on disk at the path `stubIngestAssets` claims, so the real library tool has real bytes to hash. */
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

  async function stageUploadedFile(slot: number) {
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "run"), { recursive: true });
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "run", `n${slot}-client.png`), PNG);
  }

  /** `media.inspectImages` with a real answer, so there is a description worth filing. */
  function stubInspect(): AgentTool {
    return {
      name: "media.inspectImages",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        const images = (args as { images: Array<{ ref: string }> }).images;
        return {
          status: "success",
          result: {
            inspections: images.map((i) => ({
              ref: i.ref,
              description: "The founder on a conference stage, mid-sentence, warm side light.",
              subjects: ["founder", "conference stage"],
              textInImage: [],
              mood: "energetic",
            })),
            unreadable: [],
            model: "gemini-2.5-flash",
          },
        };
      },
    } as unknown as AgentTool;
  }

  it("files the upload in the client's media library with the description the run already paid for", async () => {
    await stageUploadedFile(1);
    const library = createMediaLibraryTools({ store: env.store });
    await run(
      { mediaAssets: [{ uri: "gs://bucket/hero.jpg", role: "source", label: "hero shot" }] },
      { "media.ingestAssets": stubIngestAssets(), "media.inspectImages": stubInspect(), ...library },
    );

    const doc = await env.store.readJson<MediaLibraryDocument>("acme", [...MEDIA_LIBRARY_SEGMENTS]);
    expect(doc?.entries).toHaveLength(1);
    // The point of the library: the sentence a vision call produced this run is
    // still on file next run, so the same frame costs nothing to reuse.
    expect(doc?.entries[0]!.description).toContain("conference stage");
    expect(doc?.entries[0]!.subjects).toEqual(["founder", "conference stage"]);
    expect(doc?.entries[0]!.gcsUri).toBe("gs://bucket/hero.jpg");
    expect(doc?.entries[0]!.rights.source).toContain("client");
  });

  /**
   * The pairing property, on the WRITE side, where a mistake is durable.
   *
   * `media.ingestAssets` reports an unreadable object in `unmet` and carries
   * on, so `result.candidates` is the surviving subset of the request. Filing
   * by array index would therefore record the surviving frame's bytes and
   * description under the FAILED upload's `gcsUri` — and `media.libraryAdd`
   * keeps the first sighting and only overwrites `gcsUri` when a later call
   * supplies one, so the wrong URI would never be corrected: a later run would
   * re-ingest the wrong object and hand the vet a sentence about a picture it
   * is not looking at.
   */
  it("files each upload under ITS OWN durable URI when an earlier attachment could not be ingested", async () => {
    await stageUploadedFile(2);
    const partialIngest: AgentTool = {
      name: "media.ingestAssets",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        const assets = (args as { assets: Array<{ uri: string; slot: number }> }).assets;
        const [dead, ...alive] = assets;
        return {
          status: "success",
          result: {
            candidates: alive.map((a) => ({
              path: `.media-cache/run/n${a.slot}-client.png`,
              description: `slide ${a.slot} candidate, CLIENT-SUPPLIED asset uploaded with this run. [licence: client-supplied]`,
              provider: "client-upload",
              licenseConfidence: "client-supplied",
            })),
            unmet: [{ slot: dead!.slot, uri: dead!.uri, reason: "the object is empty" }],
          },
        };
      },
    } as unknown as AgentTool;

    const library = createMediaLibraryTools({ store: env.store });
    const { steps } = await run(
      {
        mediaAssets: [
          { uri: "gs://bucket/broken.jpg", role: "source" },
          { uri: "gs://bucket/good.jpg", role: "source", label: "the one that worked" },
        ],
      },
      { "media.ingestAssets": partialIngest, "media.inspectImages": stubInspect(), ...library },
    );

    const doc = await env.store.readJson<MediaLibraryDocument>("acme", [...MEDIA_LIBRARY_SEGMENTS]);
    expect(doc?.entries).toHaveLength(1);
    expect(doc?.entries[0]!.gcsUri).toBe("gs://bucket/good.jpg");
    expect(doc?.entries[0]!.description).toContain("the one that worked");

    // The same slot, everywhere the run reports it: the surviving upload is
    // slide 2's, so it must not reserve slide 1 or be labelled as slide 1's.
    const tier0 = steps.find((s) => s.stepId === "05z-attach-user-media")?.output as {
      slots: number[];
      candidates: Array<{ description: string }>;
      analyses: Array<{ slot: number }>;
    };
    expect(tier0.slots).toEqual([2]);
    expect(tier0.analyses.map((a) => a.slot)).toEqual([2]);
    expect(tier0.candidates[0]!.description.startsWith("[client upload, slot 2] ")).toBe(true);
  });

  it("leaves the run byte-identical when the library write fails — a note, never a failure", async () => {
    await stageUploadedFile(1);
    const failingAdd: AgentTool = {
      name: "media.libraryAdd",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute() {
        return { status: "tooling_error", reason: "the workspace is read-only" };
      },
    } as unknown as AgentTool;

    const input = { mediaAssets: [{ uri: "gs://bucket/hero.jpg", role: "source" }] };
    const withoutLibrary = await run(input, { "media.ingestAssets": stubIngestAssets(), "media.inspectImages": stubInspect() });
    await env.cleanup();
    env = await setupTestEnvironment();
    await stageUploadedFile(1);
    const withFailingLibrary = await run(input, { "media.ingestAssets": stubIngestAssets(), "media.inspectImages": stubInspect(), "media.libraryAdd": failingAdd });

    const tier0Of = (steps: Awaited<ReturnType<typeof run>>["steps"]) => {
      const output = steps.find((s) => s.stepId === "05z-attach-user-media")?.output as Record<string, unknown>;
      // The library note is allowed to differ — it is the only thing that may.
      const { note: _note, ...rest } = output;
      return rest;
    };
    expect(tier0Of(withFailingLibrary.steps)).toEqual(tier0Of(withoutLibrary.steps));
    expect(String((withFailingLibrary.steps.find((s) => s.stepId === "05z-attach-user-media")?.output as { note?: string }).note ?? "")).toContain("library");
  });
});
