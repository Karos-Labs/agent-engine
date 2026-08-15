import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosClientTools, type ClientProfile, type ClientBrand, type Competitor, type Executive } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-client", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosClientTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-client-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosClientTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("client.getProfile", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.getProfile"]!.execute({}, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const profile: ClientProfile = { name: "Acme Corp", industry: "Widgets" };
      await store.writeJson("acme", ["client", "profile"], profile);

      const outcome = await tools["client.getProfile"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: profile });
    });
  });

  describe("client.getBrand", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.getBrand"]!.execute({}, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const brand: ClientBrand = { voice: "confident", colors: ["#000000", "#FFFFFF"] };
      await store.writeJson("acme", ["client", "brand"], brand);

      const outcome = await tools["client.getBrand"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: brand });
    });
  });

  describe("client.getVoiceRules", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const rules = { tone: "friendly", doList: ["be concise"], dontList: ["use jargon"] };
      await store.writeJson("acme", ["client", "voice-rules"], rules);

      const outcome = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: rules });
    });
  });

  describe("client.listCompetitors", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.listCompetitors"]!.execute({ limit: 20 }, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const competitors: Competitor[] = [{ name: "Globex" }, { name: "Initech" }];
      await store.writeJson("acme", ["client", "competitors"], competitors);

      const outcome = await tools["client.listCompetitors"]!.execute({ limit: 20 }, { ctx });
      expect(outcome).toEqual({ status: "success", result: competitors });
    });

    it("returns success with an empty list when the file exists but is empty", async () => {
      await store.writeJson("acme", ["client", "competitors"], []);

      const outcome = await tools["client.listCompetitors"]!.execute({ limit: 20 }, { ctx });
      expect(outcome).toEqual({ status: "success", result: [] });
    });

    it("applies the default limit when none is supplied", async () => {
      const competitors: Competitor[] = Array.from({ length: 25 }, (_, i) => ({ name: `Competitor ${i}` }));
      await store.writeJson("acme", ["client", "competitors"], competitors);

      const outcome = await tools["client.listCompetitors"]!.execute({}, { ctx });
      expect(outcome.status).toBe("success");
      expect(outcome.status === "success" ? outcome.result : []).toHaveLength(20);
    });

    it("respects an explicit limit smaller than the stored list", async () => {
      const competitors: Competitor[] = [{ name: "A" }, { name: "B" }, { name: "C" }];
      await store.writeJson("acme", ["client", "competitors"], competitors);

      const outcome = await tools["client.listCompetitors"]!.execute({ limit: 2 }, { ctx });
      expect(outcome).toEqual({ status: "success", result: [{ name: "A" }, { name: "B" }] });
    });
  });

  describe("client.getExecutives", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.getExecutives"]!.execute({}, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const executives: Executive[] = [{ name: "Jane Doe", title: "CEO" }];
      await store.writeJson("acme", ["client", "executives"], executives);

      const outcome = await tools["client.getExecutives"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: executives });
    });

    it("returns success with an empty list when the file exists but is empty", async () => {
      await store.writeJson("acme", ["client", "executives"], []);

      const outcome = await tools["client.getExecutives"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: [] });
    });
  });

  describe("client.getConfig", () => {
    it("returns not_available when nothing has been set up yet", async () => {
      const outcome = await tools["client.getConfig"]!.execute({}, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns exactly what was written", async () => {
      const config = { postingCadence: "daily", timezone: "America/New_York" };
      await store.writeJson("acme", ["client", "config"], config);

      const outcome = await tools["client.getConfig"]!.execute({}, { ctx });
      expect(outcome).toEqual({ status: "success", result: config });
    });
  });

  describe("tenant scoping", () => {
    it("ignores a model-supplied clientSlug override in favor of ctx.clientSlug", async () => {
      const acmeProfile: ClientProfile = { name: "Acme Corp" };
      await store.writeJson("acme", ["client", "profile"], acmeProfile);

      const outcome = await tools["client.getProfile"]!.execute({ clientSlug: "attacker-corp" } as never, { ctx });

      expect(outcome).toEqual({ status: "success", result: acmeProfile });
      expect(await store.exists("attacker-corp", ["client", "profile"])).toBe(false);
    });

    it("keeps two tenants' data for the same tool fully separate", async () => {
      const acmeCtx: AgentContext = { ...ctx, clientSlug: "acme" };
      const globexCtx: AgentContext = { ...ctx, clientSlug: "globex" };

      await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp" });
      await store.writeJson("globex", ["client", "profile"], { name: "Globex Corporation" });

      const acmeOutcome = await tools["client.getProfile"]!.execute({}, { ctx: acmeCtx });
      const globexOutcome = await tools["client.getProfile"]!.execute({}, { ctx: globexCtx });

      expect(acmeOutcome).toEqual({ status: "success", result: { name: "Acme Corp" } });
      expect(globexOutcome).toEqual({ status: "success", result: { name: "Globex Corporation" } });
    });

    it("keeps two tenants' competitor lists fully separate", async () => {
      const acmeCtx: AgentContext = { ...ctx, clientSlug: "acme" };
      const globexCtx: AgentContext = { ...ctx, clientSlug: "globex" };

      await store.writeJson("acme", ["client", "competitors"], [{ name: "Acme-rival" }]);

      const acmeOutcome = await tools["client.listCompetitors"]!.execute({ limit: 20 }, { ctx: acmeCtx });
      const globexOutcome = await tools["client.listCompetitors"]!.execute({ limit: 20 }, { ctx: globexCtx });

      expect(acmeOutcome).toEqual({ status: "success", result: [{ name: "Acme-rival" }] });
      expect(globexOutcome.status).toBe("not_available");
    });
  });
});
