import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * Where this agent's competitor roster comes from.
 *
 * Two different files were involved, and they never met. `client.listCompetitors`
 * reads `client/competitors` — the tenant's hand-curated onboarding list — while
 * `intel.writeReport` writes `intel/competitors`, the roster the Intel Report
 * discovered. Nothing in this repo writes the former except tests, so a client
 * who never hand-entered competitors had an empty roster forever, and every
 * competitor metric this agent produces was structurally zero however well the
 * capture itself worked.
 *
 * Waiting for a running Intel Report would not have fixed it. The write path
 * and the read path did not meet, so no amount of ordering would have delivered
 * the data — which is why this is a read, not a synchronisation.
 */
describe("competitor roster source", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env?.cleanup();
  });

  /**
   * Seeds an Intel Report the way a real run leaves one: the roster lives in
   * `intel/competitors`, but `intel.getReport` only surfaces it alongside a
   * stored report. The workflow reads through that tool rather than opening
   * another package's files directly, so the fixture has to write both.
   */
  async function seedIntelReport(competitors: Array<Record<string, unknown>>) {
    await env.store.writeJson("acme", ["intel", "report"], { clientId: "acme", reportDate: "2026-09-04", overallScore: 64 });
    await env.store.writeJson("acme", ["intel", "competitors"], competitors);
  }

  /** Runs far enough to checkpoint `01-load-client-context`, then reads it back. */
  async function loadContext(runId: string) {
    const workflowFn = createSeoGeoAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: fakeRouterSequence([finalTurn({}), finalTurn({}), finalTurn({})]),
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId });
    const step = await durableStore.getStep(runId, "01-load-client-context");
    return step?.output as { competitors: Array<{ name: string }>; competitorRosterSource: string } | undefined;
  }

  it("prefers the client's hand-curated list when there is one", async () => {
    // A human who typed a competitor list meant it; an agent's discovery must
    // not silently overrule it.
    env = await setupTestEnvironment();
    await seedIntelReport([{ company: "Discovered Co" }]);

    const context = await loadContext("seo_roster_curated");

    expect(context?.competitorRosterSource).toBe("client-curated");
    expect(context?.competitors.map((c) => c.name)).toEqual(["Rivalco"]);
  });

  it("falls back to the Intel Report's roster when the client curated none", async () => {
    // The real Karos Labs case: no curated list, a real Intel Report roster
    // sitting in a file this agent never opened.
    env = await setupTestEnvironment({ withCompetitors: false });
    await seedIntelReport([{ company: "Discovered Co" }, { company: "Second Rival" }]);

    const context = await loadContext("seo_roster_intel");

    expect(context?.competitorRosterSource).toBe("intel-report");
    expect(context?.competitors.map((c) => c.name)).toEqual(["Discovered Co", "Second Rival"]);
  });

  it("reports 'none' when neither source has anything, rather than a silent empty roster", async () => {
    // An empty roster makes every competitor metric zero, which is
    // indistinguishable from "no competitor was mentioned". Those mean
    // opposite things and a client sees the same number for both, so the run
    // record has to say which one happened.
    env = await setupTestEnvironment({ withCompetitors: false });

    const context = await loadContext("seo_roster_none");

    expect(context?.competitorRosterSource).toBe("none");
    expect(context?.competitors).toEqual([]);
  });

  it("drops Intel rows carrying no company name instead of adding blanks to the roster", async () => {
    env = await setupTestEnvironment({ withCompetitors: false });
    await seedIntelReport([{ company: "  " }, { url: "https://nameless.example" }, { company: "Real Co" }]);

    const context = await loadContext("seo_roster_blanks");

    expect(context?.competitorRosterSource).toBe("intel-report");
    expect(context?.competitors.map((c) => c.name)).toEqual(["Real Co"]);
  });
});
