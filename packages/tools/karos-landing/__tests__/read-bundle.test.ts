import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
