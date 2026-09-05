import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { success, notAvailable } from "@agent-engine/tool-common";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import { runReputationRosterSetup } from "../src/workflow/roster-setup.js";
import {
  doctrineOutput,
  draftOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  tagOutput,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * `00-roster-setup` — the pre-flight that replaced "run the setup skill first".
 *
 * Each case pins one of the three paths (`already-configured` / `recorded` /
 * `not-supplied`) or one resolution rule from roster-setup.ts's header: an App
 * Store URL resolves on its own, Google resolves only through the owned
 * account, everything else is skipped WITH its reason. The last two cases run
 * the whole pulse, because the point of the pre-flight is what happens to the
 * client's first run: it completes against a roster it recorded itself, or it
 * refuses at step 03 quoting the cause.
 */

const CTX: AgentContext = { runId: "run_roster_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring", metadata: {} };

function args(env: TestEnvironment, input: Record<string, unknown>, tools: AgentToolRegistry = env.tools) {
  return { tools, ctx: { ...CTX, clientSlug: env.clientSlug }, runId: CTX.runId, clientSlug: env.clientSlug, input };
}

async function readConfig(env: TestEnvironment): Promise<Record<string, unknown>> {
  return (await env.store.readJson<Record<string, unknown>>(env.clientSlug, ["client", "config"])) ?? {};
}

describe("00-roster-setup: runReputationRosterSetup", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("is a single config read for a client whose roster is on file, and writes nothing", async () => {
    const roster = [manualExportLeg([], { listingId: "loc-1", listingLabel: "Main" })];
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: roster, xHandle: "acme" });

    const outcome = await runReputationRosterSetup(args(env, { reviewSurfaces: ["https://apps.apple.com/us/app/acme/id111111111"] }));

    expect(outcome).toMatchObject({ status: "already-configured", legCount: 1, written: [] });
    expect(outcome.note).toMatch(/already has a reputation roster on file \(1 listing\)/);
    // The seed on the run was NOT folded in: a standing roster is a decision.
    const config = await readConfig(env);
    expect(config["reputationRoster"]).toEqual(roster);
    expect(config["reputationSetup"]).toBeUndefined();
  });

  it("leaves a roster that is on file but does not parse alone, and says so", async () => {
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [{ leg: "gbp", listingId: "x" }] as never });
    const outcome = await runReputationRosterSetup(args(env, { reviewSurfaces: ["https://apps.apple.com/us/app/acme/id111111111"] }));
    expect(outcome.status).toBe("already-configured");
    expect(outcome.note).toMatch(/does not parse, so setup left it alone/);
    expect((await readConfig(env))["reputationSetup"]).toBeUndefined();
  });

  it("records a structured roster supplied on the run, plus the never-say locks and the intake as provenance", async () => {
    // Written directly rather than through the helper, whose default is an EMPTY
    // lock list: an empty list on file is a decision setup must not overwrite.
    await env.store.writeJson(env.clientSlug, ["client", "config"], { reputationAutonomy: "approve-all", xHandle: "acme" });
    const roster = [manualExportLeg([], { listingId: "loc-1", listingLabel: "Main" })];

    const outcome = await runReputationRosterSetup(
      args(env, {
        reputationRoster: roster,
        responseNoGos: ["we will refund you", "our staff were wrong"],
        reviewMarkets: "Springfield\nRiverside",
        crisisRoutingTag: "ops@acme.example",
        reputationContext: "Ownership changed in June.",
      }),
    );

    expect(outcome).toMatchObject({
      status: "recorded",
      legCount: 1,
      written: ["client/config#reputationRoster", "client/config#reputationLocks", "client/config#reputationSetup"],
      resolvedFrom: ["1 listing(s) supplied on the run as reputationRoster"],
      skipped: [],
    });
    const config = await readConfig(env);
    expect(config).toMatchObject({
      xHandle: "acme",
      reputationRoster: roster,
      reputationLocks: { neverSay: ["we will refund you", "our staff were wrong"], requiredFramingAnyOf: [] },
    });
    expect(config["reputationSetup"]).toMatchObject({
      seeds: [],
      markets: ["Springfield", "Riverside"],
      crisisRouting: "ops@acme.example",
      context: "Ownership changed in June.",
      runId: CTX.runId,
    });
  });

  it("resolves an App Store URL to an appstore leg by itself, and skips the surfaces it cannot read with the reason", async () => {
    await writeClientConfig(env.store, env.clientSlug, {});
    const outcome = await runReputationRosterSetup(
      args(env, {
        reviewSurfaces: ["https://apps.apple.com/gb/app/acme-coffee/id123456789", "Yelp", "App Store", "our newsletter"],
      }),
    );

    expect(outcome.status).toBe("recorded");
    expect(outcome.legCount).toBe(1);
    expect(outcome.skipped).toEqual([
      { seed: "Yelp", reason: expect.stringMatching(/no capture adapter exists for this surface yet/) },
      { seed: "App Store", reason: expect.stringMatching(/needs the app's URL/) },
      { seed: "our newsletter", reason: "not a review surface this agent can read" },
    ]);
    const config = await readConfig(env);
    expect(config["reputationRoster"]).toEqual([
      { leg: "appstore", listingId: "appstore:123456789", listingLabel: "acme coffee (App Store)", inRoster: true, appId: "123456789", country: "gb", maxPages: 10 },
    ]);
    expect(outcome.note).toMatch(/could not resolve: Yelp/);
  });

  it("refuses to resolve a Google surface without an owned account id, and names the missing field", async () => {
    await writeClientConfig(env.store, env.clientSlug, {});
    const outcome = await runReputationRosterSetup(args(env, { reviewSurfaces: "Google" }));

    expect(outcome).toMatchObject({ status: "not-supplied", legCount: 0, written: [] });
    expect(outcome.skipped).toEqual([{ seed: "Google", reason: expect.stringMatching(/no Google Business Profile account id on file \(client config gbpAccountId\)/) }]);
    expect(outcome.note).toMatch(/none of the named surfaces resolved to a listing: Google/);
    expect((await readConfig(env))["reputationRoster"]).toEqual([]);
  });

  it("resolves a Google surface through the owned account's locations, one gbp leg per location", async () => {
    await writeClientConfig(env.store, env.clientSlug, { gbpAccountId: "accounts/acct-1" });
    const discover = vi.fn(async () =>
      success({
        account: "acct-1",
        locations: [
          { location: "loc-1", title: "Acme Cafe", address: "1 Main St, Springfield" },
          { location: "loc-2", title: "Acme Cafe Riverside" },
        ],
      }),
    );
    const tools: AgentToolRegistry = {
      ...env.tools,
      "reputation.discoverGbpLocations": { ...env.tools["reputation.discoverGbpLocations"]!, execute: discover } as never,
    };

    const outcome = await runReputationRosterSetup(args(env, { reviewSurfaces: ["Google Business Profile"] }, tools));

    expect(discover).toHaveBeenCalledWith({ account: "accounts/acct-1" }, expect.anything());
    expect(outcome).toMatchObject({ status: "recorded", legCount: 2, skipped: [] });
    expect(outcome.resolvedFrom).toEqual(['Google Business Profile account "acct-1" → 2 location(s)']);
    expect((await readConfig(env))["reputationRoster"]).toEqual([
      { leg: "gbp", listingId: "gbp:loc-1", listingLabel: "Acme Cafe — 1 Main St, Springfield", inRoster: true, account: "acct-1", location: "loc-1" },
      { leg: "gbp", listingId: "gbp:loc-2", listingLabel: "Acme Cafe Riverside", inRoster: true, account: "acct-1", location: "loc-2" },
    ]);
  });

  it("carries the discovery tool's own reason when the owned account cannot be enumerated", async () => {
    await writeClientConfig(env.store, env.clientSlug, { gbpAccountId: "acct-1" });
    const tools: AgentToolRegistry = {
      ...env.tools,
      "reputation.discoverGbpLocations": {
        ...env.tools["reputation.discoverGbpLocations"]!,
        execute: async () => notAvailable("missing env GOOGLE_BUSINESS_TOKEN — the Google Business Profile listings cannot be enumerated"),
      } as never,
    };
    const outcome = await runReputationRosterSetup(args(env, { reviewSurfaces: ["google"] }, tools));
    expect(outcome.status).toBe("not-supplied");
    expect(outcome.skipped).toEqual([{ seed: "google", reason: expect.stringMatching(/GOOGLE_BUSINESS_TOKEN/) }]);
  });

  it("says what it needs when the run carried nothing at all", async () => {
    await writeClientConfig(env.store, env.clientSlug, {});
    const outcome = await runReputationRosterSetup(args(env, {}));
    expect(outcome.status).toBe("not-supplied");
    expect(outcome.note).toMatch(/named no review surfaces — the reputation intake's "where people review you" is what this resolves from/);
  });
});

describe("00-roster-setup inside the pulse", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const params = { runId: "pulse_roster_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

  it("a first run with no roster on file completes against the roster it recorded, and the next run finds it already configured", async () => {
    // No lock list on file either (the helper's default is an empty one), so the
    // run's never-say list is recorded rather than deferred to a standing decision.
    await env.store.writeJson(env.clientSlug, ["client", "config"], { reputationAutonomy: "approve-all" });
    const respondId = "manual:loc-1:rev-1";
    const review = makeReview({
      review_id: respondId,
      rating: 3,
      text: "The wait was long but the staff tried to help sort it out.",
      annotations: {
        classifier_model_id: "fixture",
        sentiment: "neg",
        factual_error: false,
        fixable_complaint: true,
        detailed_positive: false,
        service_recovery_opportunity: true,
      },
    });
    const draft = "Thank you for sharing this. Please reach out to us directly so we can follow up.";
    const router = smartFakeRouter([tagOutput([]), draftOutput(draft), voicePassOutput([respondId]), doctrineOutput()]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, store: env.store, autoApprove: true });

    const first = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      input: { reputationRoster: [manualExportLeg([review])], responseNoGos: ["free"] },
    });
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("unreachable");
    expect(first.output.rosterSetup).toBe("recorded");
    expect(first.output.captureLegs).toHaveLength(1);

    const config = await readConfig(env);
    expect(config["reputationRoster"]).toHaveLength(1);
    expect(config["reputationLocks"]).toEqual({ neverSay: ["free"], requiredFramingAnyOf: [] });

    const second = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "pulse_roster_2" });
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("unreachable");
    expect(second.output.rosterSetup).toBe("already-configured");
  });

  it("still refuses at step 03 when nothing resolved, and the refusal quotes the setup note", async () => {
    await writeClientConfig(env.store, env.clientSlug, {});
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: smartFakeRouter([]), store: env.store, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, input: { reviewSurfaces: ["Google", "Trustpilot"] } });
    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/no reputation capture legs are configured/);
    expect(result.reason).toMatch(/Setup: no roster on file and none of the named surfaces resolved to a listing: /);
    expect(result.reason).toMatch(/Google \(no Google Business Profile account id on file/);
    expect(result.reason).toMatch(/Trustpilot \(no capture adapter exists/);
  });
});
