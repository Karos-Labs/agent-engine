import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createReadBundle } from "../src/read-bundle/read-bundle-tool.js";
import { testCtx } from "./test-helpers.js";

describe("landing.readBundle", () => {
  let tmpRoot: string;
  let bundlesRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-read-bundle-"));
    bundlesRoot = path.join(tmpRoot, "bundles");
    await fs.mkdir(path.join(bundlesRoot, "forge", "assets", "images"), { recursive: true });
    await fs.writeFile(
      path.join(bundlesRoot, "forge", "brand.json"),
      JSON.stringify({
        client: "forge",
        tokens: { colors: { ember: "#FF4D00" } },
        fonts: { display: "Anton", body: "Inter" },
        carryForward: [{ type: "tool", what: "coaching chatbot" }],
      }),
    );
    await fs.writeFile(path.join(bundlesRoot, "forge", "intake.md"), "# Forge intake\n");
    await fs.writeFile(path.join(bundlesRoot, "forge", "assets", "images", "hero.png"), "fake-png");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reads brand.json + intake.md + lists assets for the bound client", async () => {
    const tool = createReadBundle({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.brand.client).toBe("forge");
    expect(outcome.result.brand.carryForward).toHaveLength(1);
    expect(outcome.result.intakeMarkdown).toContain("Forge intake");
    expect(outcome.result.assetPaths).toContain(path.join("images", "hero.png"));
  });

  it("returns content_fail when brand.json is missing", async () => {
    const tool = createReadBundle({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "nobody" }) });
    expect(outcome.status).toBe("content_fail");
  });

  it("returns content_fail when brand.json is malformed JSON", async () => {
    await fs.writeFile(path.join(bundlesRoot, "forge", "brand.json"), "{not json");
    const tool = createReadBundle({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("content_fail");
  });

  it("scopes the read to the ctx-bound clientSlug only", async () => {
    await fs.mkdir(path.join(bundlesRoot, "roasthouse"), { recursive: true });
    await fs.writeFile(path.join(bundlesRoot, "roasthouse", "brand.json"), JSON.stringify({ client: "roasthouse", tokens: { colors: {} }, fonts: { display: "X", body: "Y" } }));
    await fs.writeFile(path.join(bundlesRoot, "roasthouse", "intake.md"), "# Roasthouse\n");
    const tool = createReadBundle({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "roasthouse" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.result.brand.client).toBe("roasthouse");
  });
});

describe("landing.readBundle — WorkspaceStoreLike-backed (agent-engine#3)", () => {
  let storeRoot: string;
  let store: WorkspaceStore;
  const localOnlyConfig = { templateRoot: "/unused", engineClientsRoot: "/unused", bundlesRoot: "/unused" };

  beforeEach(async () => {
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-workspace-store-"));
    store = new WorkspaceStore(storeRoot);
  });

  afterEach(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
  });

  it("reads brand.json + intake.md from the store instead of local disk, once one is supplied", async () => {
    await store.writeJson("forge", ["landing", "brand"], {
      client: "forge",
      tokens: { colors: { ember: "#FF4D00" } },
      fonts: { display: "Anton", body: "Inter" },
    });
    await store.writeJson("forge", ["landing", "intake"], { markdown: "# Forge intake\n" });

    const tool = createReadBundle(localOnlyConfig, store);
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.brand.client).toBe("forge");
    expect(outcome.result.intakeMarkdown).toContain("Forge intake");
    // Not ported to the store path (see read-bundle-tool.ts's own doc comment) — empty, not an error.
    expect(outcome.result.assetPaths).toEqual([]);
    expect(outcome.result.oldSiteCapturePaths).toEqual([]);
  });

  it("collects every landing/feedback/*.json round via listJson", async () => {
    await store.writeJson("forge", ["landing", "brand"], { client: "forge", tokens: { colors: {} }, fonts: { display: "X", body: "Y" } });
    await store.writeJson("forge", ["landing", "intake"], { markdown: "# Forge intake\n" });
    await store.writeJson("forge", ["landing", "feedback", "round-1"], { keeps: ["hero"] });
    await store.writeJson("forge", ["landing", "feedback", "round-2"], { keeps: ["hero", "pricing"] });

    const tool = createReadBundle(localOnlyConfig, store);
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.feedbackRounds).toHaveLength(2);
    expect(outcome.result.feedbackRounds.map((r) => r.file).sort()).toEqual(["round-1.json", "round-2.json"]);
  });

  it("returns content_fail when the store has no brand.json for this client, and never falls back to local disk", async () => {
    const tool = createReadBundle(localOnlyConfig, store);
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "nobody" }) });
    expect(outcome.status).toBe("content_fail");
  });

  it("returns content_fail when intake.json exists but has no markdown field", async () => {
    await store.writeJson("forge", ["landing", "brand"], { client: "forge", tokens: { colors: {} }, fonts: { display: "X", body: "Y" } });
    await store.writeJson("forge", ["landing", "intake"], { note: "wrong shape" });

    const tool = createReadBundle(localOnlyConfig, store);
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("content_fail");
  });

  it("scopes reads to the ctx-bound clientSlug only", async () => {
    await store.writeJson("forge", ["landing", "brand"], { client: "forge", tokens: { colors: {} }, fonts: { display: "X", body: "Y" } });
    await store.writeJson("forge", ["landing", "intake"], { markdown: "# Forge intake\n" });

    const tool = createReadBundle(localOnlyConfig, store);
    const outcome = await tool.execute({}, { ctx: testCtx({ clientSlug: "roasthouse" }) });
    expect(outcome.status).toBe("content_fail");
  });
});
