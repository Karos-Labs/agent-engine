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
   * The literal below is the value agent-engine mints as of 2026-09-20 —
   * `sha256Hex(["chatgpt","perplexity","gemini","claude","copilot","aimode"])`.
   * If this test fails, the captured engine list changed, and that is a
   * deliberate reproducibility bump: every prior run's record stops being
   * comparable, so update the literal only together with a decision record
   * saying why.
   */
  // Six engines since 2026-09-20, when Copilot and AI Mode rejoined the
  // fan-out on real ScrappyCoco routes (SCRUM-396 decision record, "2026-09-20
  // addendum"). Between 2026-09-05 and then it was four
  // (d0c4b2518a6626cf1e17dc75594da7294e12b5c845b1fc0eb4b31917e283e755, "2026-09-05
  // addendum" — Copilot's removal), and before that T-A3's five-engine value
  // (98881508eb5591f3f6b6d8db29bd12496f6e733c66512780e6d85ea3144b88dd). Each
  // frozen record carries the hash live at the moment it was written;
  // `04-freeze-prompt-set` logs every difference as engine-list drift on each
  // client's next recurring run.
  const FROZEN_HASH = "6e7db9fa6e1d9d4e8f127ce284ef6573af9d2943f5667bb6bdf56554cf01ba99";

  it("hashes the six captured engines — Copilot and AI Mode's 2026-09-20 real routes are the only change since 2026-09-05", () => {
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
      expect(enginesSeen).toContain("copilot");
      expect(enginesSeen).toContain("aimode");
      expect(enginesSeen).not.toContain("google_aio");

      const report = steps.find((step) => step.stepId === "17-assemble-report")?.output as
        | { engines?: { accepted?: string[]; captured?: string[] } }
        | undefined;
      expect(report?.engines?.accepted).toEqual([...SEO_GEO_VISIBILITY_ENGINES]);
      expect(report?.engines?.captured).toEqual([...SEO_GEO_CAPTURE_ENGINES]);
    });
  });
});
