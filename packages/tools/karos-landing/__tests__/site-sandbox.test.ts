import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSandboxedWritePath, assertReadPathWithinRoot, siteRootForClient, SiteSandboxViolation } from "../src/sandbox/site-sandbox.js";

/**
 * Security unit tests for the Landing Builder write-fence (RFC-07 §4/§7):
 * every out-of-scope write attempt — path traversal, an absolute path, a
 * symlink planted inside the sandbox pointing outside it, or a target that
 * resolves into the read-only template root — must throw
 * `SiteSandboxViolation`, never silently succeed or silently no-op.
 */
describe("site-sandbox: write-fence security", () => {
  let tmpRoot: string;
  let sandboxRoot: string;
  let templateRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-sandbox-"));
    sandboxRoot = path.join(tmpRoot, "clients", "acme", "site");
    templateRoot = path.join(tmpRoot, "template");
    outsideDir = path.join(tmpRoot, "outside-the-sandbox");
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.mkdir(templateRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "should never be reachable");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("resolves a well-formed relative path inside an already-copied sandbox root", async () => {
    const resolved = await resolveSandboxedWritePath(sandboxRoot, templateRoot, "src/app/page.tsx");
    expect(resolved).toBe(path.join(await fs.realpath(sandboxRoot), "src", "app", "page.tsx"));
  });

  it("throws on a path-traversal attempt ('../../etc/passwd')", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "../../etc/passwd")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws on a traversal attempt disguised mid-path ('src/../../../outside-the-sandbox/x')", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "src/../../../outside-the-sandbox/x")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws on an absolute path", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, path.join(outsideDir, "x.txt"))).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws on a URL-shaped path", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "file:///etc/passwd")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws on an empty path", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws on a NUL byte in the path", async () => {
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "src/app\0/page.tsx")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws when a symlink planted inside the sandbox points outside it (symlink escape)", async () => {
    const linkPath = path.join(sandboxRoot, "escape-link");
    await fs.symlink(outsideDir, linkPath, "junction");
    await expect(resolveSandboxedWritePath(sandboxRoot, templateRoot, "escape-link/secret.txt")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws when the sandbox root itself has not been created yet (no template copy happened)", async () => {
    const uncopiedRoot = path.join(tmpRoot, "clients", "brand-new", "site");
    await expect(resolveSandboxedWritePath(uncopiedRoot, templateRoot, "src/app/page.tsx")).rejects.toThrow(SiteSandboxViolation);
  });

  it("throws when the resolved target lands inside the read-only template root (misconfiguration)", async () => {
    // Simulates a misconfigured sandbox that is nested under the template root itself —
    // the template-root exclusion must hold even when the traversal guard alone wouldn't catch it.
    const nestedSandbox = path.join(templateRoot, "clients", "acme", "site");
    await fs.mkdir(nestedSandbox, { recursive: true });
    await expect(resolveSandboxedWritePath(nestedSandbox, templateRoot, "src/app/page.tsx")).rejects.toThrow(SiteSandboxViolation);
  });

  it("allows deep, not-yet-existing subdirectories as long as they stay inside the sandbox root", async () => {
    const resolved = await resolveSandboxedWritePath(sandboxRoot, templateRoot, "src/components/custom/signature-showcase.tsx");
    expect(resolved.startsWith(await fs.realpath(sandboxRoot))).toBe(true);
  });
});

describe("assertReadPathWithinRoot", () => {
  it("resolves a well-formed relative path", () => {
    expect(assertReadPathWithinRoot("/repo/site", "src/app/page.tsx", "page")).toBe(path.resolve("/repo/site", "src/app/page.tsx"));
  });

  it("throws on traversal", () => {
    expect(() => assertReadPathWithinRoot("/repo/site", "../../etc/passwd", "page")).toThrow(SiteSandboxViolation);
  });

  it("throws on an absolute path", () => {
    expect(() => assertReadPathWithinRoot("/repo/site", "/etc/passwd", "page")).toThrow(SiteSandboxViolation);
  });
});

describe("siteRootForClient", () => {
  it("joins engineClientsRoot/<clientSlug>/site", () => {
    const root = siteRootForClient({ templateRoot: "/repo/template", engineClientsRoot: "/repo/clients" }, "acme");
    expect(root).toBe(path.join("/repo/clients", "acme", "site"));
  });

  it("rejects a clientSlug that is itself a path-traversal attempt", () => {
    expect(() => siteRootForClient({ templateRoot: "/repo/template", engineClientsRoot: "/repo/clients" }, "../../etc")).toThrow();
  });
});
