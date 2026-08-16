import type { PromptStore } from "./prompt-store.js";
import type { FirestoreLike } from "./gcp-types.js";

export interface FirestorePromptStoreOptions {
  /**
   * The named Firestore database this store talks to — e.g. `"prep"` vs
   * Firestore's own default, spelled `"(default)"`. Metadata only, exactly
   * like `FirestoreDurableStepStoreOptions.databaseId` in
   * `@agent-engine/workflow`: the injected `db` is already bound to the
   * right physical database by whoever constructed it (typically
   * `getFirestore(app, databaseId)` from `firebase-admin`), so this class
   * never folds `databaseId` into a document path — it exists purely so
   * error messages can say which database a lookup was actually against.
   */
  databaseId?: string;
}

/**
 * The Firestore-backed `PromptStore`: a `prompts/{promptId}` doc holding
 * `{ latestVersion: string }`, and a flat `promptVersions/{promptId}@{version}`
 * doc per version holding `{ content: string }`. Two collections rather than
 * one nested subcollection so "what's latest" is a single cheap doc read,
 * independent of how many versions a prompt has accumulated.
 */
export class FirestorePromptStore implements PromptStore {
  /** `"(default)"` when no named database was supplied — Firestore's own name for its default database. */
  readonly databaseId: string;

  constructor(
    private readonly db: FirestoreLike,
    options: FirestorePromptStoreOptions = {},
  ) {
    this.databaseId = options.databaseId ?? "(default)";
  }

  private promptsCollection() {
    return this.db.collection("prompts");
  }

  private promptVersionsCollection() {
    return this.db.collection("promptVersions");
  }

  async getPrompt(promptId: string, version?: string): Promise<string> {
    const resolvedVersion = version ?? (await this.resolveLatestVersion(promptId));
    const docId = `${promptId}@${resolvedVersion}`;
    const snap = await this.promptVersionsCollection().doc(docId).get();
    if (!snap.exists) {
      throw new Error(
        `FirestorePromptStore [database="${this.databaseId}"]: no prompt version found for "${docId}"`,
      );
    }
    const content = snap.data()?.["content"];
    if (typeof content !== "string") {
      throw new Error(
        `FirestorePromptStore [database="${this.databaseId}"]: promptVersions/${docId} is missing a string "content" field`,
      );
    }
    return content;
  }

  private async resolveLatestVersion(promptId: string): Promise<string> {
    const snap = await this.promptsCollection().doc(promptId).get();
    if (!snap.exists) {
      throw new Error(
        `FirestorePromptStore [database="${this.databaseId}"]: no prompt registered for id "${promptId}" (prompts/${promptId} does not exist)`,
      );
    }
    const latestVersion = snap.data()?.["latestVersion"];
    if (typeof latestVersion !== "string") {
      throw new Error(
        `FirestorePromptStore [database="${this.databaseId}"]: prompts/${promptId} is missing a string "latestVersion" field`,
      );
    }
    return latestVersion;
  }
}
