import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactUploadResult, GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../src/config.js";
import { createRestoreSiteBundle } from "../src/site-staging/restore-site-bundle-tool.js";
import { createStageSiteBundle } from "../src/site-staging/stage-site-bundle-tool.js";
import { manifestObjectPath } from "../src/site-staging/manifest.js";
import { testCtx } from "./test-helpers.js";

/**
 * The scenario these cover is a real prep failure, not a hypothetical: a
 * landing run paused at the human-review gate on the Pub/Sub worker, resumed
 * on the HTTP service, and died at `09b-upload-site-bundle` because the two
 * are different containers with different /tmp. `stage` + `restore` exist to
 * carry the tree across that boundary.
 */

function fakeArtifactStore(): { store: GcsArtifactStoreLike; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const store: GcsArtifactStoreLike = {
    bucketName: "karoscmo-prep-agent-artifacts",
    async upload(objectPath, data): Promise<ArtifactUploadResult> {
      objects.set(objectPath, data);
      return { objectPath, gcsUri: `gs://karoscmo-prep-agent-artifacts/${objectPath}` };
    },
    async download(objectPath) {
      const buf = objects.get(objectPath);
      if (!buf) throw new Error(`no such object: ${objectPath}`);
      return buf;
    },
    async exists(objectPath) {
      return objects.has(objectPath);
    },
  };
  return { store, objects };
}

/** A config rooted at its own temp dir — one per simulated container. */
async function makeContainer(label: string): Promise<{ root: string; config: LandingEngineConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `landing-${label}-`));
  return {
    root,
    config: {
      templateRoot: path.join(root, "template"),
      engineClientsRoot: path.join(root, "clients"),
      bundlesRoot: path.join(root, "bundles"),
    },
  };
}

async function writeSite(config: LandingEngineConfig, clientSlug: string): Promise<void> {
  const siteDir = path.join(config.engineClientsRoot, clientSlug, "site");
  await fs.mkdir(path.join(siteDir, "src", "app"), { recursive: true });
  await fs.writeFile(path.join(siteDir, "package.json"), '{"name":"acme-site"}');
  await fs.writeFile(path.join(siteDir, "src", "app", "page.tsx"), "export default function P(){return null}");
  await fs.writeFile(path.join(siteDir, "src", "app", "globals.css"), ":root{--ground:#111}");
}

describe("staging a site bundle across a gate pause", () => {
  let worker: { root: string; config: LandingEngineConfig };
  let httpService: { root: string; config: LandingEngineConfig };

  beforeEach(async () => {
    worker = await makeContainer("worker");
    httpService = await makeContainer("http");
    await writeSite(worker.config, "acme");
  });

  afterEach(async () => {
    await fs.rm(worker.root, { recursive: true, force: true });
    await fs.rm(httpService.root, { recursive: true, force: true });
  });

  it("carries the tree from the worker to a different container", async () => {
    const { store } = fakeArtifactStore();

    const staged = await createStageSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );
    expect(staged.status).toBe("success");
    if (staged.status !== "success") throw new Error("unreachable");
    expect(staged.result.fileCount).toBe(3);

    // A different container: same run, empty disk.
    const restored = await createRestoreSiteBundle(httpService.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );
    expect(restored.status).toBe("success");
    if (restored.status !== "success") throw new Error("unreachable");
    expect(restored.result.source).toBe("gcs");
    expect(restored.result.fileCount).toBe(3);

    const restoredSite = path.join(httpService.config.engineClientsRoot, "acme", "site");
    expect(await fs.readFile(path.join(restoredSite, "package.json"), "utf8")).toBe('{"name":"acme-site"}');
    expect(await fs.readFile(path.join(restoredSite, "src", "app", "page.tsx"), "utf8")).toContain("export default");
    expect(await fs.readFile(path.join(restoredSite, "src", "app", "globals.css"), "utf8")).toContain("--ground");
  });

  it("is a no-op when the run never left its container", async () => {
    const { store, objects } = fakeArtifactStore();
    await createStageSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );
    const downloadsBefore = objects.size;

    // Restoring onto the SAME container that built the tree.
    const restored = await createRestoreSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );

    expect(restored.status).toBe("success");
    if (restored.status !== "success") throw new Error("unreachable");
    // Reported as local, and nothing was written back down.
    expect(restored.result.source).toBe("local");
    expect(objects.size).toBe(downloadsBefore);
  });

  it("does not overwrite a newer local tree with the staged copy", async () => {
    const { store } = fakeArtifactStore();
    await createStageSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );

    const sitePath = path.join(worker.config.engineClientsRoot, "acme", "site", "package.json");
    await fs.writeFile(sitePath, '{"name":"edited-after-staging"}');

    await createRestoreSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );

    expect(await fs.readFile(sitePath, "utf8")).toBe('{"name":"edited-after-staging"}');
  });

  it("refuses to restore when nothing was staged, and says why", async () => {
    const { store } = fakeArtifactStore();

    const restored = await createRestoreSiteBundle(httpService.config, store).execute(
      { clientSlug: "acme", runId: "never-staged" },
      { ctx: testCtx() },
    );

    expect(restored.status).toBe("tooling_error");
    if (restored.status !== "tooling_error") throw new Error("unreachable");
    // The reason must name the missing object — the whole point of the 09b fix.
    expect(restored.reason).toContain("never-staged");
    expect(restored.reason).toContain("staging manifest");
  });

  it("refuses to stage an empty tree rather than writing a hollow manifest", async () => {
    const { store } = fakeArtifactStore();
    const empty = await makeContainer("empty");
    try {
      const staged = await createStageSiteBundle(empty.config, store).execute(
        { clientSlug: "acme", runId: "run-1" },
        { ctx: testCtx() },
      );
      expect(staged.status).toBe("tooling_error");
      // An empty manifest would later restore "successfully" with zero files
      // and ship an empty site as a finished deliverable.
      expect(await store.exists(manifestObjectPath("run-1"))).toBe(false);
    } finally {
      await fs.rm(empty.root, { recursive: true, force: true });
    }
  });

  it("writes the manifest last, so a half-staged run cannot be restored", async () => {
    const objects = new Map<string, Buffer>();
    let uploads = 0;
    const flaky: GcsArtifactStoreLike = {
      bucketName: "b",
      async upload(objectPath, data): Promise<ArtifactUploadResult> {
        // Fail partway through the file uploads, before the manifest.
        if (++uploads === 2) throw new Error("network blip");
        objects.set(objectPath, data);
        return { objectPath, gcsUri: `gs://b/${objectPath}` };
      },
      async download(objectPath) {
        const buf = objects.get(objectPath);
        if (!buf) throw new Error(`no such object: ${objectPath}`);
        return buf;
      },
      async exists(objectPath) {
        return objects.has(objectPath);
      },
    };

    const staged = await createStageSiteBundle(worker.config, flaky).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );

    expect(staged.status).toBe("tooling_error");
    expect(objects.has(manifestObjectPath("run-1"))).toBe(false);

    // And a restore against that partial state refuses rather than producing
    // a silently incomplete site.
    const restored = await createRestoreSiteBundle(httpService.config, flaky).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );
    expect(restored.status).toBe("tooling_error");
  });

  it("keeps staging separate from the client-facing deliverable prefix", async () => {
    const { store, objects } = fakeArtifactStore();

    await createStageSiteBundle(worker.config, store).execute(
      { clientSlug: "acme", runId: "run-1" },
      { ctx: testCtx() },
    );

    // Staging is internal, pre-review run state. Nothing may land under the
    // landing/<client>/ prefix until a human has approved the build.
    const keys = [...objects.keys()];
    expect(keys.every((k) => k.startsWith("runs/run-1/staging/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("landing/"))).toBe(false);
  });
});
