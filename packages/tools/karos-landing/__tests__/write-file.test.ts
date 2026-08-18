import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteSiteFile } from "../src/write-file/write-file-tool.js";
import { createReadSiteFile } from "../src/write-file/read-file-tool.js";
import { testCtx } from "./test-helpers.js";

/**
 * Security tests for `landing.writeSiteFile` at the tool boundary (not just
 * the underlying sandbox module) — proving every out-of-scope write attempt
 * a model could plausibly issue resolves to `tooling_error`, never a silent
 * success and never a content judgment (RFC-07 §7).
 */
describe("landing.writeSiteFile", () => {
  let tmpRoot: string;
  let templateRoot: string;
  let engineClientsRoot: string;
  let siteRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-write-file-"));
    templateRoot = path.join(tmpRoot, "template");
    engineClientsRoot = path.join(tmpRoot, "clients");
    siteRoot = path.join(engineClientsRoot, "forge", "site");
    await fs.mkdir(templateRoot, { recursive: true });
    await fs.writeFile(path.join(templateRoot, "brand.json"), "{}");
    await fs.mkdir(siteRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeTool() {
    return createWriteSiteFile({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
  }

  it("writes a file inside the client's site directory", async () => {
    const tool = makeTool();
    const outcome = await tool.execute({ relativePath: "src/app/globals.css", content: ":root{}" }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    expect(await fs.readFile(path.join(siteRoot, "src", "app", "globals.css"), "utf8")).toBe(":root{}");
  });

  it("rejects a path-traversal write attempt as tooling_error, not a silent no-op", async () => {
    const tool = makeTool();
    const outcome = await tool.execute({ relativePath: "../../../etc/passwd", content: "pwned" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
    await expect(fs.access(path.join(tmpRoot, "..", "etc", "passwd"))).rejects.toThrow();
  });

  it("rejects an attempt to write into the read-only template root even when addressed via a valid-looking relative path", async () => {
    // Simulate a misconfigured deployment where templateRoot happens to be reachable — the
    // explicit template-root exclusion inside resolveSandboxedWritePath must still hold.
    const nestedSiteRoot = path.join(templateRoot, "clients", "forge", "site");
    await fs.mkdir(nestedSiteRoot, { recursive: true });
    const tool = createWriteSiteFile({ templateRoot, engineClientsRoot: path.join(templateRoot, "clients"), bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ relativePath: "hack.tsx", content: "x" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
  });

  it("rejects an absolute path", async () => {
    const tool = makeTool();
    const outcome = await tool.execute({ relativePath: path.join(tmpRoot, "outside.txt"), content: "x" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
  });

  it("rejects a symlink-escape write attempt", async () => {
    const outsideDir = path.join(tmpRoot, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(siteRoot, "escape"), "junction");
    const tool = makeTool();
    const outcome = await tool.execute({ relativePath: "escape/pwned.txt", content: "x" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
    await expect(fs.access(path.join(outsideDir, "pwned.txt"))).rejects.toThrow();
  });

  it("keeps two clients' writes fully isolated by clientSlug alone (never by argument)", async () => {
    const tool = makeTool();
    await tool.execute({ relativePath: "src/content/forge.ts", content: "forge content" }, { ctx: testCtx({ clientSlug: "forge" }) });
    await fs.mkdir(path.join(engineClientsRoot, "roasthouse", "site"), { recursive: true });
    await tool.execute({ relativePath: "src/content/roasthouse.ts", content: "roasthouse content" }, { ctx: testCtx({ clientSlug: "roasthouse" }) });

    await expect(fs.access(path.join(siteRoot, "src", "content", "roasthouse.ts"))).rejects.toThrow();
    expect(await fs.readFile(path.join(engineClientsRoot, "roasthouse", "site", "src", "content", "roasthouse.ts"), "utf8")).toBe("roasthouse content");
  });
});

describe("landing.readSiteFile", () => {
  let tmpRoot: string;
  let templateRoot: string;
  let engineClientsRoot: string;
  let siteRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-read-file-"));
    templateRoot = path.join(tmpRoot, "template");
    engineClientsRoot = path.join(tmpRoot, "clients");
    siteRoot = path.join(engineClientsRoot, "forge", "site");
    await fs.mkdir(templateRoot, { recursive: true });
    await fs.mkdir(path.join(siteRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(siteRoot, "src", "page.tsx"), "hello");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reads back a file written under the client's site", async () => {
    const tool = createReadSiteFile({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ relativePath: "src/page.tsx" }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.result.content).toBe("hello");
  });

  it("returns not_available for a file that does not exist yet", async () => {
    const tool = createReadSiteFile({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ relativePath: "src/missing.tsx" }, { ctx: testCtx() });
    expect(outcome.status).toBe("not_available");
  });

  it("rejects a traversal read attempt", async () => {
    const tool = createReadSiteFile({ templateRoot, engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
    const outcome = await tool.execute({ relativePath: "../../../etc/passwd" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
  });
});
