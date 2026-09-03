import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { EngineCaptureAdapter } from "@agent-engine/tools";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import type { SeoGeoVisibilityCapture } from "../src/workflow/types.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_real_capture", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * T-A3/SCRUM-237, end to end through the real workflow: a Gemini adapter
 * that reports `aioAbsent: true` for every prompt propagates that fact all
 * the way through `toSeoGeoCell` into the persisted report's capture cells —
 * proving the field isn't dropped anywhere on the way, and that it stays
 * verifiably distinct from an ordinary brand-absent cell on the SAME engine.
 */
describe("T-A3/SCRUM-237: a real per-engine adapter's aioAbsent flag survives to the persisted report", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("Gemini's aioAbsent cells land in the report distinctly from Perplexity's ordinary brand-absent cells", async () => {
    const geminiAdapter: EngineCaptureAdapter = async () => ({
      captureTier: "MEASURED",
      brandMentioned: false,
      brandCited: false,
      competitorsNamed: [],
      citations: [],
      mentionCounts: { client: 0 },
      sentimentPerMention: [],
      rawPayload: { fake: "gemini, no grounding chunks at all" },
      aioAbsent: true,
    });
    const perplexityAdapter: EngineCaptureAdapter = async () => ({
      captureTier: "MEASURED",
      brandMentioned: false,
      brandCited: false,
      competitorsNamed: [],
      citations: [{ domain: "thirdparty.example", ordinal: 1 }],
      mentionCounts: { client: 0 },
      sentimentPerMention: [],
      rawPayload: { fake: "perplexity, answered but never named the brand" },
      // no aioAbsent — this engine doesn't have the concept at all.
    });

    env = await setupTestEnvironment({ visibilityAdapters: { gemini: geminiAdapter, perplexity: perplexityAdapter } });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // `08-assemble-visibility-cells`' own checkpointed step output IS the
    // frozen response set (`SeoGeoVisibilityCapture`) — the raw per-cell
    // `aioAbsent` flag this ticket is about doesn't survive onto the final
    // report object (only aggregate visibility metrics do; that's a
    // pre-existing, out-of-scope design choice, not something T-A3 changes),
    // so this is the one durable place to assert it lands intact.
    const step08 = await durableStore.getStep(params.runId, "08-assemble-visibility-cells");
    const visibilityCapture = step08!.output as SeoGeoVisibilityCapture;

    const geminiCells = visibilityCapture.cells.filter((c) => c.engine === "gemini");
    const perplexityCells = visibilityCapture.cells.filter((c) => c.engine === "perplexity");
    expect(geminiCells.length).toBeGreaterThan(0);
    expect(perplexityCells.length).toBeGreaterThan(0);

    // Every Gemini cell: measured, brand absent, AND aioAbsent — the
    // "Google's AI Overview genuinely did not render" fact, never dropped on
    // the way from the adapter through `toSeoGeoCell`.
    for (const cell of geminiCells) {
      expect(cell.captureTier).toBe("MEASURED");
      expect(cell.brandMentioned).toBe(false);
      expect(cell.aioAbsent).toBe(true);
    }

    // Perplexity's cells are an ORDINARY brand-absent miss on the same
    // brand-absent outcome — no `aioAbsent` at all (the concept doesn't
    // exist for this engine), verifiably distinct from Gemini's cells above.
    for (const cell of perplexityCells) {
      expect(cell.brandMentioned).toBe(false);
      expect(cell.aioAbsent).toBeUndefined();
    }

    // The other 3 engines (chatgpt/copilot/claude) had no adapter configured
    // — `setupTestEnvironment`'s default `null` still applies to them — so
    // they're honestly UNAVAILABLE, distinct from both of the above.
    //
    // Copilot's presence here is the point, not an accident: it has no route
    // in this build (its old ScrappyCoco adapter called a capability that does
    // not exist on that vendor), and an adapter-less engine must report
    // UNAVAILABLE rather than disappear. The deleted adapter THREW instead,
    // and step 07's `completedOutputs` drops failed slots — so Copilot was
    // absent from the report entirely, which is how this went unnoticed.
    const unavailableEngines = new Set(visibilityCapture.cells.filter((c) => c.captureTier === "UNAVAILABLE").map((c) => c.engine));
    expect([...unavailableEngines].sort()).toEqual(["chatgpt", "claude", "copilot"]);
  });
});
