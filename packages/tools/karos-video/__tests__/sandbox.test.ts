import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertNoTraversalOrNul, assertWithinTenantWorkRoot, VideoPathViolation } from "../src/sandbox.js";

describe("assertNoTraversalOrNul", () => {
  it("allows an ordinary absolute path", () => {
    expect(() => assertNoTraversalOrNul("/var/data/job.json", "path")).not.toThrow();
  });

  it("rejects a NUL byte", () => {
    expect(() => assertNoTraversalOrNul("/var/data/job\0.json", "path")).toThrow(VideoPathViolation);
  });

  it("rejects a traversal segment", () => {
    expect(() => assertNoTraversalOrNul("/var/data/../../etc/passwd", "path")).toThrow(VideoPathViolation);
  });
});

describe("assertWithinTenantWorkRoot", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("allows a path inside the tenant's own directory", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    const tenantDir = path.join(dir, "acme");
    await mkdir(tenantDir, { recursive: true });

    await expect(assertWithinTenantWorkRoot(dir, "acme", path.join(tenantDir, "job.json"), "path")).resolves.toBeUndefined();
  });

  it("allows a not-yet-existing tenant directory (first write for a fresh client)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    const target = path.join(dir, "acme", "job.json");

    await expect(assertWithinTenantWorkRoot(dir, "acme", target, "path")).resolves.toBeUndefined();
  });

  it("rejects a path resolving outside the tenant's own directory", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    const otherClientTarget = path.join(dir, "roasthouse", "job.json");

    await expect(assertWithinTenantWorkRoot(dir, "acme", otherClientTarget, "path")).rejects.toThrow(VideoPathViolation);
  });

  it("rejects a path escaping the work root entirely", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    const outside = path.join(dir, "..", "outside.json");

    await expect(assertWithinTenantWorkRoot(dir, "acme", outside, "path")).rejects.toThrow(VideoPathViolation);
  });

  it("rejects a symlink-escape write attempt", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    const tenantDir = path.join(dir, "acme");
    const outsideDir = path.join(dir, "outside");
    await mkdir(tenantDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(tenantDir, "escape"), "junction");

    await expect(assertWithinTenantWorkRoot(dir, "acme", path.join(tenantDir, "escape", "pwned.json"), "path")).rejects.toThrow(VideoPathViolation);
  });

  it("rejects a clientSlug that is itself a traversal attempt", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-sandbox-"));
    await expect(assertWithinTenantWorkRoot(dir, "../../etc", path.join(dir, "job.json"), "path")).rejects.toThrow();
  });
});
