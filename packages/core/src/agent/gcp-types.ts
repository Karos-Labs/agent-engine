/**
 * The minimal slice of the real Firestore Admin SDK's API this adapter
 * depends on, expressed as a local interface rather than an import — the
 * same "via dependency injection / interface" discipline
 * `packages/workflow`'s `FirestoreDurableStepStore` already follows (no
 * `firebase-admin`/`@google-cloud/firestore` dependency added here). A real
 * `Firestore` instance from `firebase-admin`'s `getFirestore()` satisfies
 * this interface structurally, so production wiring passes the real client
 * straight in rather than writing a shim.
 *
 * Duplicated (not imported) from `@agent-engine/workflow`'s identical
 * interface, for the same reason `describeError` is duplicated rather than
 * imported from `@agent-engine/telemetry` (see `./errors.ts`): `packages/core`
 * is a lower layer than `packages/workflow` and stays dependency-free of it.
 */
export interface FirestoreDocumentSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreDocumentRef {
  get(): Promise<FirestoreDocumentSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  collection(name: string): FirestoreCollectionRef;
}

export interface FirestoreQuerySnapshot {
  docs: Array<{ id: string; data(): Record<string, unknown> }>;
}

export interface FirestoreCollectionRef {
  doc(id: string): FirestoreDocumentRef;
  get(): Promise<FirestoreQuerySnapshot>;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionRef;
}

/**
 * The minimal client shape `VertexAIPromptStore` depends on — deliberately
 * abstract rather than a wrapper around a specific Google Cloud/Vertex AI
 * SDK class. Vertex AI's prompt-management surface (exposed today through
 * Vertex AI Studio and various preview SDK entry points) is still evolving,
 * and this codebase's own convention (see `FirestoreLike` above) is to
 * depend on the narrowest structural interface a call site actually needs,
 * not on a specific third-party package version. Whoever wires this up in
 * production adapts whatever the current Vertex AI SDK/REST surface looks
 * like into this one method — `VertexAIPromptStore` itself only ever calls
 * `getPromptVersion`, never anything SDK-specific.
 */
export interface VertexAIPromptClient {
  /** Fetches one prompt's resolved template text. `version` omitted means the client's own notion of "latest". */
  getPromptVersion(promptId: string, version?: string): Promise<string>;
}
