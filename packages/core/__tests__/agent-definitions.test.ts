import { describe, expect, it, vi } from "vitest";
import {
  DynamicAgent,
  MemoryAgentDefinitionStore,
  FirestoreAgentDefinitionStore,
  buildOutputSchema,
  AgentDefinitionFieldSchema,
  type AgentContext,
  type AgentDefinitionInput,
  type BaseAgentRuntime,
  type CompletionResult,
  type FirestoreLike,
  type ModelRouter,
} from "../src/index.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "custom-agent-1", runKind: "recurring", metadata: {} };

function fakeRouter(turn: CompletionResult<unknown>): ModelRouter {
  return {
    complete: vi.fn(async () => turn),
    completeAlias: vi.fn(async () => {
      throw new Error("not used");
    }),
  } as unknown as ModelRouter;
}

describe("buildOutputSchema", () => {
  it("builds a Zod object schema from a flat field-list DSL", () => {
    const fields = [
      AgentDefinitionFieldSchema.parse({ name: "headline", type: "string" }),
      AgentDefinitionFieldSchema.parse({ name: "score", type: "number" }),
      AgentDefinitionFieldSchema.parse({ name: "flagged", type: "boolean", optional: true }),
      AgentDefinitionFieldSchema.parse({ name: "tags", type: "string[]" }),
    ];
    const schema = buildOutputSchema(fields);
    expect(schema.safeParse({ headline: "hi", score: 3, tags: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ headline: "hi", score: 3 }).success).toBe(false); // missing required "tags"
    expect(schema.safeParse({ headline: "hi", score: "not a number", tags: [] }).success).toBe(false);
  });

  it("an optional field may be omitted", () => {
    const schema = buildOutputSchema([AgentDefinitionFieldSchema.parse({ name: "note", type: "string", optional: true })]);
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("DynamicAgent", () => {
  it("uses the constructor-supplied system prompt directly, never a skillRef/PromptStore lookup", async () => {
    const outputSchema = buildOutputSchema([AgentDefinitionFieldSchema.parse({ name: "result", type: "string" })]);
    const router = fakeRouter({
      output: { type: "final", output: { result: "done" } },
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: 0, uncached: 10 },
      outputTokens: 5,
    });
    const promptStoreGetPrompt = vi.fn();
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore: { getPrompt: promptStoreGetPrompt } };

    const agent = new DynamicAgent(
      runtime,
      { id: "stage-1", description: "test stage", allowedTools: [], outputSchema, modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" } },
      "You are a helpful stage.",
    );
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ result: "done" });
    expect(promptStoreGetPrompt).not.toHaveBeenCalled();
    expect(router.complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ system: "You are a helpful stage." }));
  });

  it("runs with no system prompt at all when the stage defines none", async () => {
    const outputSchema = buildOutputSchema([AgentDefinitionFieldSchema.parse({ name: "result", type: "string" })]);
    const router = fakeRouter({
      output: { type: "final", output: { result: "ok" } },
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: 0, uncached: 10 },
      outputTokens: 5,
    });
    const agent = new DynamicAgent(
      { router, tools: {} },
      { id: "stage-1", description: "test", allowedTools: [], outputSchema, modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" } },
    );
    const result = await agent.run(ctx, {});
    expect(result.status).toBe("completed");
  });
});

function validInput(agentId: string): AgentDefinitionInput {
  return {
    agentId,
    name: "Test Agent",
    description: "A test dynamic agent",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        id: "stage-1",
        description: "first stage",
        allowedTools: [],
        outputSchema: [{ name: "result", type: "string", optional: false }],
      },
    ],
  };
}

describe("MemoryAgentDefinitionStore", () => {
  it("creates on first upsert (expectExisting:false), stamping version 1", async () => {
    const store = new MemoryAgentDefinitionStore(() => 1000);
    const result = await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    expect(result).toMatchObject({ outcome: "created", definition: { version: 1, createdAt: 1000, updatedAt: 1000 } });
  });

  it("rejects a create for an id that already exists", async () => {
    const store = new MemoryAgentDefinitionStore();
    await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    const result = await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    expect(result).toEqual({ outcome: "already_exists" });
  });

  it("rejects an update (expectExisting:true) for an id that doesn't exist", async () => {
    const store = new MemoryAgentDefinitionStore();
    const result = await store.upsert("nope", validInput("nope"), { expectExisting: true });
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("update bumps version and preserves createdAt", async () => {
    let now = 1000;
    const store = new MemoryAgentDefinitionStore(() => now);
    await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    now = 2000;
    const result = await store.upsert("agent-1", validInput("agent-1"), { expectExisting: true });
    expect(result).toMatchObject({ outcome: "updated", definition: { version: 2, createdAt: 1000, updatedAt: 2000 } });
  });

  it("list() returns every stored definition, get() a specific one", async () => {
    const store = new MemoryAgentDefinitionStore();
    await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    await store.upsert("agent-2", validInput("agent-2"), { expectExisting: false });
    expect((await store.list()).map((d) => d.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    expect((await store.get("agent-1"))?.agentId).toBe("agent-1");
    expect(await store.get("nope")).toBeUndefined();
  });
});

function fakeFirestore(): FirestoreLike {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const self = {
    collection(path: string) {
      let docs = collections.get(path);
      if (!docs) {
        docs = new Map();
        collections.set(path, docs);
      }
      return {
        doc(id: string) {
          return {
            async get() {
              const data = docs!.get(id);
              return { exists: data !== undefined, data: () => data };
            },
            async set(data: Record<string, unknown>) {
              docs!.set(id, data);
            },
            collection: self.collection,
          };
        },
        async get() {
          return { docs: [...docs!.entries()].map(([id, data]) => ({ id, data: () => data })) };
        },
      };
    },
  };
  return self as FirestoreLike;
}

describe("FirestoreAgentDefinitionStore", () => {
  it("round-trips through the agentDefinitions collection", async () => {
    const store = new FirestoreAgentDefinitionStore(fakeFirestore(), () => 5000);
    const created = await store.upsert("agent-1", validInput("agent-1"), { expectExisting: false });
    expect(created).toMatchObject({ outcome: "created", definition: { version: 1 } });

    const fetched = await store.get("agent-1");
    expect(fetched?.name).toBe("Test Agent");

    const updated = await store.upsert("agent-1", validInput("agent-1"), { expectExisting: true });
    expect(updated).toMatchObject({ outcome: "updated", definition: { version: 2 } });
  });

  it("same create/update guard semantics as the memory store", async () => {
    const store = new FirestoreAgentDefinitionStore(fakeFirestore());
    expect(await store.upsert("x", validInput("x"), { expectExisting: true })).toEqual({ outcome: "not_found" });
    await store.upsert("x", validInput("x"), { expectExisting: false });
    expect(await store.upsert("x", validInput("x"), { expectExisting: false })).toEqual({ outcome: "already_exists" });
  });
});
