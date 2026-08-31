import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-241 (T-A9). intel-report-agent already called `client.getBrand`
 * before this ticket, but never `client.getContextDoc` — the report's own
 * craft guide even carried a standing "Known gap... no field in this schema
 * yet" note about the client's target audience never reaching this prompt
 * at all. Two separate doc types, `target-audience` and `market-strategy`,
 * each threaded in as its own named field (01c/01d) — this file has one
 * test per doc type, each proving the draft step's actual generated prompt
 * changes when that ONE document's content varies, independent of the
 * other.
 */
const params = { runId: "intel_run_grounding", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

function goodReportRouter() {
  return fakeRouterSequence([finalTurn(goodIntelReport())]);
}

describe("intel-report-agent grounding: target-audience and market-strategy (SCRUM-241/T-A9)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reads the client's projected target-audience doc and the draft step's actual prompt changes when its content varies", async () => {
    await env.store.writeJson("acme", ["context", "target-audience"], {
      markdown: "Primary ICP: price-sensitive solo-founder SMBs who churn fast on support friction.",
    });

    const routerA = goodReportRouter();
    const workflowFnA = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerA, autoApprove: true });
    const durableStoreA = new MemoryDurableStepStore();
    const resultA = await new WorkflowEngine(durableStoreA).run(workflowFnA, params);
    expect(resultA.status).toBe("completed");

    const stepA = await durableStoreA.getStep(params.runId, "01c-load-target-audience");
    expect(stepA?.output).toBe("Primary ICP: price-sensitive solo-founder SMBs who churn fast on support friction.");

    const promptA = (routerA.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(promptA).toContain("price-sensitive solo-founder SMBs");

    // A second, fresh run with DIFFERENT target-audience content, market-strategy
    // held constant (absent in both) — proving the prompt tracks THIS document's
    // content specifically, not a hardcoded string or a different field.
    await env.cleanup();
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["context", "target-audience"], {
      markdown: "Primary ICP: enterprise buyers who select on compliance certifications, not price.",
    });
    const routerB = goodReportRouter();
    const workflowFnB = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerB, autoApprove: true });
    const durableStoreB = new MemoryDurableStepStore();
    const resultB = await new WorkflowEngine(durableStoreB).run(workflowFnB, params);
    expect(resultB.status).toBe("completed");

    const promptB = (routerB.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(promptB).toContain("enterprise buyers who select on compliance");
    expect(promptB).not.toContain("price-sensitive solo-founder SMBs");
    expect(promptA).not.toContain("enterprise buyers who select on compliance");
  });

  it("reads the client's projected market-strategy doc and the draft step's actual prompt changes when its content varies", async () => {
    await env.store.writeJson("acme", ["context", "market-strategy"], {
      markdown: "Client is deliberately playing the premium/high-touch lane, not competing on price.",
    });

    const routerA = goodReportRouter();
    const workflowFnA = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerA, autoApprove: true });
    const durableStoreA = new MemoryDurableStepStore();
    const resultA = await new WorkflowEngine(durableStoreA).run(workflowFnA, params);
    expect(resultA.status).toBe("completed");

    const stepA = await durableStoreA.getStep(params.runId, "01d-load-market-strategy");
    expect(stepA?.output).toBe("Client is deliberately playing the premium/high-touch lane, not competing on price.");

    const promptA = (routerA.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(promptA).toContain("premium/high-touch lane");

    await env.cleanup();
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["context", "market-strategy"], {
      markdown: "Client is running a land-and-expand self-serve motion, undercutting on entry price.",
    });
    const routerB = goodReportRouter();
    const workflowFnB = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerB, autoApprove: true });
    const durableStoreB = new MemoryDurableStepStore();
    const resultB = await new WorkflowEngine(durableStoreB).run(workflowFnB, params);
    expect(resultB.status).toBe("completed");

    const promptB = (routerB.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(promptB).toContain("land-and-expand self-serve motion");
    expect(promptB).not.toContain("premium/high-touch lane");
    expect(promptA).not.toContain("land-and-expand self-serve motion");
  });

  // SCRUM-242 (T-A10) superseded this case's old title and assertions
  // ("completes normally ... never blocking") — that was T-A9's own,
  // explicitly temporary behavior, called out in Batch 5's own doc: "a run
  // with every context doc absent still completes (T-A10 is what changes
  // that, not this ticket)." intel-report-agent's row in the shared
  // CONTEXT_DOC_POLICY table is BLOCK, so a run with BOTH docs absent now
  // resolves to `blocked_intake` before ever drafting — see
  // `context-doc-policy-fixture.test.ts` for the required cross-agent
  // assertion of this same behavior.
  it("BLOCKs (blocked_intake) when neither context doc has been projected for this client (SCRUM-242/T-A10)", async () => {
    // `beforeEach`'s env carries the default (present) fixtures `setupTestEnvironment()`
    // writes for every OTHER test in this repo — replace it with the true-absence
    // variant so both client.getContextDoc calls genuinely report not_available.
    await env.cleanup();
    env = await setupTestEnvironment({ withContextDocs: false });
    const router = goodReportRouter();
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(result.status === "blocked_intake" ? result.reason : undefined).toContain("missing required context doc(s) [target-audience, market-strategy]");

    const audienceStep = await durableStore.getStep(params.runId, "01c-load-target-audience");
    const strategyStep = await durableStore.getStep(params.runId, "01d-load-market-strategy");
    expect(audienceStep?.output).toBeNull();
    expect(strategyStep?.output).toBeNull();

    // Blocked before ever drafting — the model is never called, so no cost is
    // spent generating a report nobody should have gotten.
    expect(router.complete).not.toHaveBeenCalled();
  });
});
