import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCopyTemplate } from "../src/copy-template/copy-template-tool.js";
import { testCtx } from "./test-helpers.js";

describe("landing.copyTemplate", () => {
  let tmpRoot: string;
  let templateRoot: string;
  let engineClientsRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-copy-template-"));
    templateRoot = path.join(tmpRoot, "template");
    engineClientsRoot = path.join(tmpRoot, "clients");
    await fs.mkdir(path.join(templateRoot, "src", "app"), { recursive: true });
    await fs.mkdir(path.join(templateRoot, "src", "components"), { recursive: true });
    await fs.writeFile(path.join(templateRoot, "package.json"), '{"name":"template"}');
    await fs.writeFile(path.join(templateRoot, "src", "app", "page.tsx"), "export default function Page() { return null; }");
    await fs.writeFile(path.join(templateRoot, "src", "components", "hero.tsx"), "export function Hero() { return null; }");
    await fs.mkdir(path.join(templateRoot, "node_modules", "somepkg"), { recursive: true });
    await fs.writeFile(path.join(templateRoot, "node_modules", "somepkg", "index.js"), "module.exports = {};");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("copies every template file into OUTPUT_PATH/site, skipping node_modules", async () => {
    const tool = createCopyTemplate({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ force: false }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.filesCopied).toBe(3);

    const siteRoot = path.join(engineClientsRoot, "forge", "site");
    expect(await fs.readFile(path.join(siteRoot, "package.json"), "utf8")).toContain("template");
    expect(await fs.readFile(path.join(siteRoot, "src", "app", "page.tsx"), "utf8")).toContain("Page");
    await expect(fs.access(path.join(siteRoot, "node_modules"))).rejects.toThrow();
  });

  it("refuses to overwrite an existing site directory without force", async () => {
    const tool = createCopyTemplate({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    await tool.execute({ force: false }, { ctx: testCtx() });
    const second = await tool.execute({ force: false }, { ctx: testCtx() });
    expect(second.status).toBe("content_fail");
  });

  it("overwrites when force:true is passed", async () => {
    const tool = createCopyTemplate({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    await tool.execute({ force: false }, { ctx: testCtx() });
    const siteRoot = path.join(engineClientsRoot, "forge", "site");
    await fs.writeFile(path.join(siteRoot, "stray-file.txt"), "leftover");
    const second = await tool.execute({ force: true }, { ctx: testCtx() });
    expect(second.status).toBe("success");
    await expect(fs.access(path.join(siteRoot, "stray-file.txt"))).rejects.toThrow();
  });

  it("scopes the copy to the calling client's own clientSlug, never a model-supplied path", async () => {
    const tool = createCopyTemplate({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    await tool.execute({ force: false }, { ctx: testCtx({ clientSlug: "roasthouse" }) });
    const siteRoot = path.join(engineClientsRoot, "roasthouse", "site");
    expect(await fs.access(path.join(siteRoot, "package.json"))).toBeUndefined();
  });
});

describe("landing.copyTemplate against the real shipped kit (agent-engine#3)", () => {
  let tmpRoot: string;
  let engineClientsRoot: string;
  // The real production default this package now ships (outside __tests__, so
  // it IS in the deployed image) — LANDING_ENGINE_TEMPLATE_ROOT points here in
  // cloudbuild.yaml/cloudbuild.promote.yaml. Proves the actual asset tree, not
  // a synthetic fixture, copies cleanly — the same gap #3's other half
  // (read-bundle-tool.ts's GCS path) closed for brand.json/intake.md.
  const REAL_TEMPLATE_ROOT = path.resolve(__dirname, "..", "assets", "template");

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-copy-real-template-"));
    engineClientsRoot = path.join(tmpRoot, "clients");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("copies every file of the real shipped Next.js template kit", async () => {
    const tool = createCopyTemplate({ templateRoot: REAL_TEMPLATE_ROOT, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ force: false }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.filesCopied).toBe(26);

    const siteRoot = path.join(engineClientsRoot, "forge", "site");
    expect(await fs.readFile(path.join(siteRoot, "package.json"), "utf8")).toContain("landing-template");
    expect(await fs.readFile(path.join(siteRoot, "src", "app", "layout.tsx"), "utf8")).toContain("export default");
    expect(await fs.readFile(path.join(siteRoot, "src", "components", "hero.tsx"), "utf8")).toContain("export");
    expect(await fs.readFile(path.join(siteRoot, "src", "lib", "content-schema.ts"), "utf8")).toContain("export");
  });
});
