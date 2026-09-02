import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { SEO_GEO_CAPTURE_ENGINES, SEO_GEO_VISIBILITY_ENGINES } from "@agent-engine/tool-karos-seo-geo";
import { VISIBILITY_ENGINES } from "@agent-engine/tools";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { sha256Hex } from "../src/workflow/prompt-set.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-396, the cross-package half. RFC-01 §4 keeps tool packages independent
 * of each other, so `karos-research` cannot import `karos-seo-geo` and its
 * `VISIBILITY_ENGINES` is a second literal by design. That independence is
 * precisely how the two lists were free to drift, and this workspace is the one
 * place that legitimately sees both — it is where the workflow layer wires them
 * together, so it is where they get pinned equal.
 */
describe("SCRUM-396: the two tool packages' engine lists cannot drift apart", () => {
  it("karos-research's VISIBILITY_ENGINES is exactly karos-seo-geo's ratified list, in the same order", () => {
    // Order matters as well as membership: `engineListHash` is a hash of the
    // array, so a reordering is a silent reproducibility break.
    expect([...VISIBILITY_ENGINES]).toEqual([...SEO_GEO_VISIBILITY_ENGINES]);
  });

  it("the capture tool accepts every engine the scoring schema accepts", () => {
    // The asymmetry that would actually hurt: an engine the scorer can store but
    // the capture tool's own input enum rejects, so a cell can never be written
    // for a column the report is willing to show.
    for (const engine of SEO_GEO_VISIBILITY_ENGINES) {
      expect(VISIBILITY_ENGINES as readonly string[], `capture tool must accept ${engine}`).toContain(engine);
    }
  });
});

describe("SCRUM-396: engineListHash", () => {
  /**
   * The batch plan's first concern was that widening the list would break every
   * prior run's frozen `engineListHash`. It does not, and this is the assertion
   * that keeps it true: the hash covers `SEO_GEO_CAPTURE_ENGINES` (what a run
   * measured), not the accepted list (what a cell may claim), and SCRUM-396 only
   * widened the latter.
   *
   * The literal below is the value agent-engine has been minting since T-A3 —
   * `sha256Hex(["chatgpt","perplexity","gemini","claude","copilot"])`. If this
   * test fails, the captured engine list changed, and that is a deliberate
   * reproducibility bump: every prior run's record stops being comparable, so
   * update the literal only together with a decision record saying why.
   */
  const FROZEN_HASH = "98881508eb5591f3f6b6d8db29bd12496f6e733c66512780e6d85ea3144b88dd";

  it("is unchanged by SCRUM-396, so no prior run's frozen record is invalidated", () => {
    expect(sha256Hex(SEO_GEO_CAPTURE_ENGINES)).toBe(FROZEN_HASH);
  });

  it("would have changed had the hash been taken over the accepted list instead", () => {
    // Proves the premise rather than asserting the conclusion: the hash is
    // stable BECAUSE it reads the captured list. If someone "simplifies" the
    // freeze step back to hashing SEO_GEO_VISIBILITY_ENGINES, the stability
    // above is gone — so pin that the two are genuinely different inputs.
    expect(sha256Hex(SEO_GEO_VISIBILITY_ENGINES)).not.toBe(FROZEN_HASH);
  });

  /**
   * The two assertions above are the ones T-B21's post-mortem warns about: they
   * pin the CONSTANT, at the constant's own layer, and both still pass if
   * `04-freeze-prompt-set` goes back to hashing the accepted list. So the value
   * that matters is asserted where it actually lands — in the frozen run record
   * a real workflow run wrote.
   */
  describe("as the workflow actually freezes it", () => {
    let env: TestEnvironment;
    beforeEach(async () => {
      env = await setupTestEnvironment();
    });
    afterEach(async () => {
      await env.cleanup();
    });

    it("04-freeze-prompt-set records the captured list's hash, not the accepted list's", async () => {
      const durableStore = new MemoryDurableStepStore();
      const workflowFn = createSeoGeoAgentWorkflow({
        tools: withMeasuredCapture(env.tools),
        promptStore: makePromptStore(),
        router: smartFakeRouter([goodFixDrafts(), goodNarrative()]),
        autoApprove: true,
      });
      const result = await new WorkflowEngine(durableStore).run(workflowFn, {
        runId: "seo_geo_run_engine_list",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
      });
      expect(result.status).toBe("completed");

      const freeze = (await durableStore.listSteps("seo_geo_run_engine_list")).find((step) => step.stepId === "04-freeze-prompt-set");
      const frozen = freeze?.output as { engineListHash?: string } | undefined;
      expect(frozen?.engineListHash).toBe(FROZEN_HASH);
      expect(frozen?.engineListHash).not.toBe(sha256Hex(SEO_GEO_VISIBILITY_ENGINES));
    });

    it("fans out to the captured engines only, and the report states both lists", async () => {
      // The other half of the same plumbing: an adapter-less engine must not
      // appear in a capture cell, and the report must carry the engine list so
      // no renderer has to hardcode a count (which is how karosCMO ended up
      // with an "N of 5 engines" disclosure of its own).
      const durableStore = new MemoryDurableStepStore();
      const workflowFn = createSeoGeoAgentWorkflow({
        tools: withMeasuredCapture(env.tools),
        promptStore: makePromptStore(),
        router: smartFakeRouter([goodFixDrafts(), goodNarrative()]),
        autoApprove: true,
      });
      const result = await new WorkflowEngine(durableStore).run(workflowFn, {
        runId: "seo_geo_run_engine_fanout",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
      });
      expect(result.status).toBe("completed");

      const steps = await durableStore.listSteps("seo_geo_run_engine_fanout");
      const assembled = steps.find((step) => step.stepId === "08-assemble-visibility-cells")?.output as { cells?: Array<{ engine: string }> } | undefined;
      const enginesSeen = [...new Set((assembled?.cells ?? []).map((cell) => cell.engine))].sort();
      expect(enginesSeen.length).toBeGreaterThan(0);
      expect(enginesSeen).toEqual([...SEO_GEO_CAPTURE_ENGINES].sort());
      expect(enginesSeen).not.toContain("aimode");
      expect(enginesSeen).not.toContain("google_aio");

      const report = steps.find((step) => step.stepId === "17-assemble-report")?.output as
        | { engines?: { accepted?: string[]; captured?: string[] } }
        | undefined;
      expect(report?.engines?.accepted).toEqual([...SEO_GEO_VISIBILITY_ENGINES]);
      expect(report?.engines?.captured).toEqual([...SEO_GEO_CAPTURE_ENGINES]);
    });
  });
});
