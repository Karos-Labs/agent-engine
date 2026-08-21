/**
 * The minimal slice of the real `@google-cloud/storage` SDK's API
 * `GcsWorkspaceStore` depends on, expressed as a local interface rather than
 * an import — the same "via dependency injection / interface" discipline
 * `packages/workflow`'s `FirestoreDurableStepStore` already follows for
 * Firestore (no `@google-cloud/storage` dependency added here). A real
 * `Bucket`/`File` instance from `@google-cloud/storage`'s `Storage#bucket()`
 * satisfies this interface structurally: `exists()`/`download()` really do
 * return `[result]` single-element tuples (the library's long-standing
 * callback-to-promise conversion convention), and `getFiles()` returns a
 * longer `[File[], nextQuery, apiResponse]` tuple — hence the `...unknown[]`
 * rest element below, so this interface accepts the real trailing elements
 * without needing to name or care about them.
 */
export interface GcsFileLike {
  /** The full object key within the bucket (e.g. "clients/acme/client/profile.json"). */
  readonly name: string;
  exists(): Promise<[boolean]>;
  download(): Promise<[Buffer]>;
  save(data: string | Buffer, options?: { contentType?: string }): Promise<void>;
  /**
   * V4 signed-URL generation (real `@google-cloud/storage`'s `File#getSignedUrl`).
   * Optional here — not every `GcsFileLike` a caller hands in can sign: signing
   * needs a service-account private key, or the IAM Credentials API's
   * `signBlob` permission on the identity's own service account, neither of
   * which a developer's own `gcloud auth application-default login` user
   * credentials provide. `GcsArtifactStore.upload` treats a missing method,
   * or one that throws, as "can't sign right now" and falls back to the
   * always-available `gs://` URI rather than failing the whole upload.
   */
  getSignedUrl?(options: { action: "read"; expires: number }): Promise<[string]>;
}

export interface GcsBucketLike {
  file(objectPath: string): GcsFileLike;
  getFiles(options: { prefix: string }): Promise<[GcsFileLike[], ...unknown[]]>;
}
