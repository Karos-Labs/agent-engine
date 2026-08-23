import type { FirestoreLike } from "../agent/gcp-types.js";
import { AgentDefinitionInputSchema, type AgentDefinition, type AgentDefinitionInput } from "./types.js";

export type AgentDefinitionUpsertResult =
  | { outcome: "created" | "updated"; definition: AgentDefinition }
  | { outcome: "not_found" }
  | { outcome: "already_exists" };

/**
 * The store every dynamic-agent route (`apps/agent-server/src/routes/
 * agents.ts`) and the dynamic dispatch path
 * (`wiring/dynamic-workflows.ts`) depend on — the `AgentDefinition`
 * counterpart to `@agent-engine/workflow`'s `DurableStepStore` (RFC-01
 * §8.4's "swap the adapter, not the caller" principle, applied here).
 */
export interface AgentDefinitionStore {
  get(agentId: string): Promise<AgentDefinition | undefined>;
  list(): Promise<AgentDefinition[]>;
  /**
   * `expectExisting: false` is a create (fails `already_exists` if the id
   * is taken); `expectExisting: true` is an update (fails `not_found`
   * otherwise) — one method for both `POST /api/agents` and
   * `PUT /api/agents/:agentId`, so create-vs-update can never define the
   * same id two different ways.
   */
  upsert(agentId: string, input: AgentDefinitionInput, options: { expectExisting: boolean }): Promise<AgentDefinitionUpsertResult>;
}

function nextDefinition(agentId: string, input: AgentDefinitionInput, existing: AgentDefinition | undefined, now: number): AgentDefinition {
  // Parsed rather than spread as-is: `AgentDefinitionInput` is the authoring
  // shape, where every defaulted field may be absent. This is the one place
  // those defaults are applied, so a definition in the store is always the
  // full shape no matter which caller wrote it — and a malformed one is
  // rejected here instead of being discovered at dispatch time.
  const parsed = AgentDefinitionInputSchema.parse(input);
  return {
    ...parsed,
    agentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  };
}

/** In-memory `AgentDefinitionStore` — tests and local dev, matching `MemoryDurableStepStore`'s own role for run/step/gate state. */
export class MemoryAgentDefinitionStore implements AgentDefinitionStore {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(agentId: string): Promise<AgentDefinition | undefined> {
    return this.definitions.get(agentId);
  }

  async list(): Promise<AgentDefinition[]> {
    return [...this.definitions.values()];
  }

  async upsert(agentId: string, input: AgentDefinitionInput, options: { expectExisting: boolean }): Promise<AgentDefinitionUpsertResult> {
    const existing = this.definitions.get(agentId);
    if (options.expectExisting && !existing) return { outcome: "not_found" };
    if (!options.expectExisting && existing) return { outcome: "already_exists" };
    const definition = nextDefinition(agentId, input, existing, this.now());
    this.definitions.set(agentId, definition);
    return { outcome: existing ? "updated" : "created", definition };
  }
}

export interface FirestoreAgentDefinitionStoreOptions {
  /** Matches `FirestoreDurableStepStoreOptions.databaseId`/`FirestorePromptStoreOptions.databaseId` — metadata only, for error messages; the injected `db` is already bound to the right database. */
  databaseId?: string;
}

/** The Firestore-backed `AgentDefinitionStore` — `agentDefinitions/{agentId}` (Task 2). */
export class FirestoreAgentDefinitionStore implements AgentDefinitionStore {
  readonly databaseId: string;

  constructor(
    private readonly db: FirestoreLike,
    private readonly now: () => number = Date.now,
    options: FirestoreAgentDefinitionStoreOptions = {},
  ) {
    this.databaseId = options.databaseId ?? "(default)";
  }

  private collection() {
    return this.db.collection("agentDefinitions");
  }

  async get(agentId: string): Promise<AgentDefinition | undefined> {
    const snap = await this.collection().doc(agentId).get();
    return snap.exists ? (snap.data() as AgentDefinition) : undefined;
  }

  async list(): Promise<AgentDefinition[]> {
    const snap = await this.collection().get();
    return snap.docs.map((doc) => doc.data() as AgentDefinition);
  }

  async upsert(agentId: string, input: AgentDefinitionInput, options: { expectExisting: boolean }): Promise<AgentDefinitionUpsertResult> {
    const existing = await this.get(agentId);
    if (options.expectExisting && !existing) return { outcome: "not_found" };
    if (!options.expectExisting && existing) return { outcome: "already_exists" };
    const definition = nextDefinition(agentId, input, existing, this.now());
    await this.collection().doc(agentId).set(definition, { merge: false });
    return { outcome: existing ? "updated" : "created", definition };
  }
}
