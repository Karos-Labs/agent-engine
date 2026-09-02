import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * THE TWO RESEARCH AGENTS RUN UNATTENDED; EVERY OTHER AGENT STILL GATES.
 *
 * `seo-geo-agent` and `intel-report-agent` produce intelligence the portal
 * reads back — `intel-report-agent`'s deliverable IS the portal's
 * `ClientReport` — rather than content a human publishes under a client's
 * name. There is nothing in either for an account manager to approve, and
 * `intel-report-agent`'s gate in particular had no auto-approve at all
 * (`24h`/`hold`), so an unattended run could only ever end at the portal's own
 * 70-minute deliverable timeout.
 *
 * `buildWorkflowForProduct` is where that decision lives, and it is a
 * one-word-per-arm decision in a fourteen-arm switch: exactly the kind of thing
 * a later refactor drops without anyone noticing, because nothing fails — runs
 * simply start sitting at `awaiting_gate` again. Hence a test on the wiring
 * itself rather than on either agent, neither of whose suites reaches this
 * function.
 *
 * The control arms matter as much as the two positive ones. `autoApprove` is a
 * PER-PRODUCT decision; a change that turned it on globally would satisfy the
 * first assertion and be badly wrong.
 */

const captured: Record<string, Record<string, unknown>> = {};

/** Records the options one product's factory was constructed with. */
function spy(name: string) {
  return (options: Record<string, unknown>) => {
    captured[name] = options;
    return () => Promise.resolve(undefined);
  };
}

vi.mock("@agent-engine/agent-seo-geo", () => ({ createSeoGeoAgentWorkflow: spy("seo-geo-agent") }));
vi.mock("@agent-engine/agent-intel-report", () => ({ createIntelReportAgentWorkflow: spy("intel-report-agent") }));
vi.mock("@agent-engine/agent-blog", () => ({ createBlogAgentWorkflow: spy("blog-agent") }));
vi.mock("@agent-engine/agent-reputation", () => ({ createReputationPulseWorkflow: spy("reputation-agent") }));

const { buildWorkflowForProduct } = await import("../src/wiring/workflows.js");

// The factories are mocked, so nothing reads these; the cast keeps the test
// about the switch rather than about assembling a real runtime.
const DEPS = { tools: {}, promptStore: {}, router: {}, workspaceStore: {} } as never;

beforeEach(() => {
  for (const key of Object.keys(captured)) delete captured[key];
});

describe("buildWorkflowForProduct — unattended research agents", () => {
  it.each(["seo-geo-agent", "intel-report-agent"] as const)("builds %s with autoApprove", (productId) => {
    buildWorkflowForProduct(productId, DEPS);
    expect(captured[productId]?.autoApprove).toBe(true);
  });

  it.each(["blog-agent", "reputation-agent"] as const)("leaves %s gated", (productId) => {
    buildWorkflowForProduct(productId, DEPS);
    // Absent, not `false`: every agent's own option defaults to off, and the
    // wiring says nothing about products it has made no decision for.
    expect(captured[productId]?.autoApprove).toBeUndefined();
  });

  it("passes the runtime deps through rather than replacing them", () => {
    // `{ ...deps, autoApprove: true }` is easy to write as `{ autoApprove: true }`.
    buildWorkflowForProduct("intel-report-agent", DEPS);
    expect(captured["intel-report-agent"]).toMatchObject({
      tools: expect.anything(),
      promptStore: expect.anything(),
      router: expect.anything(),
    });
  });
});
