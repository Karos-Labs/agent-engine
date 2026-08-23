import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput, type ModelRouter } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * Topic guardrails on the dynamic runner.
 *
 * The contract these pin is not "the guardrail works" but "the guardrail
 * cannot be avoided". In the system this was ported from, the check lives
 * outside `spec.steps` precisely because a step an admin can delete with a
 * bin icon is a convention rather than a guarantee — so the tests that matter
 * are the ones proving a definition which never mentions a guardrail still
 * gets one.
 */

/** A definition with NO guardrail stage — the normal case, and the point. */
function draftingAgent(agentId: string): AgentDefinitionInput {
  return {
    agentId,
    name: "Drafting Agent",
    description: "Produces one short draft; defines no guardrail stage of its own",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        id: "draft",
        description: "produce a draft",
        systemPrompt: "You write short drafts.",
        allowedTools: [],
        outputSchema: [{ name: "text", type: "string", optional: false }],
      },
    ],
  };
}


describe("dynamic runner topic guardrails", () => {
  let env: TestEnvironment;
  let store: MemoryAgentDefinitionStore;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    store = new MemoryAgentDefinitionStore();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /** Puts a client's forbidden-topic list where `client.getConfig` reads it. */
  async function setForbiddenTopics(topics: string[]): Promise<void> {
    await env.store.writeJson("acme", ["client", "config"], { forbiddenTopics: topics });
  }

  it("runs the verifier on a definition that never declares one", async () => {
    await setForbiddenTopics(["cryptocurrency"]);
    await store.upsert("drafter", draftingAgent("drafter"), { expectExisting: false });

    // Stage output, then the appended verifier's own turn.
    const router = smartFakeRouter([{ text: "a clean draft about coffee" }, { violatedTopics: [] }]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "drafter", runKind: "recurring" },
      "run-guard-1",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore: store },
    );

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    const stepIds = (await env.durableStore.listSteps(outcome.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("guardrail-verify");
  });

  it("fails the run when the draft engages with a forbidden topic", async () => {
    await setForbiddenTopics(["cryptocurrency"]);
    await store.upsert("drafter", draftingAgent("drafter"), { expectExisting: false });

    const router = smartFakeRouter([
      { text: "why you should buy crypto today" },
      { violatedTopics: ["cryptocurrency"], evidence: "why you should buy crypto today" },
    ]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "drafter", runKind: "recurring" },
      "run-guard-2",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore: store },
    );

    // Not "held": held means nothing honestly cleared the gates, a legitimate
    // empty result. This output exists and must not ship.
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).not.toBe("completed");
    const run = await env.durableStore.getRun(outcome.runId);
    expect(run?.status).not.toBe("held");
    expect(String(run?.failureReason)).toMatch(/guardrail/i);
    expect(String(run?.failureReason)).toMatch(/cryptocurrency/);
  });

  it("skips the check when the client forbids nothing, rather than failing", async () => {
    // The common case. A client with no forbidden topics has nothing to check
    // against, and treating that as a misconfiguration would block every run.
    await env.store.writeJson("acme", ["client", "config"], {});
    await store.upsert("drafter", draftingAgent("drafter"), { expectExisting: false });

    const router = smartFakeRouter([{ text: "a draft" }]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "drafter", runKind: "recurring" },
      "run-guard-3",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore: store },
    );

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    const stepIds = (await env.durableStore.listSteps(outcome.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("guardrail-verify");
  });

  it("does not block good output when the verifier itself fails", async () => {
    // Fail open, loudly. A verifier that cannot do its job must not
    // manufacture findings — but the run records that the check did not run,
    // so nobody sees a green tick it did not earn.
    await setForbiddenTopics(["cryptocurrency"]);
    await store.upsert("drafter", draftingAgent("drafter"), { expectExisting: false });

    // Second turn returns a shape the verifier's schema rejects.
    const router = smartFakeRouter([{ text: "a clean draft" }, { nonsense: true }]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "drafter", runKind: "recurring" },
      "run-guard-4",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore: store },
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    const run = await env.durableStore.getRun(outcome.runId);
    expect(String(run?.failureReason ?? "")).not.toMatch(/guardrail: draft engaged/i);
  });

  it("ignores a topic the client never forbade", async () => {
    // The model is told to copy the list verbatim; honouring an invented topic
    // would block a run over something nobody forbade.
    await setForbiddenTopics(["cryptocurrency"]);
    await store.upsert("drafter", draftingAgent("drafter"), { expectExisting: false });

    const router = smartFakeRouter([
      { text: "a draft about coffee" },
      { violatedTopics: ["something the client never listed"] },
    ]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "drafter", runKind: "recurring" },
      "run-guard-5",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore: store },
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
  });
});

/**
 * A router that records every prompt it is asked to complete.
 *
 * `smartFakeRouter` cannot observe what a stage was handed, and the thing
 * worth checking is not that `wf.step.agent` was called with the right object
 * but that the object reached the model.
 */
function capturingRouter(candidates: readonly unknown[]): { router: ModelRouter; prompts: string[] } {
  const prompts: string[] = [];
  const inner = smartFakeRouter(candidates);
  const router: ModelRouter = {
    async complete(prompt, schema, policy) {
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      return inner.complete(prompt, schema, policy);
    },
    completeAlias: inner.completeAlias.bind(inner),
  } as ModelRouter;
  return { router, prompts };
}

describe("dynamic runner variable passing", () => {
  let env2: TestEnvironment;
  let store2: MemoryAgentDefinitionStore;

  beforeEach(async () => {
    env2 = await setupTestEnvironment();
    store2 = new MemoryAgentDefinitionStore();
  });

  afterEach(async () => {
    await env2.cleanup();
  });

  function twoStage(agentId: string): AgentDefinitionInput {
    return {
      agentId,
      name: "Two Stage",
      description: "Two sequential stages, used to check what each one is handed",
      defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      stages: [
        {
          id: "first",
          description: "first",
          allowedTools: [],
          outputSchema: [{ name: "headline", type: "string", optional: false }],
        },
        {
          id: "second",
          description: "second",
          allowedTools: [],
          outputSchema: [{ name: "score", type: "number", optional: false }],
        },
      ],
    };
  }

  it("hands the first stage what the person actually typed", async () => {
    // It used to receive `{}`, so an agent with an input schema was answering
    // a question it could not see.
    await store2.upsert("var-pass", twoStage("var-pass"), { expectExisting: false });
    const { router, prompts } = capturingRouter([{ headline: "h" }, { score: 1 }]);

    await startRunJob(
      { clientSlug: "acme", productId: "var-pass", runKind: "recurring", input: { topic: "cold brew" } },
      "run-var-1",
      { durableStore: env2.durableStore, runtimeDeps: { ...env2.runtimeDeps, router }, agentDefinitionStore: store2 },
    );

    // Asserted on the prompt, not on the call arguments: what matters is that
    // the value reached the MODEL, and a step invoked with the right object
    // that never serialised it would pass a weaker check.
    expect(prompts[0]).toContain("cold brew");
    expect(prompts[0]).toContain("previousOutput");
  });

  it("gives a later stage both the run input and the stage before it", async () => {
    // Named fields rather than one merged object: a stage output key must not
    // be able to shadow a form field of the same name.
    await store2.upsert("var-pass", twoStage("var-pass"), { expectExisting: false });
    const { router, prompts } = capturingRouter([{ headline: "Big News" }, { score: 9 }]);

    await startRunJob(
      { clientSlug: "acme", productId: "var-pass", runKind: "recurring", input: { topic: "cold brew" } },
      "run-var-2",
      { durableStore: env2.durableStore, runtimeDeps: { ...env2.runtimeDeps, router }, agentDefinitionStore: store2 },
    );

    expect(prompts[1]).toContain("cold brew");
    expect(prompts[1]).toContain("Big News");
  });
});
