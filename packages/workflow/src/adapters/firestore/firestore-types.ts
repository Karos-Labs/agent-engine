/**
 * The minimal slice of the real Firestore Admin SDK's API this adapter
 * depends on, expressed as a local interface rather than an import — this is
 * "via dependency injection / interface" (no `firebase-admin`/
 * `@google-cloud/firestore` dependency added here). A real `Firestore`
 * instance from `firebase-admin`'s `getFirestore()` satisfies this interface
 * structurally: `db.collection(...).doc(...).set(data, {merge:true})` is
 * exactly this shape, so production wiring is passing the real client
 * straight in, not writing a shim.
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
