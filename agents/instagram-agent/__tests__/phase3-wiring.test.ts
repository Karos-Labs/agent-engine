import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MEDIA_LIBRARY_SEGMENTS, createMediaLibraryTools, type MediaLibraryDocument } from "@agent-engine/tool-karos-media";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodCopyOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY, VISUAL_DIRECTION_BELIEF_KEY, VisualDirectionSchema, readVisualDirectionAttempt } from "../src/workflow/visual-direction.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "workflow", "create-instagram-agent-workflow.ts");

/**
 * The Phase 3 wiring, end to end through the real workflow (RFC-14 items Q
 * and T).
 *
 * Two loops that only exist once the integrator has joined the pieces, and
 * that no unit test can see:
 *
 *  1. `00d*` — a client with no direction on file DERIVES one, on the setup
 *     meter, and the document is persisted so the next run reuses it.
 *  2. `05y` -> ship -> `09g` — a frame filed in the client's media library is
 *     offered back at tier 0.5 and, when it ships, its use is recorded, which
 *     is what makes "never the same frame twice in a row" answerable at all.
 */

const params = { runId: "ig_phase3", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** A real 1x1 PNG, so the library's content hash and the renderer's file checks both have real bytes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const RIGHTS = { source: "client-upload", licence: "client-supplied — owned by the client" };

/** The art director's answer, in `ArtDirectorOutputSchema`'s shape (the four axes and `gaps` default, `lines` and `styleLock` do not). */
function artDirectorOutput() {
  return {
    subject: ["a founder at their own desk, working"],
    light: ["one soft window source, late afternoon"],
    palette: ["#C4552F", "#17181C"],
    treatment: ["documentary, lightly desaturated"],
    forbid: ["stock handshakes", "boardroom tables"],
    lines: [
      { line: "Shoot the work, not the workplace.", basis: "brief: positioning.oneLiner", confidence: "high" as const },
      { line: "One soft window light from the left, late afternoon, no fill.", basis: "brand kit: lighting", confidence: "medium" as const },
      { line: "Keep the frame inside the brand palette.", basis: "brand kit: palette", confidence: "high" as const },
      { line: "Let the accent appear once as a real object, never as an overlay.", basis: "brand kit: accentColor", confidence: "high" as const },
    ],
    styleLock: { id: "documentary-warm", line: "documentary 35 mm, one soft window source, muted terracotta palette, fine grain" },
    gaps: [],
  };
}

describe("00d* — a client with no visual direction derives one, once", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    // `seedVisualDirection: false` is the derive path: nothing is on file, so
    // `00d` resolves `derive` and the art-director turn IS consumed.
    env = await setupTestEnvironment({ seedVisualDirection: false });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("derives, persists under the belief key, and rides the delivered record with its source named", async () => {
    const router = fakeRouterSequence(
      standardTurns({
        artDirection: artDirectorOutput(),
        scout: goodTrendScoutOutput(),
        research: goodResearchOutput(),
        angle: goodAngleProposal(),
        copy: goodCopyOutput(),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );
    const store = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) } as unknown as AgentToolRegistry,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
    });
    const outcome = await new WorkflowEngine(store).run(workflowFn, { ...params, input: {} });
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    const steps = await store.listSteps(params.runId);
    const ids = steps.map((s) => s.stepId);

    expect(ids).toContain("00d-check-visual-direction");
    expect(ids).toContain("00d1-ingest-visual-patterns");
    expect(ids).toContain("00d2-derive-visual-direction");
    expect(ids).toContain("00d3-persist-visual-direction");
    // The setup plan is the same step id the studio uses — one budget
    // decision, whichever half of the setup is actually running.
    expect(ids).toContain("00c1-plan-setup-budget");
    // `00d` is a SETUP step: it sits before the topic is claimed, so a run
    // that derives a direction has it in hand before any copy is written.
    expect(ids.indexOf("00d-check-visual-direction")).toBeLessThan(ids.indexOf("03-claim-topic"));

    // Persisted, and parseable by the schema that defines it — a direction
    // that could not be read back is a direction the next run re-buys.
    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const stored = VisualDirectionSchema.safeParse(beliefs?.[VISUAL_DIRECTION_BELIEF_KEY]);
    expect(stored.success).toBe(true);
    if (!stored.success) throw new Error("unreachable");
    expect(stored.data.generatedBy).toBe("instagram-art-director@1");
    expect(stored.data.lines).toHaveLength(4);
    expect(stored.data.styleLock.id).toBe("documentary-warm");
    // Consent for the client's own feed is absent in this fixture, as it is
    // for most of the fleet, so the evidence is the brand kit and the brief —
    // named on the document rather than left for a reviewer to guess.
    expect(stored.data.source).toBe("brand+brief");
    expect(stored.data.gaps.join(" ")).toMatch(/visual pattern|feed/i);

    // The deliverable (and the `09a` gate payload built from the same object)
    // carries where the lines came from.
    const deliverables = await env.store.listJson<{ deliverable?: Record<string, unknown> }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const payload = ((deliverables.at(-1)?.data.deliverable ?? {}) as { visualDirection?: { source?: string; lines?: number }; styleLock?: { id?: string; treatment?: string } });
    expect(payload.visualDirection?.source).toBe("brand+brief");
    expect(payload.visualDirection?.lines).toBe(4);
    // Item S rides the same payload: one frozen style for the whole run.
    expect(payload.styleLock?.id).toBe("documentary-warm");
    expect(typeof payload.styleLock?.treatment).toBe("string");
  });

  /**
   * THE RE-BILLING CASE: a derivation that failed used to leave nothing
   * behind.
   *
   * `checkVisualDirection` had two states for "no direction on file", and a
   * failed art-director turn produced neither of them: it produced nothing at
   * all. So the next run read no direction, resolved `derive`, and re-paid
   * `00d1` + `00d2` (~$0.075) every run, forever, against a step documented as
   * running once per client per 90 days. It is recurring spend booked to the
   * one-off per-client setup budget, and invisible to the run's $1.00/$1.50
   * accounting because the setup meter is a different meter.
   */
  it("records a FAILED derivation under its own belief key, and still delivers on the fallback", async () => {
    // The art-director turn comes back as something that is not a direction,
    // so nothing is persisted under the direction key.
    const router = fakeRouterSequence(
      standardTurns({
        artDirection: { nope: true },
        scout: goodTrendScoutOutput(),
        research: goodResearchOutput(),
        angle: goodAngleProposal(),
        copy: goodCopyOutput(),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );
    const store = new MemoryDurableStepStore();
    const outcome = await new WorkflowEngine(store).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) } as unknown as AgentToolRegistry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...params, input: {} },
    );

    // A failed setup step is never a failed post: the fallback direction
    // carries the run.
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    const ids = (await store.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("00d2-derive-visual-direction");
    // `00d3` runs on the failure path too, which is the whole change: it used
    // to sit inside the success branch only.
    expect(ids).toContain("00d3-persist-visual-direction");

    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    expect(beliefs?.[VISUAL_DIRECTION_BELIEF_KEY]).toBeUndefined();
    const attempt = readVisualDirectionAttempt(beliefs);
    expect(attempt?.failedWith).toContain("00d2-derive-visual-direction");
    expect(Date.parse(attempt?.attemptedAt ?? "")).not.toBeNaN();
  }, 120_000);

  it("does not re-pay for a derivation that failed this week: no 00d1, no 00d2, no art-director turn", async () => {
    const marked = await setupTestEnvironment({ seedVisualDirection: false });
    try {
      // Exactly what the run above left behind, seeded so this run stands on
      // its own rather than on the previous test's ordering.
      const beliefs = (await marked.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"])) ?? {};
      await marked.store.writeJson("acme", ["memory", "beliefs"], {
        ...beliefs,
        [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: {
          version: 1,
          attemptedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          failedWith: '00d2-derive-visual-direction resolved to "content_fail"',
        },
      });

      // NO `artDirection` fixture is queued: if `00d` resolved `derive` the
      // fake router would throw "exhausted configured turns", so the saving is
      // asserted as an absence rather than as a cheaper-looking number.
      const router = fakeRouterSequence(
        standardTurns({
          scout: goodTrendScoutOutput(),
          research: goodResearchOutput(),
          angle: goodAngleProposal(),
          copy: goodCopyOutput(),
          relevance: goodRelevanceVerdict(),
          qa: goodVisualQaOutput(),
        }),
      );
      const store = new MemoryDurableStepStore();
      const outcome = await new WorkflowEngine(store).run(
        createInstagramAgentWorkflow({
          tools: { ...marked.tools, "publish.renderCarousel": fakeRenderCarousel(marked.tools["publish.renderCarousel"]!) } as unknown as AgentToolRegistry,
          promptStore: makePromptStore(),
          router,
          repoRoot: marked.repoRoot,
          autoApprove: true,
        }),
        { ...params, input: {} },
      );

      expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
      const steps = await store.listSteps(params.runId);
      const ids = steps.map((s) => s.stepId);
      expect(ids).toContain("00d-check-visual-direction");
      expect(ids).not.toContain("00d1-ingest-visual-patterns");
      expect(ids).not.toContain("00d2-derive-visual-direction");
      // Nothing was spent, so no setup budget was planned either.
      expect(ids).not.toContain("00c1-plan-setup-budget");
      const check = steps.find((s) => s.stepId === "00d-check-visual-direction")?.output as { action?: string; reason?: string };
      expect(check?.action).toBe("unavailable");
      expect(check?.reason).toContain("retry window");

      // The pictures do not degrade while the marker stands: the run still
      // carries a grounded fallback direction, never the neutral one-liner.
      const deliverables = await marked.store.listJson<{ deliverable?: Record<string, unknown> }>("acme", ["ledger", "deliverables", params.runId, "_"]);
      const payload = (deliverables.at(-1)?.data.deliverable ?? {}) as { visualDirection?: { generatedBy?: string; lines?: number } };
      expect(payload.visualDirection?.generatedBy).toContain("fallback");
      expect(payload.visualDirection?.lines ?? 0).toBeGreaterThanOrEqual(4);
    } finally {
      await marked.cleanup();
    }
  }, 120_000);

  it("reuses a fresh stored direction instead: no art-director turn, no 00d1/00d2/00d3", async () => {
    const fresh = await setupTestEnvironment();
    try {
      // No `artDirection` fixture queued at all: if `00d` resolved `derive`
      // here the router would throw "exhausted configured turns", so this is
      // the reuse path asserted as an absence rather than as a step id.
      const router = fakeRouterSequence(
        standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput() }),
      );
      const store = new MemoryDurableStepStore();
      const workflowFn = createInstagramAgentWorkflow({
        tools: fresh.tools as unknown as AgentToolRegistry,
        promptStore: makePromptStore(),
        router,
        repoRoot: fresh.repoRoot,
        autoApprove: true,
      });
      await new WorkflowEngine(store).run(workflowFn, { ...params, input: {} });
      const ids = (await store.listSteps(params.runId)).map((s) => s.stepId);
      expect(ids).toContain("00d-check-visual-direction");
      expect(ids).not.toContain("00d2-derive-visual-direction");
      expect(ids).not.toContain("00d1-ingest-visual-patterns");
      // Nothing was spent, so no setup budget was planned either.
      expect(ids).not.toContain("00c1-plan-setup-budget");
    } finally {
      await fresh.cleanup();
    }
  });
});

describe("05y -> ship -> 09g — the archive loop closes", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "archive"), { recursive: true });
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "archive", "frame.png"), PNG);
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("offers an archived frame at tier 0.5 with no vision call, and records its use once the post ships", async () => {
    const libraryTools = createMediaLibraryTools({ store: env.store });
    const add = libraryTools["media.libraryAdd"] as unknown as AgentTool;
    const seeded = await add.execute(
      {
        repoRoot: env.repoRoot,
        entries: [
          {
            path: ".media-cache/archive/frame.png",
            gcsUri: "gs://karoscmo-uploads/acme/archive-frame.png",
            rights: RIGHTS,
            description: "The founder at a whiteboard, mid-sentence.",
            subjects: ["founder", "whiteboard"],
            mood: "focused",
            inspectedByToolVersion: "1.0.0",
          },
        ],
      },
      { ctx: { ...params, runId: "ig_two_weeks_ago", metadata: {} } } as never,
    );
    if (seeded.status !== "success") throw new Error(`seeding the library failed: ${seeded.status}`);
    const assetId = (seeded.result as { created: string[] }).created[0]!;

    /** Re-ingestion puts the archived object back on this run's disk, under this run's own cache path. */
    const ingestAssets: AgentTool = {
      name: "media.ingestAssets",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        const assets = (args as { assets: Array<{ uri: string; label?: string; slot: number }> }).assets;
        await fs.mkdir(path.join(env.repoRoot, ".media-cache", params.runId), { recursive: true });
        for (const asset of assets) await fs.writeFile(path.join(env.repoRoot, ".media-cache", params.runId, `n${asset.slot}.png`), PNG);
        return {
          status: "success",
          result: {
            candidates: assets.map((a) => ({
              path: `.media-cache/${params.runId}/n${a.slot}.png`,
              description: "re-ingested library object",
              provider: "client-library",
              licenseConfidence: "client-supplied",
            })),
            unmet: [],
          },
        };
      },
    } as unknown as AgentTool;

    /** Vision, present but expected to go unused: the archived frame carries its stored description. */
    const inspectCalls: string[] = [];
    const inspectImages: AgentTool = {
      name: "media.inspectImages",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        // The REFS say which caller this is: `05c` asks about candidates as
        // `c-N`, `08a4` about rendered slides as `slide-N`. (Both declare the
        // same `purpose`, so the purpose cannot tell them apart.)
        for (const image of (args as { images: Array<{ ref: string }> }).images) inspectCalls.push(image.ref);
        return { status: "content_fail", reason: "no vision backend in this fixture" };
      },
    } as unknown as AgentTool;

    const copy = goodCopyOutput();
    const libraryPath = `.media-cache/${params.runId}/n1.png`;
    const vetting = {
      selections: copy.slides.map((slide, index) => ({
        n: slide.n,
        imagePath: index === 0 ? libraryPath : null,
        reason: index === 0 ? "the client's own archived frame shows the claim" : "no candidate for this slide",
        license: index === 0 ? "client-supplied" : "n/a — no candidate qualified",
        rightsUsable: index === 0,
        watermarkFree: index === 0,
        claimMatch: index === 0 ? 5 : 1,
        claimMatchReason: index === 0 ? "the founder at a whiteboard is the claim" : "nothing to judge",
      })),
    };

    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
      "media.libraryList": libraryTools["media.libraryList"],
      "media.libraryAdd": libraryTools["media.libraryAdd"],
      "media.ingestAssets": ingestAssets,
      "media.inspectImages": inspectImages,
    } as unknown as AgentToolRegistry;

    const router = fakeRouterSequence(
      standardTurns({
        scout: goodTrendScoutOutput(),
        research: goodResearchOutput(),
        angle: goodAngleProposal(),
        copy,
        vet: vetting,
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...params, input: {} },
    );
    expect(result.status).toBe("completed");

    const steps = await store.listSteps(params.runId);
    const read = steps.find((s) => s.stepId === "05y-read-media-library");
    expect(JSON.stringify(read?.output)).toContain(assetId);
    // The saving that makes tier 0.5 cheaper than doing nothing: the stored
    // description means the archived frame costs no CANDIDATE vision call,
    // and with the pool made of archived frames alone `05c` is never even
    // entered. (`08a4` still looks at the RENDERED slides — a different call
    // about a different picture, and not the one item T is saving.)
    expect(inspectCalls.filter((ref) => ref.startsWith("c-"))).toEqual([]);
    expect(steps.some((s) => s.stepId.startsWith("05c-inspect-candidates"))).toBe(false);

    // The use, recorded only after delivery — the same rule
    // `ledger.recordUsedImages` follows.
    expect(steps.map((s) => s.stepId)).toContain("09g-record-media-library-use");
    const doc = await env.store.readJson<MediaLibraryDocument>("acme", [...MEDIA_LIBRARY_SEGMENTS]);
    const entry = doc?.entries.find((e) => e.assetId === assetId);
    expect(entry?.usedIn.map((u) => ({ runId: u.runId, slide: u.slide }))).toEqual([{ runId: params.runId, slide: 1 }]);
    // And the path it was known by THIS run is remembered, so the ledger's
    // cross-post rule still recognises the frame next time.
    expect(entry?.knownPaths).toContain(libraryPath);
  });
});

describe("item S's treatment sheet reaches every document this run renders", () => {
  /**
   * A source pin, in the shape `art-direction.test.ts` already uses.
   *
   * The grade is delivered by a stylesheet spliced through `extraHeadHtml`,
   * so the failure mode is not a wrong filter — it is ONE document builder
   * that still passes the device sheet alone and silently renders an ungraded
   * photograph next to five graded ones. Driving all four call sites for real
   * needs Chromium and four different brand kits; what is actually at risk is
   * someone adding a fifth call site.
   */
  it("every run-path document is built with headExtras(), never the device sheet alone", () => {
    const source = readFileSync(WORKFLOW_SOURCE, "utf8");
    // Exactly ONE `extraHeadHtml: deviceCssBlock()` survives, and on purpose:
    // the Template Studio's validation render at `00c5`, which runs BEFORE
    // `04k` freezes the style and which judges a template as a template — on
    // the ungraded photograph.
    expect(source.split("extraHeadHtml: deviceCssBlock()")).toHaveLength(2);
    const studioCallSite = source.indexOf("extraHeadHtml: deviceCssBlock()");
    expect(studioCallSite).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, studioCallSite - 500), studioCallSite)).toContain("validated as a TEMPLATE");
    // And the four that matter: `materializeTemplates` twice, the branded
    // no-store copy, and the custom-archetype writer.
    expect(source.split("headExtras()")).toHaveLength(6);
  });
});
