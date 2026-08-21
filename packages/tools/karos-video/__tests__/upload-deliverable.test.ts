import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GcsArtifactStoreLike, ArtifactUploadResult } from "@agent-engine/tool-common";
import { createUploadDeliverable } from "../src/tools/upload-deliverable.js";
import { ctx } from "./test-helpers.js";

function fakeMediaStore(overrides: Partial<GcsArtifactStoreLike> = {}): GcsArtifactStoreLike {
  return {
    bucketName: "karoscmo-prep-media-assets",
    async upload(objectPath, _data, options): Promise<ArtifactUploadResult> {
      return {
        objectPath,
        gcsUri: `gs://karoscmo-prep-media-assets/${objectPath}`,
        signedUrl: `https://storage.googleapis.com/${objectPath}?ct=${options?.contentType ?? ""}`,
      };
    },
    async download() {
      throw new Error("not used in these tests");
    },
    async exists() {
      return true;
    },
    ...overrides,
  };
}

describe("video.uploadDeliverable", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-video-upload-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the local file and uploads it, returning gcsUri and signedUrl", async () => {
    const localPath = path.join(tmpDir, "final.mp4");
    await fs.writeFile(localPath, "fake-mp4-bytes");

    const tool = createUploadDeliverable(fakeMediaStore());
    const outcome = await tool.execute({ localPath, objectPath: "branded-shorts/acme/run_1/final.mp4", contentType: "video/mp4" }, { ctx });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected success");
    const result = outcome.result as { gcsUri: string; signedUrl?: string };
    expect(result.gcsUri).toBe("gs://karoscmo-prep-media-assets/branded-shorts/acme/run_1/final.mp4");
    expect(result.signedUrl).toContain("ct=video/mp4");
  });

  it("returns a tooling_error, not a thrown exception, when the local file doesn't exist", async () => {
    const tool = createUploadDeliverable(fakeMediaStore());
    const outcome = await tool.execute(
      { localPath: path.join(tmpDir, "does-not-exist.mp4"), objectPath: "branded-shorts/acme/run_1/final.mp4" },
      { ctx },
    );

    expect(outcome.status).toBe("tooling_error");
  });

  it("omits signedUrl from the result when the media store can't produce one", async () => {
    const localPath = path.join(tmpDir, "final.mp4");
    await fs.writeFile(localPath, "fake-mp4-bytes");

    const noSignStore = fakeMediaStore({
      async upload(objectPath) {
        return { objectPath, gcsUri: `gs://karoscmo-prep-media-assets/${objectPath}` };
      },
    });
    const outcome = await createUploadDeliverable(noSignStore).execute({ localPath, objectPath: "x.mp4" }, { ctx });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected success");
    expect((outcome.result as { signedUrl?: string }).signedUrl).toBeUndefined();
  });
});
