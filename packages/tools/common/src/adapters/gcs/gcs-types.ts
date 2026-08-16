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
  save(data: string, options?: { contentType?: string }): Promise<void>;
}

export interface GcsBucketLike {
  file(objectPath: string): GcsFileLike;
  getFiles(options: { prefix: string }): Promise<[GcsFileLike[], ...unknown[]]>;
}
