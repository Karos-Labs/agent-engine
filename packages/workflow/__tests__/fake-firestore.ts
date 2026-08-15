import type {
  FirestoreCollectionRef,
  FirestoreDocumentRef,
  FirestoreDocumentSnapshot,
  FirestoreLike,
  FirestoreQuerySnapshot,
} from "../src/adapters/firestore/index.js";

/**
 * A minimal in-memory double for `FirestoreLike`, used only to verify
 * `FirestoreDurableStepStore`'s own logic (path construction, merge
 * semantics, exists-checking) without a real GCP project. Not shipped in
 * `src/` — test-only.
 */
class FakeDoc implements FirestoreDocumentRef {
  private data: Record<string, unknown> | undefined;
  private readonly subcollections = new Map<string, FakeCollection>();

  async get(): Promise<FirestoreDocumentSnapshot> {
    const data = this.data;
    return { exists: data !== undefined, data: () => data };
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown> {
    this.data = options?.merge && this.data ? { ...this.data, ...data } : { ...data };
    return undefined;
  }

  collection(name: string): FirestoreCollectionRef {
    let col = this.subcollections.get(name);
    if (!col) {
      col = new FakeCollection();
      this.subcollections.set(name, col);
    }
    return col;
  }
}

class FakeCollection implements FirestoreCollectionRef {
  private readonly docs = new Map<string, FakeDoc>();

  doc(id: string): FirestoreDocumentRef {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new FakeDoc();
      this.docs.set(id, doc);
    }
    return doc;
  }

  async get(): Promise<FirestoreQuerySnapshot> {
    const entries = [...this.docs.entries()];
    const snaps = await Promise.all(
      entries.map(async ([id, doc]) => ({ id, snap: await doc.get() })),
    );
    const docs = snaps.filter(({ snap }) => snap.exists).map(({ id, snap }) => ({ id, data: () => snap.data() ?? {} }));
    return { docs };
  }
}

export class FakeFirestore implements FirestoreLike {
  private readonly collections = new Map<string, FakeCollection>();

  collection(path: string): FirestoreCollectionRef {
    let col = this.collections.get(path);
    if (!col) {
      col = new FakeCollection();
      this.collections.set(path, col);
    }
    return col;
  }
}
