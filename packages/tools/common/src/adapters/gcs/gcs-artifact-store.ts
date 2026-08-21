import type { GcsBucketLike } from "./gcs-types.js";

/** How long a generated signed URL stays valid for, when signing is available at all. */
const DEFAULT_SIGNED_URL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — V4 signing's own maximum

export interface ArtifactUploadResult {
  /** The object key within the bucket, e.g. "instagram/acme/post_1/slide-1.png". */
  objectPath: string;
  /** `gs://<bucket>/<objectPath>` — always populated, needs no signing, never expires. The reference to persist for the long term (a Firestore step doc, the deliverable ledger). */
  gcsUri: string;
  /**
   * A time-limited `https://` URL a browser/client can fetch directly,
   * when the runtime credentials could actually sign one (see
   * `GcsFileLike.getSignedUrl`'s doc comment) — `undefined` otherwise.
   * Callers that need a URL right now and can tolerate it expiring should
   * prefer this; callers that need a durable reference should use `gcsUri`.
   */
  signedUrl?: string;
}

/**
 * The narrow contract a `karos-*` tool depends on for "upload this artifact
 * to GCS" — the media/artifact-store counterpart to `WorkspaceStoreLike`
 * (RFC-01 §9.2's "narrow contract every tool actually depends on," applied
 * to binary media/build output instead of JSON records). Optional
 * everywhere a tool factory takes one: a tool with no configured bucket
 * keeps its previous local-only behavior untouched (Task 3's "mock/local
 * fallbacks remain functional").
 */
export interface GcsArtifactStoreLike {
  readonly bucketName: string;
  upload(objectPath: string, data: Buffer, options?: { contentType?: string }): Promise<ArtifactUploadResult>;
  download(objectPath: string): Promise<Buffer>;
  exists(objectPath: string): Promise<boolean>;
}

/**
 * The real `GcsArtifactStoreLike` (RFC-01 §16.3's ADC-everywhere rule,
 * applied to media/build artifacts): rendered carousel PNGs (karos-publish),
 * encoded MP4s (karos-video), and archived oversized step transcripts
 * (`packages/workflow`'s `FirestoreDurableStepStore`) all upload through
 * this one class, backed by a `GcsBucketLike` constructed at the caller's
 * composition root — never by importing `@google-cloud/storage` in this
 * package (see `gcs-types.ts`'s own doc comment; a real `Storage().bucket()`
 * satisfies `GcsBucketLike` structurally).
 *
 * Deliberately does NOT attempt to create the bucket if it's missing, or to
 * repair a permissions problem — provisioning a GCS bucket is an
 * infrastructure decision (location, storage class, IAM, retention), not a
 * side effect an application should take on its first failed write. A
 * missing bucket or a permissions error surfaces as a clear, actionable
 * thrown error naming the bucket instead (Task 3's "handles ... permissions
 * gracefully" — gracefully means *legibly*, not *silently self-healing*).
 */
export class GcsArtifactStore implements GcsArtifactStoreLike {
  constructor(
    private readonly bucket: GcsBucketLike,
    public readonly bucketName: string,
    private readonly options: { signedUrlExpiryMs?: number } = {},
  ) {}

  async exists(objectPath: string): Promise<boolean> {
    const [exists] = await this.bucket.file(objectPath).exists();
    return exists;
  }

  async download(objectPath: string): Promise<Buffer> {
    const file = this.bucket.file(objectPath);
    try {
      const [buf] = await file.download();
      return buf;
    } catch (err) {
      throw new Error(
        `GcsArtifactStore: failed to download "gs://${this.bucketName}/${objectPath}" — confirm the bucket exists and this identity has storage.objects.get on it. Original error: ${describeGcsError(err)}`,
      );
    }
  }

  async upload(objectPath: string, data: Buffer, options?: { contentType?: string }): Promise<ArtifactUploadResult> {
    const file = this.bucket.file(objectPath);
    try {
      await file.save(data, options);
    } catch (err) {
      throw new Error(
        `GcsArtifactStore: failed to upload "gs://${this.bucketName}/${objectPath}" — confirm the bucket exists and this identity has storage.objects.create on it. Original error: ${describeGcsError(err)}`,
      );
    }

    const gcsUri = `gs://${this.bucketName}/${objectPath}`;
    let signedUrl: string | undefined;
    if (file.getSignedUrl) {
      try {
        const expires = Date.now() + (this.options.signedUrlExpiryMs ?? DEFAULT_SIGNED_URL_EXPIRY_MS);
        [signedUrl] = await file.getSignedUrl({ action: "read", expires });
      } catch {
        // Signing needs a service-account private key or IAM signBlob permission (see
        // `GcsFileLike.getSignedUrl`'s doc comment) — absent locally, present on Cloud Run's
        // attached service account. Callers fall back to `gcsUri`, which always works.
      }
    }

    return { objectPath, gcsUri, ...(signedUrl ? { signedUrl } : {}) };
  }
}

function describeGcsError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
