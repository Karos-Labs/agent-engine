import {
  TemplateDefinitionSchema,
  TemplateStoreError,
  type TemplateDefinition,
  type TemplateQuery,
  type TemplateStore,
} from "./types.js";
import { matchesQuery } from "./memory-store.js";

/**
 * The slice of Firestore this store uses, declared structurally so the
 * package takes no dependency on `firebase-admin`.
 *
 * Mirrors how `FirestoreDurableStepStore` is wired from
 * `apps/agent-server/src/wiring/`: the composition root owns the SDK, the
 * package owns the behaviour. It also means the whole store is testable with
 * a plain object, which is how `__tests__` exercises it.
 */
export interface FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
    };
    get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }>;
  };
}

export const TEMPLATES_COLLECTION = "slideTemplates";

/**
 * Firestore-backed template registry.
 *
 * Whole documents, not GCS blobs: an HTML template plus its CSS is a few KB
 * against Firestore's ~1 MB document ceiling, so the indirection of a bucket
 * would buy nothing but a second failure mode and a second set of
 * credentials. GCS remains the right home for BINARY template assets (a
 * bundled font, a background texture) and this store deliberately does not
 * model those yet rather than half-modelling them.
 *
 * Reads are unfiltered-then-filtered in memory. That is a real choice and it
 * is only correct at this scale: the registry holds tens of rows, not
 * thousands, and a compound Firestore query over
 * `(clientSlug, archetypeId, enabled)` would need a composite index per
 * combination for a collection small enough to fetch whole. If this ever
 * grows past a few hundred templates, the query moves server-side and the
 * index comes with it.
 */
export function createFirestoreTemplateStore(db: FirestoreLike, collectionName: string = TEMPLATES_COLLECTION): TemplateStore {
  const col = () => db.collection(collectionName);

  function parse(id: string, raw: Record<string, unknown> | undefined): TemplateDefinition | undefined {
    if (!raw) return undefined;
    const parsed = TemplateDefinitionSchema.safeParse({ ...raw, id });
    // A row that no longer matches the schema is SKIPPED, not thrown on. One
    // malformed document (a hand-edit in the console, a half-finished
    // migration) must not take every other template down with it — the
    // rendering pipeline degrades per-archetype and can survive losing one.
    return parsed.success ? parsed.data : undefined;
  }

  return {
    name: "firestore",

    async list(query?: TemplateQuery) {
      let snapshot: Awaited<ReturnType<ReturnType<FirestoreLike["collection"]>["get"]>>;
      try {
        snapshot = await col().get();
      } catch (error) {
        throw new TemplateStoreError(`firestore template list failed: ${(error as Error).message}`);
      }
      return snapshot.docs
        .map((d) => parse(d.id, d.data()))
        .filter((r): r is TemplateDefinition => r !== undefined)
        .filter((r) => matchesQuery(r, query));
    },

    async get(id: string) {
      try {
        const doc = await col().doc(id).get();
        return doc.exists ? parse(id, doc.data()) : undefined;
      } catch (error) {
        throw new TemplateStoreError(`firestore template get("${id}") failed: ${(error as Error).message}`);
      }
    },

    async save(definition: TemplateDefinition) {
      const row = TemplateDefinitionSchema.parse(definition);
      // `id` is the document key, so storing it in the body too would be two
      // copies of one fact that can disagree after a rename.
      const { id, ...body } = row;
      try {
        await col().doc(id).set(body, { merge: true });
      } catch (error) {
        throw new TemplateStoreError(`firestore template save("${id}") failed: ${(error as Error).message}`);
      }
    },

    async recordFeedback(id: string, entry: TemplateDefinition["feedback"][number], qualityDelta: number) {
      const existing = await this.get(id);
      if (!existing) throw new TemplateStoreError(`no template with id "${id}"`);
      // Read-modify-write rather than an atomic arrayUnion/increment, which
      // this narrowed `FirestoreLike` deliberately does not expose. Two
      // reviewers commenting on the same template within the same instant
      // could lose one note. Acceptable here and stated rather than hidden:
      // feedback arrives at human pace, one reviewer per run, and buying
      // atomicity would mean depending on the real SDK's FieldValue and
      // giving up the plain-object testability this interface exists for.
      await this.save({
        ...existing,
        feedback: [...existing.feedback, entry],
        qualityScore: Math.max(0, Math.min(100, existing.qualityScore + qualityDelta)),
        updatedAt: entry.at,
      });
    },
  };
}
