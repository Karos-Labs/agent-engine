import { describe, expect, it, beforeEach, vi } from "vitest";
import { GcsArtifactStore, createArtifactStoreFromEnv, type GcsBucketLike, type GcsFileLike } from "../src/index.js";

/**
 * A minimal in-memory double for `GcsBucketLike`, extended (relative to
 * `gcs-workspace-store.test.ts`'s own fake) with optional signed-URL support
 * so both the "signing available" and "signing unavailable" branches of
 * `GcsArtifactStore.upload` can be exercised without a real GCS bucket.
 */
class FakeGcsFile implements GcsFileLike {
  constructor(
    public readonly name: string,
    private readonly objects: Map<string, Buffer>,
    private readonly canSign: boolean,
  ) {}

  async exists(): Promise<[boolean]> {
    return [this.objects.has(this.name)];
  }

  async download(): Promise<[Buffer]> {
    const buf = this.objects.get(this.name);
    if (!buf) throw new Error(`FakeGcsFile: "${this.name}" does not exist`);
    return [buf];
  }

  async save(data: string | Buffer): Promise<void> {
    this.objects.set(this.name, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  }

  async getSignedUrl(options: { action: "read"; expires: number }): Promise<[string]> {
    if (!this.canSign) {
      throw new Error("signBlob permission denied — no private key and no IAM Credentials API access (simulating local ADC user credentials)");
    }
    return [`https://storage.googleapis.com/${this.name}?X-Goog-Expires=${options.expires}`];
  }
}

class FakeGcsBucket implements GcsBucketLike {
  private readonly objects = new Map<string, Buffer>();

  constructor(private readonly canSign: boolean = true) {}

  file(objectPath: string): GcsFileLike {
    return new FakeGcsFile(objectPath, this.objects, this.canSign);
  }

  async getFiles(options: { prefix: string }): Promise<[GcsFileLike[]]> {
    const matching = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).map((key) => new FakeGcsFile(key, this.objects, this.canSign));
    return [matching];
  }
}

describe("GcsArtifactStore", () => {
  let bucket: FakeGcsBucket;
  let store: GcsArtifactStore;

  beforeEach(() => {
    bucket = new FakeGcsBucket(true);
    store = new GcsArtifactStore(bucket, "karoscmo-prep-media-assets");
  });

  it("uploads a buffer and returns both a gs:// URI and a signed URL when signing is available", async () => {
    const result = await store.upload("instagram/acme/post_1/slide-1.png", Buffer.from("fake-png-bytes"), { contentType: "image/png" });

    expect(result.objectPath).toBe("instagram/acme/post_1/slide-1.png");
    expect(result.gcsUri).toBe("gs://karoscmo-prep-media-assets/instagram/acme/post_1/slide-1.png");
    expect(result.signedUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//);
  });

  it("falls back to gcsUri only, without throwing, when the file can't sign a URL", async () => {
    const unsignableBucket = new FakeGcsBucket(false);
    const unsignableStore = new GcsArtifactStore(unsignableBucket, "karoscmo-prep-media-assets");

    const result = await unsignableStore.upload("branded-shorts/acme/run_1/final.mp4", Buffer.from("fake-mp4-bytes"));

    expect(result.gcsUri).toBe("gs://karoscmo-prep-media-assets/branded-shorts/acme/run_1/final.mp4");
    expect(result.signedUrl).toBeUndefined();
  });

  it("falls back to gcsUri only when the bucket's file has no getSignedUrl method at all", async () => {
    const noSignBucket: GcsBucketLike = {
      file(objectPath) {
        const objects = new Map<string, Buffer>();
        return {
          name: objectPath,
          async exists() {
            return [objects.has(objectPath)];
          },
          async download() {
            return [objects.get(objectPath)!];
          },
          async save(data: string | Buffer) {
            objects.set(objectPath, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
          },
          // no getSignedUrl at all
        };
      },
      async getFiles() {
        return [[]];
      },
    };
    const result = await new GcsArtifactStore(noSignBucket, "b").upload("x.png", Buffer.from("x"));
    expect(result.signedUrl).toBeUndefined();
    expect(result.gcsUri).toBe("gs://b/x.png");
  });

  it("round-trips a downloaded buffer", async () => {
    await store.upload("run_1/transcript.json", Buffer.from('{"hello":"world"}'));
    const buf = await store.download("run_1/transcript.json");
    expect(JSON.parse(buf.toString("utf8"))).toEqual({ hello: "world" });
  });

  it("exists() reflects whether the object was ever uploaded", async () => {
    expect(await store.exists("nope.png")).toBe(false);
    await store.upload("nope.png", Buffer.from("now it exists"));
    expect(await store.exists("nope.png")).toBe(true);
  });

  it("wraps an upload failure with a clear, actionable error naming the bucket and object", async () => {
    const failingBucket: GcsBucketLike = {
      file(objectPath) {
        return {
          name: objectPath,
          async exists() {
            return [false];
          },
          async download() {
            throw new Error("not found");
          },
          async save() {
            throw new Error("403 Forbidden: caller does not have storage.objects.create access");
          },
        };
      },
      async getFiles() {
        return [[]];
      },
    };
    const failingStore = new GcsArtifactStore(failingBucket, "karoscmo-prep-media-assets");

    await expect(failingStore.upload("x.png", Buffer.from("x"))).rejects.toThrow(/karoscmo-prep-media-assets\/x\.png/);
    await expect(failingStore.upload("x.png", Buffer.from("x"))).rejects.toThrow(/storage\.objects\.create/);
  });

  it("does not attempt to create a missing bucket — a download failure surfaces as a clear error instead of silent recovery", async () => {
    const missingBucket: GcsBucketLike = {
      file(objectPath) {
        return {
          name: objectPath,
          async exists() {
            return [false];
          },
          async download() {
            throw new Error("404 Not Found: bucket does not exist");
          },
          async save() {},
        };
      },
      async getFiles() {
        return [[]];
      },
    };
    const missingStore = new GcsArtifactStore(missingBucket, "karoscmo-prep-agent-artifacts");
    await expect(missingStore.download("runs/run_1/transcript.json").catch((e) => e.message)).resolves.toMatch(/storage\.objects\.get/);
  });
});

describe("createArtifactStoreFromEnv", () => {
  it("returns undefined when the named env var is unset — callers must treat this as 'skip GCS'", () => {
    expect(createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", { env: {} })).toBeUndefined();
  });

  it("throws when the env var is set but no gcsBucketFactory was provided", () => {
    expect(() => createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", { env: { GCS_MEDIA_BUCKET: "karoscmo-prep-media-assets" } })).toThrow(/gcsBucketFactory/);
  });

  it("constructs a GcsArtifactStore, passing the configured bucket name to the factory", () => {
    const gcsBucketFactory = vi.fn(() => new FakeGcsBucket());
    const store = createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", { env: { GCS_MEDIA_BUCKET: "karoscmo-prep-media-assets" }, gcsBucketFactory });

    expect(store).toBeInstanceOf(GcsArtifactStore);
    expect(store?.bucketName).toBe("karoscmo-prep-media-assets");
    expect(gcsBucketFactory).toHaveBeenCalledWith("karoscmo-prep-media-assets");
  });

  it("reads a different bucket per env var name, independently", () => {
    const mediaStore = createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", {
      env: { GCS_MEDIA_BUCKET: "karoscmo-prep-media-assets", GCS_ARTIFACTS_BUCKET: "karoscmo-prep-agent-artifacts" },
      gcsBucketFactory: () => new FakeGcsBucket(),
    });
    const artifactsStore = createArtifactStoreFromEnv("GCS_ARTIFACTS_BUCKET", {
      env: { GCS_MEDIA_BUCKET: "karoscmo-prep-media-assets", GCS_ARTIFACTS_BUCKET: "karoscmo-prep-agent-artifacts" },
      gcsBucketFactory: () => new FakeGcsBucket(),
    });

    expect(mediaStore?.bucketName).toBe("karoscmo-prep-media-assets");
    expect(artifactsStore?.bucketName).toBe("karoscmo-prep-agent-artifacts");
  });
});
