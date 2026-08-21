/**
 * The minimal contract `FirestoreDurableStepStore` needs to offload an
 * oversized step/slot output to GCS (Task 2's dual-storage architecture:
 * operational state in Firestore, heavy raw payloads in GCS) — expressed as
 * a local interface, not an import, for the same "no `@google-cloud/storage`
 * (or any cloud SDK) dependency in this package" reason `FirestoreLike`
 * itself is a local interface in `firestore-types.ts`: Layer 1 depends on
 * narrow contracts its caller satisfies at the composition root, never on a
 * concrete cloud client.
 *
 * `GcsArtifactStore` from `@agent-engine/tool-common` satisfies this
 * structurally (its own `upload()` returns a superset: `{objectPath, gcsUri,
 * signedUrl?}`) — pass one straight through at your wiring layer, no
 * adapter needed.
 */
export interface ArchiveStoreLike {
  upload(objectPath: string, data: Buffer): Promise<{ gcsUri: string }>;
}
