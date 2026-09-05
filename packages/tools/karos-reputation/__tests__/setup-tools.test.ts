import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createDiscoverGbpLocations } from "../src/setup/discover-gbp-tool.js";
import { createSaveRoster } from "../src/setup/save-roster-tool.js";
import type { CaptureLegRequest } from "../src/capture/types.js";

const ctx = { runId: "run_setup_1", clientSlug: "acme", productId: "reputation-agent", runKind: "recurring" as const, metadata: {} };

const GBP_LEG: CaptureLegRequest = { leg: "gbp", listingId: "gbp:loc-1", listingLabel: "Acme Cafe — Main St", inRoster: true, account: "acct-1", location: "loc-1" };

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
    const outcome = await tool.execute({ roster: [GBP_LEG], setup: { seeds: ["google"] } }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toMatchObject({ id: "client/config", created: false, legCount: 1, wrote: ["reputationRoster", "reputationSetup"] });

    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config).toMatchObject({
      xHandle: "acme",
      instagramStyleConfig: { rules: ["no emoji"] },
      reputationAutonomy: "approve-all",
      reputationRoster: [GBP_LEG],
    });
    expect(config?.["reputationSetup"]).toMatchObject({ seeds: ["google"], recordedBy: "reputation.saveRoster", runId: "run_setup_1" });
    // No locks were supplied, so none were invented.
    expect(config?.["reputationLocks"]).toBeUndefined();
  });

  it("creates the config record when the client has none at all", async () => {
    const tool = createSaveRoster(store);
    const outcome = await tool.execute({ roster: [GBP_LEG] }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.created).toBe(true);
    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config?.["reputationRoster"]).toEqual([GBP_LEG]);
  });

  it("writes the never-say locks only when the client has none on file", async () => {
    const tool = createSaveRoster(store);
    const first = await tool.execute({ roster: [GBP_LEG], locks: { neverSay: ["refund"], requiredFramingAnyOf: [] } }, { ctx });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("unreachable");
    expect(first.result.wrote).toEqual(["reputationRoster", "reputationLocks", "reputationSetup"]);

    await store.writeJson("beta", ["client", "config"], { reputationLocks: { neverSay: ["lawsuit"], requiredFramingAnyOf: ["as a licensed provider"] } });
    const second = await tool.execute(
      { roster: [GBP_LEG], locks: { neverSay: ["refund"], requiredFramingAnyOf: [] } },
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
    await store.writeJson("acme", ["client", "config"], { reputationRoster: [GBP_LEG] });
    const tool = createSaveRoster(store);
    const outcome = await tool.execute(
      { roster: [{ ...GBP_LEG, listingId: "gbp:loc-9", location: "loc-9" }] },
      { ctx },
    );
    expect(outcome.status).toBe("content_fail");
    if (outcome.status !== "content_fail") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/already has a reputationRoster on file \(1 legs\)/);
    const config = await store.readJson<Record<string, unknown>>("acme", ["client", "config"]);
    expect(config?.["reputationRoster"]).toEqual([GBP_LEG]);
  });

  it("refuses an empty roster at the schema", async () => {
    const tool = createSaveRoster(store);
    const outcome = await tool.execute({ roster: [] }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("reputation.discoverGbpLocations (enumerates an OWNED account, never searches)", () => {
  it("reports not_available without GOOGLE_BUSINESS_TOKEN and never touches the network", async () => {
    const fetchImpl = vi.fn();
    const tool = createDiscoverGbpLocations({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await tool.execute({ account: "acct-1" }, { ctx });
    expect(outcome.status).toBe("not_available");
    if (outcome.status !== "not_available") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/GOOGLE_BUSINESS_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists every page of the account's locations as bare ids with a label, following nextPageToken", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toMatch(/^https:\/\/mybusinessbusinessinformation\.googleapis\.com\/v1\/accounts\/acct-1\/locations\?/);
      if (url.includes("pageToken=page-2")) {
        return jsonResponse({ locations: [{ name: "locations/loc-2", title: "Acme Cafe Riverside" }] });
      }
      return jsonResponse({
        locations: [
          {
            name: "locations/loc-1",
            title: "Acme Cafe",
            storefrontAddress: { addressLines: ["1 Main St"], locality: "Springfield", postalCode: "12345" },
            metadata: { placeId: "ChIJ-1", mapsUri: "https://maps.google.com/?cid=1" },
          },
        ],
        nextPageToken: "page-2",
      });
    });
    const tool = createDiscoverGbpLocations({ env: { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await tool.execute({ account: "accounts/acct-1" }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toEqual({
      account: "acct-1",
      locations: [
        { location: "loc-1", title: "Acme Cafe", placeId: "ChIJ-1", address: "1 Main St, Springfield, 12345", mapsUri: "https://maps.google.com/?cid=1" },
        { location: "loc-2", title: "Acme Cafe Riverside" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("reports not_available with the connector's own reason when the account cannot be read", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "forbidden" } }, 403));
    const tool = createDiscoverGbpLocations({ env: { GOOGLE_BUSINESS_TOKEN: "tok" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await tool.execute({ account: "acct-1" }, { ctx });
    expect(outcome.status).toBe("not_available");
    if (outcome.status !== "not_available") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/account "acct-1": UNAVAILABLE/);
  });
});
