import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import { editionRouter, finalTurn, heldEditionRouter, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * Migration-audit remediation: the Newsletter agent previously had no
 * structural compliance surface at all — no locked disclaimer/footer, no
 * unsubscribe link, and no banned promise/hype-language gate. These tests
 * exercise the fix end to end, through the real 20-step workflow:
 *  (a) the always-on banned promise/hype-language bank inside
 *      `gate.brandCompliance` actually holds a draft that contains one,
 *  (b) that same scan runs on the model's authored text only, before the
 *      platform's compliance footer is injected -- so a client's own
 *      legitimately-configured disclaimer never trips the gate it exists to
 *      satisfy (Phase 2.5's fix for the self-tripping bug),
 *  (c) `client.brand`'s `requiredDisclaimer`/`companyAddress`/`unsubscribeUrl`
 *      are force-injected by the platform, never the model's own text, and
 *      structurally verified at step 12,
 *  (d) the footer/disclaimer/unsubscribe fields, once a client configures
 *      them, genuinely land in the persisted deliverable, not just the
 *      schema.
 */

const baseParams = { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

function draftWithIntro(intro: string) {
  return {
    subjectLine: "A reasonable subject line",
    previewText: "A reasonable preview text.",
    intro,
    sections: [{ heading: "A heading", body: "A body." }],
    callToAction: { text: "Do something", url: "https://example.com" },
    signoff: "The Acme Team",
    text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Acme Team`,
  };
}

describe("compliance footer + banned promise/hype-language remediation (RFC-02 §5)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('a banned promise/hype phrase ("guaranteed returns") fails gate.brandCompliance at step 10 -> redrafted twice, then held, even with no forbiddenTerms configured', async () => {
    // Empty (but present) brand config -- isolates the always-on hype bank from the
    // client's own forbiddenTerms, which setupTestEnvironment's default brand includes.
    await env.store.writeJson("acme", ["client", "brand"], {});

    const promptStore = makePromptStore();
    const intro = "This strategy delivers guaranteed returns for every single subscriber.";
    const router = heldEditionRouter([finalTurn(draftWithIntro(intro))]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_hype_language" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);
    expect(result.reason).toMatch(/guaranteed returns/i);

    const stepRecords = await durableStore.listSteps("newsletter_run_hype_language");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("10-verify-brand-compliance");
    expect(ids).toContain("09-draft-post-round-3");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "newsletter_run_hype_language", "_"]);
    expect(deliverables).toHaveLength(0);
  });

  it("a client-specific forbiddenTerm and the built-in hype bank both still apply on top of each other", async () => {
    // Default brand config (forbiddenTerms: ["guaranteed", "the best", "#1"]) plus a draft
    // that only trips the built-in "risk-free" hype phrase, not any client-configured term.
    const promptStore = makePromptStore();
    const intro = "Here's a completely risk-free way to plan your next sprint.";
    const router = heldEditionRouter([finalTurn(draftWithIntro(intro))]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_hype_language_2" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);
    expect(result.reason).toMatch(/risk-free/i);
  });

  it("gate.brandCompliance's hype scan never receives requiredDisclaimer or footer text (Phase 2.5 fix), yet the disclaimer is still verified and persisted", async () => {
    const requiredDisclaimer = "Acme Corp is not a registered investment advisor.";
    await env.store.writeJson("acme", ["client", "brand"], {
      forbiddenTerms: ["guaranteed", "the best", "#1"],
      requiredDisclaimer,
    });

    const promptStore = makePromptStore();
    const intro = "Here's what actually worked for engineering teams this week.";
    const draft = draftWithIntro(intro);
    const router = editionRouter([finalTurn(draft)]);

    // Spy on gate.brandCompliance specifically to capture the exact args the workflow sends it.
    const brandComplianceSpy = vi.fn(env.tools["gate.brandCompliance"]!.execute.bind(env.tools["gate.brandCompliance"]));
    const tools: AgentToolRegistry = {
      ...env.tools,
      "gate.brandCompliance": { ...env.tools["gate.brandCompliance"]!, execute: brandComplianceSpy } as AgentToolRegistry[string],
    };

    const workflowFn = createNewsletterAgentWorkflow({ tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_disclaimer_enforced" });

    expect(result.status).toBe("completed");
    expect(brandComplianceSpy).toHaveBeenCalledTimes(1);
    const callArgs = brandComplianceSpy.mock.calls[0]![0] as { requiredDisclaimer?: string; text: string };
    // The hype scan runs on the model's authored text only, before the footer exists --
    // it never receives requiredDisclaimer and never sees the footer text at all.
    expect(callArgs.requiredDisclaimer).toBeUndefined();
    expect(callArgs.text).toBe(draft.text);
    expect(callArgs.text).not.toContain(requiredDisclaimer);

    // The model's own draft never wrote the disclaimer -- only the platform's injected footer did.
    expect(intro).not.toContain("registered investment advisor");

    // The disclaimer still lands in the final persisted deliverable, verified
    // structurally at step 12 rather than by re-running the hype scan against it.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "newsletter_run_disclaimer_enforced", "_"]);
    expect(deliverables).toHaveLength(1);
    const persisted = deliverables[0]!.data as { deliverable: { text: string; footerDisclaimer?: string } };
    expect(persisted.deliverable.footerDisclaimer).toBe(requiredDisclaimer);
    expect(persisted.deliverable.text).toContain(requiredDisclaimer);
  });

  it("a disclaimer that legitimately contains a hype-bank phrase does not trip gate.brandCompliance (the self-tripping bug this batch fixes)", async () => {
    const requiredDisclaimer = "This newsletter does not offer guaranteed returns or risk-free investment advice.";
    await env.store.writeJson("acme", ["client", "brand"], { forbiddenTerms: [], requiredDisclaimer });

    const promptStore = makePromptStore();
    const intro = "Here's what actually worked for engineering teams this week.";
    const router = editionRouter([finalTurn(draftWithIntro(intro))]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_disclaimer_hype_overlap" });

    // Before the fix, this held: the hype scan ran on the composed (footer-included)
    // text and "guaranteed returns"/"risk-free" inside the client's OWN disclaimer
    // tripped the very gate the disclaimer exists to satisfy.
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "newsletter_run_disclaimer_hype_overlap", "_"]);
    expect(deliverables).toHaveLength(1);
    const persisted = deliverables[0]!.data as { deliverable: { footerDisclaimer?: string; text: string } };
    expect(persisted.deliverable.footerDisclaimer).toBe(requiredDisclaimer);
    expect(persisted.deliverable.text).toContain(requiredDisclaimer);
  });

  it("footerDisclaimer, companyAddress, and unsubscribeUrl all survive into the persisted deliverable when the client configures them, without the model ever authoring them", async () => {
    // Deliberately avoids the word "guaranteed" — this client's own forbiddenTerms list
    // includes it, and a disclaimer that happened to contain it would trip gate.brandCompliance
    // for an unrelated reason, muddying what this test is actually meant to prove.
    const requiredDisclaimer = "Investment outcomes vary and past performance does not indicate future results.";
    const companyAddress = "123 Market St, Suite 400, San Francisco, CA 94105";
    const unsubscribeUrl = "https://acme.example.com/unsubscribe?id=abc123";
    await env.store.writeJson("acme", ["client", "brand"], {
      forbiddenTerms: ["guaranteed", "the best", "#1"],
      requiredDisclaimer,
      companyAddress,
      unsubscribeUrl,
    });

    const promptStore = makePromptStore();
    const intro = "Here's what actually worked for engineering teams this week.";
    const router = editionRouter([finalTurn(draftWithIntro(intro))]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_full_footer" });

    expect(result.status).toBe("completed");

    // The model's own draft never authored any of the three compliance fields.
    const draftedOutput = draftWithIntro(intro);
    expect(draftedOutput).not.toHaveProperty("footerDisclaimer");
    expect(draftedOutput).not.toHaveProperty("companyAddress");
    expect(draftedOutput).not.toHaveProperty("unsubscribeUrl");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "newsletter_run_full_footer", "_"]);
    expect(deliverables).toHaveLength(1);
    const persisted = deliverables[0]!.data as {
      deliverable: { text: string; footerDisclaimer?: string; companyAddress?: string; unsubscribeUrl?: string };
    };
    expect(persisted.deliverable.footerDisclaimer).toBe(requiredDisclaimer);
    expect(persisted.deliverable.companyAddress).toBe(companyAddress);
    expect(persisted.deliverable.unsubscribeUrl).toBe(unsubscribeUrl);
    expect(persisted.deliverable.text).toContain(requiredDisclaimer);
    expect(persisted.deliverable.text).toContain(companyAddress);
    expect(persisted.deliverable.text).toContain(unsubscribeUrl);
  });

  it("a client with no compliance footer configured at all gets a deliverable with no footer fields and an unmodified text (backward compatible)", async () => {
    // setupTestEnvironment's default brand has forbiddenTerms only -- no requiredDisclaimer,
    // companyAddress, or unsubscribeUrl.
    const promptStore = makePromptStore();
    const intro = "Here's what actually worked for engineering teams this week.";
    const draft = draftWithIntro(intro);
    const router = editionRouter([finalTurn(draft)]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_no_footer" });

    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "newsletter_run_no_footer", "_"]);
    expect(deliverables).toHaveLength(1);
    const persisted = deliverables[0]!.data as {
      deliverable: { text: string; footerDisclaimer?: string; companyAddress?: string; unsubscribeUrl?: string };
    };
    expect(persisted.deliverable.footerDisclaimer).toBeUndefined();
    expect(persisted.deliverable.companyAddress).toBeUndefined();
    expect(persisted.deliverable.unsubscribeUrl).toBeUndefined();
    expect(persisted.deliverable.text).toBe(draft.text);
  });
});
