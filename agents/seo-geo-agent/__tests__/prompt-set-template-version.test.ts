import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { PROMPT_TEMPLATE_VERSION, deriveDefaultPromptSet, sha256Hex } from "../src/workflow/prompt-set.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

type PromptSetOut = { source: string; prompts: Array<{ promptText: string; intentType: string }> };
type Deliverable = { deliverable: { promptSet: PromptSetOut } };

/**
 * The 2026-09-05 defect, from prep. Every client that had ever run seo-geo
 * kept reporting 0% named mentions after the `brand` templates were fixed to
 * name the client, because RFC-04 §3's recurring-run reuse handed step 02 the
 * OLD frozen set — 25 prompts, none naming the brand — and the drift logic in
 * step 04 had nothing to log, since the reused set was byte-identical to the
 * prior one. The reuse rule was preserving the bug it sat in front of.
 *
 * These tests pin the fix: a frozen record from older templates is redrafted,
 * that redraft is logged as drift WITH its reason, and a frozen record from the
 * current templates is still reused exactly as RFC-04 intends.
 */
describe("prompt-set template versioning (RFC-04 §3 reuse, bounded by the templates it protects)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  async function run(runId: string, runKind: "setup" | "recurring") {
    const workflow = createSeoGeoAgentWorkflow({
      tools: withMeasuredCapture(env.tools),
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodFixDrafts(), goodNarrative()]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, { ...baseParams, runId, runKind });
    expect(result.status).toBe("completed");
    const deliverable = await env.store.readJson<Deliverable>("acme", ["ledger", "deliverables", runId, "_", "seo-geo-report"]);
    return deliverable!.deliverable.promptSet;
  }

  /** A frozen record exactly as a run from BEFORE templates were versioned would have left it: v1 prompts, no `templateVersion`. */
  async function seedStaleFrozenSet() {
    const stale = deriveDefaultPromptSet("B2B SaaS", "en", "Acme Corp");
    const stalePrompts = stale.prompts.map((p) =>
      p.intentType === "brand" ? { ...p, promptText: p.promptText.replaceAll("Acme Corp", "the brand") } : p,
    );
    // Sanity on the premise: v1-style prompts (no brand name given) never name the client.
    expect(stalePrompts.some((p) => p.promptText.includes("Acme Corp"))).toBe(false);
    await env.store.writeJson("acme", ["memory", "beliefs"], {
      seoGeoFrozenPromptSet: {
        prompts: stalePrompts,
        competitorRoster: ["Rivalco"],
        promptSetHash: sha256Hex({ prompts: stalePrompts, language: "en" }),
        language: "en",
        languageFallbackApplied: false,
        quotaShortfalls: [],
        frozenAt: "2026-08-20T00:00:00.000Z",
      },
    });
    return sha256Hex({ prompts: stalePrompts, language: "en" });
  }

  it("redrafts on a recurring run when the frozen set predates the current templates", async () => {
    await seedStaleFrozenSet();

    const promptSet = await run("seo_geo_run_stale_templates", "recurring");

    expect(promptSet.source).toBe("drafted");
    // The whole point: the brand prompts now actually name the brand.
    const brandPrompts = promptSet.prompts.filter((p) => p.intentType === "brand");
    expect(brandPrompts.length).toBeGreaterThan(0);
    expect(brandPrompts.every((p) => p.promptText.includes("Acme Corp"))).toBe(true);
  });

  it("logs the redraft as prompt-set drift and says why", async () => {
    await seedStaleFrozenSet();
    const runId = "seo_geo_run_stale_templates_drift";
    await run(runId, "recurring");

    // Matched on content, not on the list's wrapper shape: what this pins is
    // that a reader of the decision log sees the reason, whatever the store
    // wraps each row in.
    const decisions = await env.store.listJson<unknown>("acme", ["memory", "products", "seo-geo-agent", "decisions"]);
    const serialised = decisions.map((d) => JSON.stringify(d));
    expect(serialised.some((d) => d.includes(`${runId}__prompt_set_drift`))).toBe(true);
    expect(serialised.some((d) => d.includes(`templates moved to v${PROMPT_TEMPLATE_VERSION}`))).toBe(true);
  });

  it("stamps the frozen record with the template version so the next run can trust it", async () => {
    await run("seo_geo_run_stamp", "setup");
    const beliefs = await env.store.readJson<{ seoGeoFrozenPromptSet: { templateVersion?: number } }>("acme", ["memory", "beliefs"]);
    expect(beliefs?.seoGeoFrozenPromptSet.templateVersion).toBe(PROMPT_TEMPLATE_VERSION);
  });

  it("still reuses a frozen set from the current templates — RFC-04 §3 is intact", async () => {
    // Guards the other direction: the fix must not turn every recurring run
    // into a redraft, or trend comparability is gone for good.
    const first = await run("seo_geo_run_current_baseline", "setup");
    expect(first.source).toBe("drafted");

    const second = await run("seo_geo_run_current_recurring", "recurring");
    expect(second.source).toBe("reused");
    expect(second.prompts).toEqual(first.prompts);
  });
});
