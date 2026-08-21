import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GcsArtifactStoreLike, ArtifactUploadResult } from "@agent-engine/tool-common";
import { createUploadSiteBundle } from "../src/upload-site-bundle/upload-site-bundle-tool.js";
import type { LandingEngineConfig } from "../src/config.js";
import { testCtx } from "./test-helpers.js";

function fakeArtifactStore(): { store: GcsArtifactStoreLike; uploaded: Map<string, Buffer> } {
  const uploaded = new Map<string, Buffer>();
  const store: GcsArtifactStoreLike = {
    bucketName: "karoscmo-prep-agent-artifacts",
    async upload(objectPath, data): Promise<ArtifactUploadResult> {
      uploaded.set(objectPath, data);
      return { objectPath, gcsUri: `gs://karoscmo-prep-agent-artifacts/${objectPath}` };
    },
    async download(objectPath) {
      const buf = uploaded.get(objectPath);
      if (!buf) throw new Error("not found");
      return buf;
    },
    async exists(objectPath) {
      return uploaded.has(objectPath);
    },
  };
  return { store, uploaded };
}

describe("landing.uploadSiteBundle", () => {
  let root: string;
  let config: LandingEngineConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "landing-upload-"));
    config = { templateRoot: path.join(root, "template"), engineClientsRoot: path.join(root, "clients"), bundlesRoot: path.join(root, "bundles") };

    const siteDir = path.join(config.engineClientsRoot, "acme", "site");
    await fs.mkdir(path.join(siteDir, "src", "app"), { recursive: true });
    await fs.writeFile(path.join(siteDir, "package.json"), '{"name":"acme-site"}');
    await fs.writeFile(path.join(siteDir, "src", "app", "page.tsx"), "export default function Page() { return null; }");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uploads every file under the client's site directory, mirroring its relative path under a per-run prefix", async () => {
    const { store, uploaded } = fakeArtifactStore();
    const tool = createUploadSiteBundle(config, store);

    const outcome = await tool.execute({ clientSlug: "acme", runId: "run_1" }, { ctx: testCtx() });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected success");
    const result = outcome.result as { gcsPrefix: string; fileCount: number };
    expect(result.gcsPrefix).toBe("gs://karoscmo-prep-agent-artifacts/landing/acme/run_1/site/");
    expect(result.fileCount).toBe(2);

    expect([...uploaded.keys()].sort()).toEqual(["landing/acme/run_1/site/package.json", "landing/acme/run_1/site/src/app/page.tsx"]);
    expect(uploaded.get("landing/acme/run_1/site/package.json")?.toString("utf8")).toBe('{"name":"acme-site"}');
  });

  it("returns a tooling_error, not a thrown exception, when the client's site directory doesn't exist", async () => {
    const { store } = fakeArtifactStore();
    const tool = createUploadSiteBundle(config, store);

    const outcome = await tool.execute({ clientSlug: "no-such-client", runId: "run_1" }, { ctx: testCtx() });

    expect(outcome.status).toBe("tooling_error");
  });
});
