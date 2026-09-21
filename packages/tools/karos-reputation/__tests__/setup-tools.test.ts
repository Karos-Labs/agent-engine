import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createSaveRoster } from "../src/setup/save-roster-tool.js";
import type { CaptureLegRequest } from "../src/capture/types.js";

const ctx = { runId: "run_setup_1", clientSlug: "acme", productId: "reputation-agent", runKind: "recurring" as const, metadata: {} };

const SAMPLE_LEG: CaptureLegRequest = {
  leg: "appstore",
  listingId: "appstore:123456789",
  listingLabel: "Acme Cafe (App Store)",
  inRoster: true,
  appId: "123456789",
  country: "us",
  maxPages: 10,
};

describe("reputation.saveRoster (the one reputation tool that writes)", () => {
  let rootDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reputation-save-roster-"));
    store = new WorkspaceStore(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("merges the roster into an existing config and leaves every other product's key exactly as it was", async () => {
    await store.writeJson("acme", ["client", "config"], {
      xHandle: "acme",
      instagramStyleConfig: { rules: ["no emoji"] },
      reputationAutonomy: "approve-all",
    });

    const tool = createSaveRoster(store);
    const outcome = await tool.execute({ roster: [SAMPLE_LEG], setup: { seeds: ["https://apps.apple.com/us/app/acme/id123456789"] } }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toMatchObject({ id: "client/config", created: false, legCount: 1, wrote: ["reputationRoster", "reputationSetup"] });

    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config).toMatchObject({
      xHandle: "acme",
      instagramStyleConfig: { rules: ["no emoji"] },
      reputationAutonomy: "approve-all",
      reputationRoster: [SAMPLE_LEG],
    });
    expect(config?.["reputationSetup"]).toMatchObject({
      seeds: ["https://apps.apple.com/us/app/acme/id123456789"],
      recordedBy: "reputation.saveRoster",
      runId: "run_setup_1",
    });
    // No locks were supplied, so none were invented.
    expect(config?.["reputationLocks"]).toBeUndefined();
  });

  it("creates the config record when the client has none at all", async () => {
    const tool = createSaveRoster(store);
    const outcome = await tool.execute({ roster: [SAMPLE_LEG] }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.created).toBe(true);
    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config?.["reputationRoster"]).toEqual([SAMPLE_LEG]);
  });

  it("writes the never-say locks only when the client has none on file", async () => {
    const tool = createSaveRoster(store);
    const first = await tool.execute({ roster: [SAMPLE_LEG], locks: { neverSay: ["refund"], requiredFramingAnyOf: [] } }, { ctx });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("unreachable");
    expect(first.result.wrote).toEqual(["reputationRoster", "reputationLocks", "reputationSetup"]);

    await store.writeJson("beta", ["client", "config"], { reputationLocks: { neverSay: ["lawsuit"], requiredFramingAnyOf: ["as a licensed provider"] } });
    const second = await tool.execute(
      { roster: [SAMPLE_LEG], locks: { neverSay: ["refund"], requiredFramingAnyOf: [] } },
      { ctx: { ...ctx, clientSlug: "beta" } },
    );
    expect(second.status).toBe("success");
    if (second.status !== "success") throw new Error("unreachable");
    expect(second.result.wrote).toEqual(["reputationRoster", "reputationSetup"]);
    const config = await store.readJson<Record<string, unknown>>("beta", ["client", "config"]);
    // The standing decision wins; setup does not overwrite a lock list.
    expect(config?.["reputationLocks"]).toEqual({ neverSay: ["lawsuit"], requiredFramingAnyOf: ["as a licensed provider"] });
  });

  it("refuses to replace a roster already on file", async () => {
    await store.writeJson("acme", ["client", "config"], { reputationRoster: [SAMPLE_LEG] });
    const tool = createSaveRoster(store);
    const outcome = await tool.execute(
      { roster: [{ ...SAMPLE_LEG, listingId: "appstore:987654321", appId: "987654321" }] },
      { ctx },
    );
    expect(outcome.status).toBe("content_fail");
    if (outcome.status !== "content_fail") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/already has a reputationRoster on file \(1 legs\)/);
    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config?.["reputationRoster"]).toEqual([SAMPLE_LEG]);
  });

  it("refuses an empty roster at the schema", async () => {
    const tool = createSaveRoster(store);
    const outcome = await tool.execute({ roster: [] }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});
