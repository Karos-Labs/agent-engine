import { describe, expect, it } from "vitest";
import { exemplarLibraryAction, HARVEST_PLAN_VERSION, MIN_REFERENCE_ACCOUNTS, planHarvest, type ExemplarLibrary } from "../src/workflow/exemplar-library.js";

/**
 * Prep, 2026-09-24/25: Sitti's library held its own 6 posts and one filed
 * reference with no post in a year; XO Digital's one filed handle failed and
 * the harvest returned nothing. The category peers were added only when NO
 * reference was on file.
 */
describe("the harvest reads a category, not one account", () => {
  it("tops a single filed reference up to four with the category's peers, filed first", () => {
    const plan = planHarvest({ ownAccounts: [{ platform: "instagram", username: "sitti.app" }], referenceAccounts: [{ platform: "instagram", handle: "alixearl" }], competitors: [], peers: ["peer.one", "peer.two", "peer.three", "peer.four"] });
    const refs = plan.accounts.filter((a) => a.role === "reference").map((a) => a.handle);
    expect(refs[0]).toBe("alixearl");
    expect(refs).toHaveLength(MIN_REFERENCE_ACCOUNTS);
    expect(plan.accounts.find((a) => a.role === "client")?.handle).toBe("sitti.app");
  });

  it("with no peers, the industry benchmarks fill the gap; four filed references need nothing added", () => {
    const benchmarked = planHarvest({ ownAccounts: [], referenceAccounts: [{ platform: "instagram", handle: "me.poupe" }], competitors: [], industry: "fintech" });
    expect(benchmarked.accounts.filter((a) => a.role === "reference").length).toBeGreaterThanOrEqual(2);
    const full = planHarvest({ ownAccounts: [], referenceAccounts: ["a1", "a2", "a3", "a4"].map((handle) => ({ platform: "instagram", handle })), competitors: [], peers: ["never.used"] });
    expect(full.accounts.map((a) => a.handle)).not.toContain("never.used");
  });

  it("an old planner's thin library rebuilds now; a new one is reused as before", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const thin: ExemplarLibrary = { version: 1, builtAt: "2026-09-25T00:00:00Z", status: "built", problems: [], accounts: [{ handle: "sitti.app", role: "client", posts: 6 }], entries: [] };
    expect(exemplarLibraryAction(thin, now)).toBe("build");
    const rich: ExemplarLibrary = { ...thin, accounts: ["r1", "r2", "r3", "r4"].map((handle) => ({ handle, role: "reference" as const, posts: 100 })) };
    expect(exemplarLibraryAction(rich, now)).toBe("reuse");
    expect(exemplarLibraryAction({ ...thin, planVersion: HARVEST_PLAN_VERSION }, now)).toBe("reuse");
  });
});
